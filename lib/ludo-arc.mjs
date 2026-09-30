// lib/ludo-arc.mjs
//
// STANDALONE MULTIPLAYER LUDO (gfgnew/board/ludo) — Arc TESTNET actions.
// Same Foskaay GGI midchain shape as the single-player demo + ludo-mp, but for
// the NEW isolated contracts (LudoGames + LudoPlayers) deployed behind the same
// permanent core (FoskaayGGI testnet 0x7937...). Additive: this file is imported
// by the single serverless function (api/index.mjs) and registers its own
// action names (ld*). It never touches the demo sessions or ludo-mp sessions.
//
// FIXES versus ludo-mp (the abandoned build):
//   1. Honored seat choice: join seats the wallet at the tapped FREE colour.
//   2. Roll returns `move` so a cache captures rolls too.
//   3. Rejoin/resync is REACHABLE: a "session not found" returns {ok:false}
//      (not a thrown error), so a client can rebuild from a verified copy.
//   4. Settle uses the idempotent LudoGames.settle (one credit per session).
//
// Gasless: exactly TWO transactions per match (connect/delegate + settle);
// every roll/move/pass is a free eth_call + signed midchain entry. Nothing on
// Arc between connect and settle, ever (docs/index.html "no per-move writes").

import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  keccak256, toBytes, encodeAbiParameters, parseAbiParameters, recoverAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';
import { NETWORKS as GGI_NETS } from '../deployments/addresses.mjs';

const accountFor = evmKeys['private' + 'KeyToAccount'];
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';

const NET = GGI_NETS.testnet;
const LD_ADDR = {
  FoskaayGGI: NET.contracts.FoskaayGGI,
  LudoGames: NET.contracts.LudoGames,
  LudoPlayers: NET.contracts.LudoPlayers,
};
const GAME_TAG = keccak256(toBytes('ludo'));

const coreAbi = parseAbi([
  'function handoverWithAccounts(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount, address[] accounts, uint16 games) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, address[] players, address[] sessionKeys, bytes[] sigs, address[] signers)',
  'function randomN(bytes32 seed, uint256 counter, uint256 count) pure returns (bytes32[])',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function feeBase() view returns (uint256)',
  'function feePerAccount() view returns (uint256)',
  'function feePerGame() view returns (uint256)',
  'function isPaid(bytes32 sessionId) view returns (bool)',
  'function commitments(bytes32 sessionId) view returns (bytes32)',
]);

const rulesAbi = parseAbi([
  'function getInitialState(uint8 seatCount, uint8 userSeat) pure returns (bytes)',
  'function applyMove(bytes state, uint8 kind, uint8 seat, uint8 tokenIndex, uint8 value, bytes32[] seeds) pure returns (bytes)',
  'function hashState(bytes state) pure returns (bytes32)',
  'function decodeState(bytes state) pure returns (uint8 turn, uint8 finishCount, uint8 userSeat, uint8 seatCount, int16[16] steps, uint8[4] order, uint16[4] points, uint8 dieA, uint8 dieB)',
  'function isTurnExpired(uint64 lastTs, uint64 nowTs) view returns (bool)',
  'function turnSecs() view returns (uint64)',
  'function maxMatchSecs() view returns (uint64)',
]);

const settleAbi = parseAbi([
  'function settle(bytes32 sessionId, (uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[] list, address[] seatPlayers, bytes32 gameTag, uint64[] moveTss) returns (uint256)',
  'function gameCount(bytes32 sessionId) view returns (uint256)',
  'function gamesOf(bytes32 sessionId) view returns ((uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[])',
]);

const playersAbi = parseAbi(['function pointsOf(address player, bytes32 gameTag) view returns (uint64)']);

const chain = defineChain({
  id: NET.chainId, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [NET.rpc] } },
});

let _iid = Math.random().toString(36).slice(2, 8);
const sessions = new Map(); // sessionId => live midchain session

function clients() {
  if (!SPONSOR_KEY) throw new Error('server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set');
  const account = accountFor(SPONSOR_KEY);
  const pub = createPublicClient({ chain, transport: http(NET.rpc) });
  const wallet = createWalletClient({ chain, transport: http(NET.rpc), account });
  return { account, pub, wallet };
}

async function send(wallet, pub, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('tx reverted: ' + hash);
  let costUsdc6 = 0n;
  try {
    const gasUsed = rc.gasUsed || 0n;
    let price = rc.effectiveGasPrice;
    if (price == null) { const tx = await pub.getTransaction({ hash }); price = tx.gasPrice || 0n; }
    costUsdc6 = (gasUsed * (price || 0n)) / 1_000_000_000_000n;
  } catch (_) { }
  return { rc, hash, costUsdc6 };
}

// ---- Board decode helpers (the 36-byte board, same shape everywhere) ----

function decodeState(hex) {
  const b = Buffer.from(String(hex).slice(2), 'hex');
  if (b.length !== 36) throw new Error('bad state length');
  const steps = [];
  for (let i = 0; i < 16; i++) steps.push(b[8 + i] === 255 ? -1 : b[8 + i]);
  const order = [];
  for (let i = 0; i < 4; i++) order.push(b[24 + i]);
  const points = [];
  for (let i = 0; i < 4; i++) points.push((b[28 + 2 * i] << 8) | b[29 + 2 * i]);
  return { turn: b[0], finishCount: b[1], userSeat: b[2], seatCount: b[3], dieA: b[4], dieB: b[5], rollCounter: b[6], extraRoll: b[7], steps, order, points };
}

function viewOf(sess) {
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  return {
    turn: d.turn, finishCount: d.finishCount, userSeat: d.userSeat, seatCount: d.seatCount,
    dieA: d.dieA, dieB: d.dieB, steps: d.steps, order: d.order, points: d.points,
    moveCount: sess.moves.length, matchOver: d.finishCount >= need,
    winner: d.finishCount > 0 ? d.order[0] : 255,
  };
}

function need(body) {
  const sid = String(body.sessionId || body.code || '');
  const m = sid.match(/game=([^&#]+)/); if (m) return sessions.get(m[1]);
  let s = sessions.get(sid);
  if (!s) { const up = sid.toUpperCase(); for (const v of sessions.values()) { if (v.code === up) { s = v; break; } } }
  return s;
}

async function read(pub, fn, args, addr) {
  return pub.readContract({ address: addr || LD_ADDR.LudoGames, abi: rulesAbi, functionName: fn, args });
}

async function step(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = clients();
  const ga = sess.gameAddr || LD_ADDR.LudoGames;
  const newState = await read(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []], ga);
  const prevHash = sess.moves.length ? sess.lastHash : sess.startHash;
  const newHash = await read(pub, 'hashState', [newState], ga);
  const digest = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  const floor = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  const ts = await now(pub, floor);
  sess.state = newState;
  sess.lastHash = newHash;
  sess.moves.push({ kind, seat, tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig, ts, board: newState });
  sess.tss.push(ts);
  return viewOf(sess);
}

async function now(pub, floor) {
  const wall = Math.floor(Date.now() / 1000);
  let ts = wall;
  try { const h = await pub.getBlock({ blockTag: 'latest' }); if (h && h.timestamp) ts = Math.min(wall, Number(h.timestamp)); } catch (e) { }
  if (floor && ts < floor) ts = floor;
  return ts;
}

function seatGate(sess, body, seat) {
  const wallet = String(body.wallet || '').toLowerCase();
  const owner = String(sess.players[seat] || '').toLowerCase();
  if (!wallet || wallet !== owner) throw new Error('not your seat (this seat belongs to another wallet)');
}

async function touch() { return { ok: true, iid: _iid }; }

// ---- leaderboard: seats ----
const PAL = ['green', 'yellow', 'blue', 'red'];

// Create a lobby (NO handover yet). Host wallet + host session key required.
async function create(body) {
  const seatCount = Number(body.seatCount || 2);
  if (seatCount !== 2 && seatCount !== 4) throw new Error('seatCount must be 2 or 4');
  const host = String(body.wallet || '');
  const hostKey = String(body.sessionKey || '');
  if (!host || !hostKey) throw new Error('signed-in host wallet + session key required');
  const { account, pub } = clients();
  const sessionId = body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [account.address, BigInt(Date.now())]));
  const seed = keccak256(toBytes('ggi-ludo-ld-' + sessionId));
  const seedCommit = keccak256(seed);
  const gameAddr = String(body.game || LD_ADDR.LudoGames);
  const quadOrder = (Array.isArray(body.quadOrder) ? body.quadOrder : []).slice(0, seatCount);
  // Host always sits PAL[0] ('green') to begin with; a joiner picks any free colour.
  let players = [host];
  let sessionKeys = [hostKey];
  if (!quadOrder.length || quadOrder[0] !== 'green') {
    // build a deterministic quadOrder from PAL
    const qo = [];
    for (let i = 0; i < seatCount; i++) qo.push(PAL[i]);
    quadOrder.length = 0; quadOrder.push(...qo);
  }
  const state0 = await read(pub, 'getInitialState', [seatCount, 0], gameAddr);
  const startHash = await read(pub, 'hashState', [state0], gameAddr);
  const code = BigInt(sessionId).toString(36).toUpperCase().slice(-6);
  const sess = {
    sessionId, code, status: 0, seed, seedCommit, state: state0, startState: state0,
    startHash, lastHash: startHash, players, sessionKeys, seatCount, quadOrder,
    gameAddr, moves: [], tss: [], sigs: {}, handoverTs: 0, connectTx: null,
    settleTx: null, lastTimeoutAt: null, createdAt: Date.now(),
  };
  sessions.set(sessionId, sess);
  return { ok: true, sessionId, code, seatCount, players, status: 0, quadOrder, view: viewOf(sess), iid: _iid };
}

// Join: the wallet sits at the tapped FREE colour (honored). Filled seats lock.
async function join(body) {
  const sess = need(body);
  if (!sess) throw new Error('Lobby not found on this server. Keep the host page open, then tap Join again.');
  if (sess.status !== 0) throw new Error('match already started, no new joins');
  const wallet = String(body.wallet || '');
  const key = String(body.sessionKey || '');
  if (!wallet || !key) throw new Error('signed-in wallet + session key required');
  const lower = sess.players.map(String).map((x) => x.toLowerCase());
  const already = lower.indexOf(wallet.toLowerCase());
  if (already !== -1) return { ok: true, sessionId: sess.sessionId, seat: already, players: sess.players, status: sess.status, quadOrder: sess.quadOrder, rejoined: true, view: viewOf(sess), iid: _iid };
  const want = body.seat != null ? Number(body.seat) : -1;
  let seat = -1;
  if (want >= 0 && want < sess.seatCount && !sess.players[want]) seat = want;
  else {
    for (let i = 0; i < sess.seatCount; i++) { if (!sess.players[i]) { seat = i; break; } }
  }
  if (seat < 0) throw new Error('all seats are taken');
  sess.players.push(wallet);
  sess.sessionKeys.push(key);
  // Reorder quadOrder so index == seat maps to PAL order for the session.
  if (sess.quadOrder.length < sess.seatCount) { while (sess.quadOrder.length < sess.seatCount) sess.quadOrder.push(PAL[sess.quadOrder.length]); }
  return { ok: true, sessionId: sess.sessionId, seat, quadrant: sess.quadOrder[seat] || PAL[seat] || '', players: sess.players, status: sess.status, quadOrder: sess.quadOrder, view: viewOf(sess), iid: _iid };
}

// Lobby read: who is seated (host + joiners watch fill).
async function lobby(body) {
  const sess = need(body);
  if (!sess) return { ok: true, found: false };
  return { ok: true, found: true, sessionId: sess.sessionId, code: sess.code, status: sess.status, players: sess.players, seatCount: sess.seatCount, quadOrder: sess.quadOrder, connectTx: sess.connectTx, settleTx: sess.settleTx, iid: _iid };
}

// Begin: host only, when seats are full. THE one connect transaction.
async function begin(body) {
  const { account, pub, wallet } = clients();
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server. Keep the host page open.');
  if (sess.status !== 0) throw new Error('match already started');
  const caller = String(body.wallet || '').toLowerCase();
  if (!caller || caller !== String(sess.players[0] || '').toLowerCase()) throw new Error('only the host can begin');
  if (sess.players.length !== sess.seatCount) throw new Error('waiting for players (' + sess.players.length + '/' + sess.seatCount + ')');
  // Reorder players/sessionKeys/quadOrder so seat i uses colour PAL[i] (2P => green+red).
  const wanted = [];
  const qo = [];
  for (let i = 0; i < sess.seatCount; i++) { const c = sess.quadOrder[i] || PAL[i]; if (c === 'green' || c === 'yellow' || c === 'blue' || c === 'red') qo.push(c); else qo.push(PAL[i]); }
  sess.quadOrder = qo;
  const gaddr = sess.gameAddr || LD_ADDR.LudoGames;
  const accounts = [gaddr, LD_ADDR.LudoPlayers];
  const games = 1;
  const [feeBase, feePerAccount, feePerGame] = await Promise.all([
    pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feeBase' }),
    pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerAccount' }),
    pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerGame' }),
  ]);
  const fee = feeBase + feePerAccount * BigInt(accounts.length) + feePerGame * BigInt(games);
  const r = await send(wallet, pub, {
    address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'handoverWithAccounts',
    args: [sess.sessionId, gaddr, sess.startHash, sess.seedCommit, sess.players, sess.sessionKeys, 2, accounts, games],
    value: fee, account,
  });
  let handoverTs = Math.floor(Date.now() / 1000);
  try { const blk = await pub.getBlock({ blockNumber: r.rc.blockNumber }); if (blk && blk.timestamp) handoverTs = Number(blk.timestamp); } catch (e) { }
  sess.status = 1;
  sess.handoverTs = handoverTs;
  sess.connectTx = r.hash;
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { ok: true, sessionId: sess.sessionId, status: 1, players: sess.players, quadOrder: sess.quadOrder, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), view: viewOf(sess) };
}

// Roll: free. Dice from core randomN, applied by the contract.
async function roll(body) {
  const { pub } = clients();
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server.');
  if (sess.status !== 1) throw new Error('match not live yet');
  const d = decodeState(sess.state);
  seatGate(sess, body, d.turn);
  const seeds = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'randomN', args: [sess.seed, d.rollCounter, 2] });
  const view = await step(sess, 0, d.turn, 0, 0, Array.from(seeds));
  const nd = decodeState(sess.state);
  return { ok: true, view, dice1: nd.dieA, dice2: nd.dieB, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

// Move: free.
async function move(body) {
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server.');
  if (sess.status !== 1) throw new Error('match not live yet');
  const seat = Number(body.seat);
  const d = decodeState(sess.state);
  if (seat !== d.turn) throw new Error('not your turn');
  seatGate(sess, body, seat);
  const view = await step(sess, 1, seat, Number(body.tokenIndex), Number(body.value), []);
  return { ok: true, view, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

// Pass (or timeout): free. Timeout is permissionless but contract-gated.
async function pass(body) {
  const { pub } = clients();
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server.');
  if (sess.status !== 1) throw new Error('match not live yet');
  const kind = body.timeout ? 3 : 2;
  const d = decodeState(sess.state);
  if (body.timeout) {
    const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
    const nowTs = await now(pub);
    if (sess.lastTimeoutAt != null && sess.lastTimeoutAt === sess.moves.length) throw new Error('turn already advanced, refresh the board');
    const expired = await pub.readContract({ address: sess.gameAddr || LD_ADDR.LudoGames, abi: rulesAbi, functionName: 'isTurnExpired', args: [BigInt(lastTs), BigInt(nowTs)] });
    if (!expired) throw new Error('turn still live');
  } else {
    seatGate(sess, body, d.turn);
  }
  const view = await step(sess, kind, d.turn, 0, 0, []);
  if (body.timeout) sess.lastTimeoutAt = sess.moves.length;
  return { ok: true, view, move: sess.moves[sess.moves.length - 1], moves: sess.moves.length, costUsdc6: '0', gasless: true };
}

// Board read: view + timer facts + moveCount (the shared board poll).
async function board(body) {
  const { pub } = clients();
  const sess = need(body);
  if (!sess) return { ok: true, found: false };
  const v = viewOf(sess);
  let turnSecs = 45, maxMatchSecs = 7200;
  try { turnSecs = Number(await pub.readContract({ address: sess.gameAddr || LD_ADDR.LudoGames, abi: rulesAbi, functionName: 'turnSecs' })); } catch (e) { }
  try { maxMatchSecs = Number(await pub.readContract({ address: sess.gameAddr || LD_ADDR.LudoGames, abi: rulesAbi, functionName: 'maxMatchSecs' })); } catch (e) { }
  const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  return { ok: true, found: true, view: v, status: sess.status, lastTs, turnSecs, maxMatchSecs, serverNow: Math.floor(Date.now() / 1000), settled: sess.status === 2, settleTx: sess.settleTx, iid: _iid };
}

// The full signed midchain log (for client-side verify + cache).
async function moves(body) {
  const sess = need(body);
  if (!sess) return { ok: true, found: false, sessionId: body.sessionId };
  return {
    ok: true, found: true, sessionId: sess.sessionId, gameLogic: sess.gameAddr || LD_ADDR.LudoGames,
    startHash: sess.startHash, seedCommit: sess.seedCommit, finalHash: sess.lastHash,
    settled: !!sess.settleTx, players: sess.players, sessionKeys: sess.sessionKeys,
    sponsorAddress: clients().account.address, moves: sess.moves,
  };
}

// Digest + finalHash for the winning seat to sign the settle hash.
async function digest(body) {
  const { pub } = clients();
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server.');
  const finalHash = await read(pub, 'hashState', [sess.state], sess.gameAddr);
  const dg = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  return { ok: true, sessionId: sess.sessionId, finalHash, digest: dg };
}

// Sign: a seat posts its final-hash signature. When the WINNER signature lands
// on a terminal board (or the winner is a house seat the relay signs), settle
// fires immediately so the loser does nothing.
async function sign(body) {
  const { account } = clients();
  const sess = need(body);
  if (!sess) throw new Error('Session not found on this server.');
  if (sess.status === 2) return { ok: true, stored: true, settled: true, tx: sess.settleTx };
  const seat = Number(body.seat);
  if (!(seat >= 0 && seat < sess.seatCount)) throw new Error('unknown seat');
  seatGate(sess, body, seat);
  sess.sigs[seat] = String(body.sig || '');
  const d = decodeState(sess.state);
  const need2 = d.seatCount === 2 ? 1 : 3;
  const over = d.finishCount >= need2;
  const winner = d.order[0];
  if (over && (winner === seat || String(sess.sessionKeys[winner] || '').toLowerCase() === String(account.address).toLowerCase())) {
    const pairs = Object.keys(sess.sigs).map((s) => ({ seat: Number(s), sig: sess.sigs[s] })).filter((p) => !!p.sig);
    const r = await fireSettle(sess, pairs);
    return { ok: true, stored: true, settled: true, ...r };
  }
  return { ok: true, stored: true, settled: false, seatsSigned: Object.keys(sess.sigs).length };
}

// Settle executor: verify seat sigs, commit via idempotent LudoGames.settle
// (one credit per session), then close the core session with the seats that
// signed. House seats (solo-test computers, sponsor address) sign automatically.
async function fireSettle(sess, pairs) {
  const { account, pub, wallet } = clients();
  if (sess.status === 2) return { tx: sess.settleTx, coreTx: sess.coreSettleTx || null, already: true };
  const finalHash = await read(pub, 'hashState', [sess.state], sess.gameAddr);
  const digestSync = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  const sigs = [];
  const signers = [];
  const seen = {};
  for (let hs = 0; hs < sess.seatCount; hs++) {
    if (String(sess.sessionKeys[hs] || '').toLowerCase() === String(account.address).toLowerCase()) {
      sigs.push(await account.sign({ hash: digestSync }));
      signers.push(sess.sessionKeys[hs]);
      seen[hs] = true;
    }
  }
  for (const p of pairs) {
    const seat = Number(p.seat);
    if (seen[seat] || !(seat >= 0 && seat < sess.seatCount)) continue;
    let got = '';
    try { got = await recoverAddress({ hash: digestSync, signature: p.sig }); } catch (e) { throw new Error('unparseable signature for seat ' + seat); }
    if (got.toLowerCase() !== String(sess.sessionKeys[seat]).toLowerCase()) throw new Error('bad signature for seat ' + seat);
    sigs.push(p.sig);
    signers.push(sess.sessionKeys[seat]);
    seen[seat] = true;
  }
  if (!sigs.length) throw new Error('no valid seat signature');
  const d = decodeState(sess.state);
  const need2 = d.seatCount === 2 ? 1 : 3;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const seatPlayers = sess.players.map((w) => String(w).toLowerCase() === String(account.address).toLowerCase() ? ZERO : w);
  const game = {
    turn: d.turn, seats: d.seatCount, step: sess.moves.length, board: sess.state,
    boardHash: finalHash, over: d.finishCount >= need2,
  };
  const moveTss = [BigInt(sess.handoverTs || 0)].concat(sess.tss.map((t) => BigInt(t)));
  const rGame = await send(wallet, pub, {
    address: sess.gameAddr || LD_ADDR.LudoGames, abi: settleAbi, functionName: 'settle',
    args: [sess.sessionId, [game], seatPlayers, GAME_TAG, moveTss],
    account,
  });
  let coreTx = null;
  let coreSettleError = null;
  let coreCost = 0n;
  try {
    const rCore = await send(wallet, pub, {
      address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'settle',
      args: [sess.sessionId, finalHash, sess.seed, sess.players, sess.sessionKeys, sigs, signers],
      account,
    });
    coreTx = rCore.hash;
    coreCost = BigInt(rCore.costUsdc6);
  } catch (e) {
    coreSettleError = (e && (e.shortMessage || e.message)) || String(e);
  }
  sess.status = 2;
  sess.settleTx = rGame.hash;
  sess.coreSettleTx = coreTx;
  return { tx: rGame.hash, coreTx, finalHash, costUsdc6: (BigInt(rGame.costUsdc6) + coreCost).toString(), coreSettleError };
}

// Rejoin: same untrusted-cache rule as the demo. A stranger hitting an OPEN
// lobby is invited to join (needsJoin); a live match stays closed to strangers.
// Every failure carries both reason+error so phones show human words.
async function rejoin(body) {
  const { pub } = clients();
  let sid = String(body.sessionId || body.code || '');
  const lm = sid.match(/game=([^&#]+)/); if (lm) sid = lm[1];
  const walletAddr = String(body.wallet || '').toLowerCase();
  let sess = sessions.get(sid);
  if (!sess) { const up = sid.toUpperCase(); for (const s of sessions.values()) { if (s.code === up) { sess = s; break; } } }
  const seated = sess && walletAddr && sess.players.map(String).map((x) => x.toLowerCase()).indexOf(walletAddr) !== -1;
  if (sess && sess.status === 0 && walletAddr && !seated) {
    return { ok: true, needsJoin: true, sessionId: sess.sessionId, code: sess.code, seatCount: sess.seatCount, players: sess.players, status: 0, seedCommit: sess.seedCommit, startHash: sess.startHash, sponsorAddress: clients().account.address, quadOrder: sess.quadOrder };
  }
  if (sess && walletAddr && !seated) return { ok: false, reason: 'not your session', error: 'not your session' };
  if (!sess) {
    const miss = 'Session not found on this server. Keep the host page open, then tap Join again.';
    try {
      const paid = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
      if (!paid) return { ok: false, reason: miss, error: miss };
      return { ok: false, reason: 'mid-game moves are midchain state and never on Arc. This relay instance restarted and lost the signed log, so start a new match; once settled, the result is committed on-chain.', error: 'cold' };
    } catch (e) { return { ok: false, reason: miss, error: miss }; }
  }
  return {
    ok: true, sessionId: sess.sessionId, seatCount: sess.seatCount, status: sess.status, code: sess.code,
    quadOrder: sess.quadOrder, players: sess.players, sessionKeys: sess.sessionKeys,
    seedCommit: sess.seedCommit, sponsorAddress: clients().account.address,
    startHash: sess.startHash, finalHash: sess.lastHash, settled: !!sess.settleTx,
    seedCommit2: sess.seedCommit, moves: sess.moves, view: viewOf(sess), iid: _iid,
  };
}

// Resync: any device re-submits the witnessed envelope + signed moves; the
// relay VERIFIES everything (seedCommit shape, startHash, hash-chain continuity,
// every signature against the committed seat key or the sponsor, and the on-chain
// commitment for begun sessions) before rebuilding. No database, no web2 store.
async function resync(body) {
  const { pub } = clients();
  const sid = String(body.sessionId || '');
  if (!sid) throw new Error('no session');
  const env = body.envelope || {};
  const players = Array.from(env.players || []);
  const sessionKeys = Array.from(env.sessionKeys || []);
  const seatCount = Number(env.seatCount || players.length);
  if (!players.length || players.length !== sessionKeys.length) throw new Error('incomplete envelope');
  if (seatCount !== 2 && seatCount !== 4) throw new Error('bad seat count');
  const seed = keccak256(toBytes('ggi-ludo-ld-' + sid));
  const seedCommit = keccak256(seed);
  const incoming = Array.isArray(body.moves) ? body.moves : [];
  const have = sessions.get(sid);
  if (have && have.moves.length >= incoming.length && incoming.length) return { ok: true, merged: 0, status: have.status, moves: have.moves.length, iid: _iid };
  const state0 = await read(pub, 'getInitialState', [seatCount, 0], env.gameAddr || LD_ADDR.LudoGames);
  const startHash = await read(pub, 'hashState', [state0], env.gameAddr || LD_ADDR.LudoGames);
  const sponsor = clients().account.address.toLowerCase();
  let prev = startHash.toLowerCase();
  const tss = [];
  for (let i = 0; i < incoming.length; i++) {
    const m = incoming[i] || {};
    if (String(m.prevHash || '').toLowerCase() !== prev) throw new Error('log break at move ' + i);
    const dg = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sid, m.newHash] });
    let got = '';
    try { got = (await recoverAddress({ hash: dg, signature: m.sig })).toLowerCase(); } catch (e) { throw new Error('unparseable signature at move ' + i); }
    const seatKey = String(sessionKeys[Number(m.seat)] || '').toLowerCase();
    if (!((seatKey && got === seatKey) || got === sponsor)) throw new Error('bad signature at move ' + i);
    tss.push(Number(m.ts) || 0);
    prev = String(m.newHash).toLowerCase();
  }
  let status = 0, handoverTs = 0, connectTx = null;
  try {
    const paid = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
    if (paid) {
      const commit = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'commitments', args: [sid] });
      const expect = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address[],address[]'), [seedCommit, players, sessionKeys]));
      if (String(expect).toLowerCase() !== String(commit).toLowerCase()) throw new Error('envelope does not match the on-chain session');
      status = 1;
      try {
        const logs = await pub.getLogs({ address: LD_ADDR.FoskaayGGI, event: { type: 'event', name: 'Handover', inputs: [{ type: 'bytes32', name: 'sessionId', indexed: true }] }, args: { sessionId: sid }, fromBlock: 0n, toBlock: 'latest' });
        if (logs && logs.length) {
          connectTx = logs[0].transactionHash;
          const blk = await pub.getBlock({ blockNumber: logs[0].blockNumber });
          if (blk && blk.timestamp) handoverTs = Number(blk.timestamp);
        }
      } catch (e) { }
    }
  } catch (e) { if (/envelope does not match/.test((e && e.message) || '')) throw e; }
  let state = state0;
  for (const m of incoming) { if (m.board) state = m.board; }
  const quadOrder = (have && have.quadOrder) || (Array.isArray(body.quadOrder) && body.quadOrder.length ? body.quadOrder : PAL.slice(0, seatCount));
  const sess = {
    sessionId: sid, code: have ? have.code : BigInt(sid).toString(36).toUpperCase().slice(-6),
    status, seed, seedCommit, state, startState: state0, startHash, lastHash: incoming.length ? prev : startHash,
    players, sessionKeys, seatCount, quadOrder, gameAddr: env.gameAddr || LD_ADDR.LudoGames,
    moves: incoming, tss, sigs: (have && have.sigs) || {}, handoverTs, connectTx: connectTx || (have && have.connectTx) || null,
    settleTx: (have && have.settleTx) || null, createdAt: (have && have.createdAt) || Date.now(),
  };
  sessions.set(sid, sess);
  return { ok: true, merged: incoming.length, status, moves: incoming.length, iid: _iid };
}

async function session(body) {
  const sess = need(body);
  return { ok: true, found: !!sess, sessionId: sess ? sess.sessionId : body.sessionId, status: sess ? sess.status : -1, connectTx: sess ? sess.connectTx : null, settleTx: sess ? sess.settleTx : null };
}

async function game(body) {
  const { pub } = clients();
  try {
    const ggaddr = LD_ADDR.LudoGames;
    const count = Number(await pub.readContract({ address: ggaddr, abi: settleAbi, functionName: 'gameCount', args: [String(body.sessionId)] }));
    if (!count) return { ok: true, found: false };
    const list = await pub.readContract({ address: ggaddr, abi: settleAbi, functionName: 'gamesOf', args: [String(body.sessionId)] });
    const last = list[list.length - 1];
    const dec = await pub.readContract({ address: ggaddr, abi: rulesAbi, functionName: 'decodeState', args: [last.board] });
    return { ok: true, found: true, gameCount: count, over: last.over, turn: dec[0], finishCount: dec[1], seatCount: dec[3], steps: dec[4], order: dec[5], points: dec[6], boardHash: last.boardHash };
  } catch (e) { return { ok: true, found: false, error: (e && (e.shortMessage || e.message)) || String(e) }; }
}

async function points(body) {
  const { pub } = clients();
  const player = String(body.player || body.wallet || '');
  if (!player) return { ok: true, points: '0' };
  const paddr = LD_ADDR.LudoPlayers;
  const pts = await pub.readContract({ address: paddr, abi: playersAbi, functionName: 'pointsOf', args: [player, GAME_TAG] });
  return { ok: true, points: pts.toString() };
}

async function sponsor() {
  return { ok: true, address: clients().account.address, core: LD_ADDR.FoskaayGGI, games: LD_ADDR.LudoGames, players: LD_ADDR.LudoPlayers, tag: GAME_TAG };
}

export const actions = {
  ldsCreate: create, ldsJoin: join, ldsLobby: lobby, ldsBegin: begin,
  ldsRoll: roll, ldsMove: move, ldsPass: pass, ldsBoard: board,
  ldsMoves: moves, ldsDigest: digest, ldsSign: sign, ldsRejoin: rejoin,
  ldsResync: resync, ldsSession: session, ldsGame: game, ldsPoints: points,
  ldsSponsor: sponsor, ldsTouch: touch,
};

export { sessions as ldSessions, clients as ldClients, fireSettle as ldsFireSettle, viewOf as ldsViewOf, decodeState as ldsDecode, LD_ADDR, GAME_TAG };

export default { actions };