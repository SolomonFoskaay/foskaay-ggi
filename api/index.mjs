// api_handlers/foskaay-ggi-sponsor.mjs
//
// FOSKAAY GGI SPONSOR RELAY — Foskaay Gasless Games Infrastructure.
//
// WHAT THIS IS: the tiny serverless relay that pays the tiny fee and gas so the
// PLAYER NEVER PAYS and never sees a wallet popup. The clean core is TWO
// contracts, so this relay does exactly two things:
//   1. connect: FoskaayGGI.handover (payable; forwards the fee to destination)
//   2. settle:  FoskaayGGI.settle   (verifies the players' signatures)
// The two demo actions (midchainHandover / midchainSettle) are thin wrappers the
// PvP demo calls; they are the same two core calls with demo-friendly arguments.
//
// IT IS Foskaay GGI LOGIC ONLY. It imports nothing from the host game platform and
// keeps no host state. When Foskaay GGI moves to its own repo, this file moves too.
//
// SECURITY: the sponsor key is read from the environment and NEVER returned to the
// client. This endpoint only performs the fixed operations below; it is not a
// generic "sign anything" service, so a leaked client cannot drain the sponsor.
//
// Env: GFG_Arc_Gasless_Sponsor_Key (already set on the deployment), GFG_Arc_RPC.

import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes, encodeAbiParameters, parseAbiParameters, recoverAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';
// NON-SECRET single source of truth for the public addresses + Arc facts. Edit
// the file, never Vercel env, when an address changes. Default network is
// mainnet now that it is deployed; set GFG_GGI_NETWORK=testnet to run testnet.
import { NETWORKS as GGI_NETS } from '../deployments/addresses.mjs';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const NET_NAME = process.env.GFG_GGI_NETWORK || 'mainnet';
const NETWORK = GGI_NETS[NET_NAME] || GGI_NETS.testnet;
const RPC = process.env.GFG_Arc_RPC || NETWORK.rpc; // env override only for a private RPC
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = NETWORK.chainId;

// The deployed Foskaay GGI addresses come from the single non-secret source
// (foskaay-ggi/deployments/addresses.mjs), never hardcoded here.
const ADDR = {
  FoskaayGGI: NETWORK.contracts.FoskaayGGI,
  FoskaayGGIGames: NETWORK.contracts.FoskaayGGIGames,
  FoskaayGGIPlayers: NETWORK.contracts.FoskaayGGIPlayers,
  FoskaayGGILudo: NETWORK.contracts.FoskaayGGILudo,
};

// The pure Ludo rules, now on FoskaayGGIGames.
const gamesRulesAbi = parseAbi([
  'function getInitialState(uint8 seatCount, uint8 userSeat) pure returns (bytes)',
  'function applyMove(bytes state, uint8 kind, uint8 seat, uint8 tokenIndex, uint8 value, bytes32[] seeds) pure returns (bytes)',
  'function hashState(bytes state) pure returns (bytes32)',
  'function isTerminal(bytes state) pure returns (bool finished, uint8 winner)',
  'function decodeState(bytes state) pure returns (uint8 turn, uint8 finishCount, uint8 userSeat, uint8 seatCount, int16[16] steps, uint8[4] order, uint16[4] points, uint8 dieA, uint8 dieB)',
]);

const coreAbi = parseAbi([
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount) payable',
  'function handoverWithAccounts(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount, address[] accounts, uint16 games) payable',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, bytes32[] seedCommits, address[][] players, address[][] sessionKeys, uint16 randomCount) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, address[] players, address[] sessionKeys, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes32[] seedReveals, address[][] players, address[][] sessionKeys, bytes[][] sigs, address[][] signers)',
  'function randomN(bytes32 seed, uint256 counter, uint256 count) pure returns (bytes32[])',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function fee() view returns (uint256)',
  'function feeBase() view returns (uint256)',
  'function feePerAccount() view returns (uint256)',
  'function feePerGame() view returns (uint256)',
  'function isPaid(bytes32 sessionId) view returns (bool)',
]);

// Phase 2 game contract: settle writes N games in one tx and credits the player.
const gamesAbi = parseAbi([
  'function settle(bytes32 sessionId, (uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[] list, address[] seatPlayers, bytes32 gameTag) returns (uint256)',
  'function gameCount(bytes32 sessionId) view returns (uint256)',
  'function gamesOf(bytes32 sessionId) view returns ((uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[])',
]);

// The demo's game tag (the same bucket the player points are stored under).
const GAME_TAG = keccak256(toBytes('ludo'));

// On-chain HANDOVER/SETTLED events, used to build a WALLET's permanent session
// history from the chain (no relay memory, never resets). Delegation starts at
// the core proxy deploy block on each network.
const HANDOVER_EVENT = {
  type: 'event', name: 'Handover',
  inputs: [
    { type: 'bytes32', name: 'sessionId', indexed: true },
    { type: 'address', name: 'gameLogic', indexed: true },
    { type: 'bytes32', name: 'startHash' },
    { type: 'bytes32', name: 'seedCommit' },
    { type: 'address[]', name: 'players' },
    { type: 'address[]', name: 'sessionKeys' },
    { type: 'uint16', name: 'randomCount' },
    { type: 'address', name: 'payer', indexed: true },
    { type: 'uint64', name: 'counter' },
  ],
};
const SETTLED_EVENT = {
  type: 'event', name: 'Settled',
  inputs: [
    { type: 'bytes32', name: 'sessionId', indexed: true },
    { type: 'bytes32', name: 'finalHash' },
    { type: 'bytes32', name: 'seedReveal' },
    { type: 'address', name: 'payer', indexed: true },
  ],
};
const HANDOVER_FROM = { testnet: 64110469n, mainnet: 23065553n };

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function clients() {
  if (!SPONSOR_KEY) throw new Error('server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set');
  const account = accountFor(SPONSOR_KEY);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  return { account, pub, wallet };
}

// Send one sponsored transaction and return BOTH the receipt and the REAL cost
// the sponsor paid, in USDC base units (6dp), computed from the receipt:
// gasUsed x effectiveGasPrice. Never estimated or hardcoded: it is what Arc
// actually charged, so the demo can show the truth.
async function send(wallet, pub, req) {
  const hash = await wallet.writeContract(req);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('tx reverted: ' + hash);
  let costUsdc6 = 0n;
  try {
    const gasUsed = rc.gasUsed || 0n;
    let price = rc.effectiveGasPrice;
    if (price == null) {
      const tx = await pub.getTransaction({ hash });
      price = tx.gasPrice || 0n;
    }
    // Arc's native asset is USDC with 18 decimals, so gasUsed x price is in 18dp
    // USDC. The ERC-20 view is 6dp, so divide by 1e12 to match the token.
    costUsdc6 = (gasUsed * (price || 0n)) / 1_000_000_000_000n;
  } catch (_) { /* cost stays 0 if the receipt lacks the fields */ }
  return { rc, hash, costUsdc6 };
}

// ---------------------------------------------------------------- Ludo demo
//
// THE FOSKAAY GGI MIDCHAIN. The rules are pure (on FoskaayGGIGames), so every
// roll and every move runs via eth_call for FREE (player AND sponsor). The relay
// hash-chains each move and signs each new hash with the session key. Only TWO
// things are transactions: the handover (connect + fee) and the settle. There is
// NO replay: the final hash commits to the board AND the points, so settle costs
// the same whether the match had 5 moves or 200.

const sessions = new Map(); // sessionId => { sessionId, matchRef, seed, seedCommit, state, startHash, players, sessionKeys, seatCount, userSeat, moves: [] }

function demoSessionId(body) {
  return body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [clients().account.address, BigInt(Date.now())]));
}

// Decode the compact 36-byte state for display. The STATE always comes from the
// contract's applyMove; this only reads it.
function decodeState(hex) {
  const b = Buffer.from(String(hex).slice(2), 'hex');
  if (b.length !== 36) throw new Error('bad state length');
  const steps = [];
  for (let i = 0; i < 16; i++) { const v = b[8 + i]; steps.push(v === 255 ? -1 : v); }
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
    matchOver: d.finishCount >= need, winner: d.finishCount > 0 ? d.order[0] : 255,
  };
}

/// The pure rules now live on FoskaayGGIGames, so all rule calls are eth_call
/// reads against the game contract (still free, player and sponsor).
async function gameRead(pub, fn, args) {
  return await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesRulesAbi, functionName: fn, args });
}

function needSession(body) {
  const s = sessions.get(String(body.sessionId));
  if (!s) throw new Error('unknown session (restart the match)');
  return s;
}

/// A move is computed free via eth_call, hash-chained (prevHash -> newHash),
/// and signed by the sponsor (the midchain's signer). It is NEVER an Arc
/// transaction. The signed move log is the Foskaay GGI midchain: any device can
/// fetch it and verify it client-side (continuity + signatures + on-chain
/// anchors) for free. NOTHING is written to Arc between the handover and the
/// settle, ever. A per-move storage write (e.g. an on-chain recordLive) would be
/// a third transaction and is the exact mistake this design forbids.
async function step(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = clients();
  const newState = await gameRead(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []]);
  const prevHash = sess.state === sess.startState ? sess.startHash : sess.lastHash;
  const newHash = await gameRead(pub, 'hashState', [newState]);
  const digest = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  sess.state = newState;
  sess.lastHash = newHash;
  if (!sess.startState) { sess.startState = newState; }
  sess.moves.push({ kind, seat, seatLabel: ['green', 'yellow', 'blue', 'red'][seat] || ('seat' + seat), tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig });
  return viewOf(sess);
}

/// CONNECT: one transaction. Handover pays the fee, commits the seed and the
/// participants, and links the game. The midchain then runs for free.
async function doDemoCreate(body) {
  const { account, pub, wallet } = clients();
  const sessionId = demoSessionId(body);
  const matchRef = String(body.matchRef || Date.now());
  const seatCount = Number(body.seatCount || 2);
  const userSeat = Number(body.userSeat || 0);
  const user = body.user || account.address;

  // Session-derived seed: recoverable from the sessionId alone, so a cold relay
  // can reconstruct this session from on-chain (seed must satisfy settled reveal).
  const seed = keccak256(toBytes('ggi-ludo-' + sessionId));
  const seedCommit = keccak256(seed);

  const state0 = await gameRead(pub, 'getInitialState', [seatCount, userSeat]);
  const startHash = await gameRead(pub, 'hashState', [state0]);

  // Phase 4 seat wiring: the logged-in user's seat uses their Dynamic EVM
  // address + their client-held session key (no wallet popup). Every other seat
  // (computer/house) has NO wallet: it is signed only by this Vercel sponsor key.
  const sessionKey = body.sessionKey || user;
  const players = new Array(seatCount).fill(account.address);
  players[userSeat] = user;
  const sessionKeys = new Array(seatCount).fill(account.address);
  sessionKeys[userSeat] = sessionKey;
  // ONLY the user seat earns points. Computer seats are address(0) here so the
  // game never credits them (Gap 2).
  const creditPlayers = new Array(seatCount).fill('0x0000000000000000000000000000000000000000');
  creditPlayers[userSeat] = user;

  // Phase 3: the dev-declared accounts are the two real contracts, lifted once for
  // the whole session. fee = base + perAccount*accounts + perGame*games.
  const accounts = [ADDR.FoskaayGGIGames, ADDR.FoskaayGGIPlayers];
  const games = Number(body.games || 1);
  const [feeBase, feePerAccount, feePerGame] = await Promise.all([
    pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feeBase' }),
    pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerAccount' }),
    pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerGame' }),
  ]);
  const fee = feeBase + feePerAccount * BigInt(accounts.length) + feePerGame * BigInt(games);
  const r = await send(wallet, pub, {
    address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'handoverWithAccounts',
    args: [sessionId, ADDR.FoskaayGGIGames, startHash, seedCommit, players, sessionKeys, 2, accounts, games],
    value: fee, account,
  });
  const sess = { sessionId, matchRef, seed, seedCommit, state: state0, startState: state0, startHash, lastHash: startHash, players, sessionKeys, creditPlayers, accounts, games, seatCount, userSeat, user, sessionKey, moves: [], connectTx: r.hash, settleTx: null, createdAt: Date.now() };
  sessions.set(sessionId, sess);
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { sessionId, matchRef, userSeat, seatCount, user, sessionKey, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), accounts, games, view: viewOf(sess) };
}

/// ROLL: free. Dice come from the core's randomN (pure); applyMove is pure.
async function doDemoRoll(body) {
  const { pub } = clients();
  const sess = needSession(body);
  const d = decodeState(sess.state);
  const seeds = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'randomN', args: [sess.seed, d.rollCounter, 2] });
  const view = await step(sess, 0, d.turn, 0, 0, Array.from(seeds));
  const nd = decodeState(sess.state);
  return { view, dice1: nd.dieA, dice2: nd.dieB, costUsdc6: '0', gasless: true };
}

/// MOVE: free.
async function doDemoMove(body) {
  const sess = needSession(body);
  const view = await step(sess, 1, Number(body.seat), Number(body.tokenIndex), Number(body.value), []);
  return { view, costUsdc6: '0', gasless: true };
}

/// PASS (or timeout): free.
async function doDemoPass(body) {
  const sess = needSession(body);
  const kind = body.timeout ? 3 : 2;
  const d = decodeState(sess.state);
  const view = await step(sess, kind, d.turn, 0, 0, []);
  return { view, costUsdc6: '0', gasless: true };
}

/// READ the board (free). Points are inside the state (midchain), so no settle cost.
async function doDemoBoard(body) {
  const sess = needSession(body);
  const v = viewOf(sess);
  v.userPoints = { lifetime: v.points[sess.userSeat] || 0, spendable: v.points[sess.userSeat] || 0 };
  return { view: v, ...v };
}

/// The signed move log, for the explorer to verify the midchain client-side.
async function doDemoMoves(body) {
  const sess = sessions.get(String(body.sessionId));
  if (!sess) return { found: false, sessionId: body.sessionId };
  return {
    found: true, sessionId: sess.sessionId, gameLogic: ADDR.FoskaayGGIGames,
    startHash: sess.startHash, seedCommit: sess.seedCommit, finalHash: sess.lastHash,
    settled: !!sess.settleTx, players: sess.players, sessionKeys: sess.sessionKeys,
    sponsorAddress: clients().account.address, moves: sess.moves,
  };
}

/// The digest + final hash for the current state, so the client's session key
/// can sign the settle hash (Phase 4 real player seat).

/// The on-chain txs for a session the relay knows (for the explorer to decode the
/// Handover/Settled events from receipts instead of scanning from block 0).
async function doDemoSession(body) {
  const sess = sessions.get(String(body.sessionId));
  return { found: !!sess, sessionId: body.sessionId, connectTx: sess ? sess.connectTx : null, settleTx: sess ? sess.settleTx : null };
}

/// PERMANENT wallet session history from the chain (Handover/Settled events from
/// the deploy block), filtered by the player wallet. Never stored in relay memory
/// and never resets: it is derived from on-chain facts on every call.
async function doWalletSessions(body) {
  const { pub } = clients();
  const wallet = String(body.wallet || '').toLowerCase();
  if (!wallet) return { sessions: [] };
  const from = HANDOVER_FROM[NET_NAME] || 0n;
  const [hands, setts] = await Promise.all([
    pub.getLogs({ address: ADDR.FoskaayGGI, event: HANDOVER_EVENT, fromBlock: from, toBlock: 'latest' }).catch(() => []),
    pub.getLogs({ address: ADDR.FoskaayGGI, event: SETTLED_EVENT, fromBlock: from, toBlock: 'latest' }).catch(() => []),
  ]);
  const settledMap = {};
  for (const L of setts) settledMap[L.args.sessionId.toLowerCase()] = true;
  const out = [];
  for (let i = hands.length - 1; i >= 0; i--) {
    const L = hands[i];
    const ps = (L.args.players || []).map(String);
    if (!ps.length || ps.map((x) => x.toLowerCase()).indexOf(wallet) === -1) continue;
    const sid = L.args.sessionId;
    let gamesCommitted = 0;
    try {
      if (ADDR.FoskaayGGIGames) gamesCommitted = Number(await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesAbi, functionName: 'gameCount', args: [sid] }));
    } catch (e) { /* soft */ }
    out.push({ sessionId: sid, block: L.blockNumber, tx: L.transactionHash, paid: true, settled: !!settledMap[sid.toLowerCase()], gamesCommitted, games: gamesCommitted });
    if (out.length >= 12) break;
  }
  return { sessions: out };
}

/// A logged-in account's recent sessions (in this relay instance), with on-chain
/// status: does the core see it paid/committed. Serverless memory is per-instance,
/// so this is a best-effort history, never localstorage.
async function doDemoSessions(body) {
  const { pub } = clients();
  const wallet = String(body.wallet || '');
  const list = [];
  for (const [sid, s] of sessions) {
    if (wallet && s.user !== wallet) continue;
    let paid = false, gamesCommitted = 0;
    try {
      paid = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
      if (ADDR.FoskaayGGIGames) gamesCommitted = Number(await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesAbi, functionName: 'gameCount', args: [sid] }));
    } catch (e) { /* one bad read must not break the list */ }
    list.push({ sessionId: sid, createdAt: s.createdAt, games: s.games, seatCount: s.seatCount, paid, gamesCommitted, settled: !!s.settleTx, user: s.user });
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { sessions: list };
}

/// REJOIN a live session: return the current board + the FULL signed move log
/// (the midchain) plus its on-chain anchors, so the client VERIFIES before
/// rendering. The relay is only an untrusted cache: continuity + signature
/// checks + on-chain anchors (Handover startHash, participants; settle
/// finalHash) all run client-side for free. Gated: only the session's owner
/// wallet may rejoin, so nobody hijacks another player's game.
/// Cold path: a serverless restart loses the midchain log, and moves were never
/// on Arc, so the honest response is the ON-CHAIN truth (paid, participants),
/// never a fabricated board. Settled sessions are always reviewable on-chain.
async function doDemoRejoin(body) {
  const { pub } = clients();
  const sid = String(body.sessionId);
  const walletAddr = String(body.wallet || '').toLowerCase();
  const sess = sessions.get(sid);
  if (sess && walletAddr && sess.user && walletAddr !== String(sess.user).toLowerCase()) {
    return { ok: false, reason: 'not your session' };
  }
  if (!sess) {
    try {
      const paid = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
      if (!paid) return { ok: false, reason: 'session not found on-chain' };
      return { ok: false, reason: 'mid-game moves are midchain state and never on Arc. This relay instance restarted and lost the signed log, so start a new match; if it was settled, the result is committed on-chain.' };
    } catch (e) {
      return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
    }
  }
  return {
    ok: true, sessionId: sid, seatCount: sess.seatCount, userSeat: sess.userSeat,
    players: sess.players, sessionKeys: sess.sessionKeys, seedCommit: sess.seedCommit,
    sponsorAddress: clients().account.address, startHash: sess.startHash,
    finalHash: sess.lastHash, settled: !!sess.settleTx, moves: sess.moves,
    view: viewOf(sess), reconstructed: false,
  };
}

async function doDemoDigest(body) {
  const { pub } = clients();
  const sess = needSession(body);
  const finalHash = await gameRead(pub, 'hashState', [sess.state]);
  const digest = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  return { sessionId: sess.sessionId, finalHash, digest };
}

/// Reconstruct a SETTLED game fully from on-chain (the board bytes live in the
/// Games contract after settle), so a session can be reviewed forever with no
/// relay cache. Active (mid-play) sessions are midchain state and need the relay.
async function doDemoGame(body) {
  const { pub } = clients();
  const sessionId = String(body.sessionId);
  try {
    const count = Number(await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesAbi, functionName: 'gameCount', args: [sessionId] }));
    if (!count) return { found: false };
    const list = await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesAbi, functionName: 'gamesOf', args: [sessionId] });
    const last = list[list.length - 1];
    const dec = await pub.readContract({ address: ADDR.FoskaayGGIGames, abi: gamesRulesAbi, functionName: 'decodeState', args: [last.board] });
    return { found: true, gameCount: count, over: last.over, turn: dec.turn, finishCount: dec.finishCount, seatCount: dec.seatCount, steps: dec.steps, order: dec.order, points: dec.points, board: last.board, boardHash: last.boardHash };
  } catch (e) { return { found: false, error: (e && (e.shortMessage || e.message)) || String(e) }; }
}

/// SETTLE: the LAST transactions. First FoskaayGGIGames.settle writes the match
/// on-chain and credits FoskaayGGIPlayers in the same step; then the core settle
/// verifies the players' signatures and closes the session. No replay: the final
/// hash already commits to the board and the points, so this is O(1).
async function doDemoSettle(body) {
  const { account, pub, wallet } = clients();
  const sess = needSession(body);
  const finalHash = await gameRead(pub, 'hashState', [sess.state]);
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  const game = {
    turn: d.turn,
    seats: d.seatCount,
    step: sess.moves.length,
    board: sess.state,
    boardHash: finalHash,
    over: d.finishCount >= need,
  };
  const rGame = await send(wallet, pub, {
    address: ADDR.FoskaayGGIGames, abi: gamesAbi, functionName: 'settle',
    args: [sess.sessionId, [game], sess.creditPlayers, GAME_TAG],
    account,
  });
  const digest = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  // Every seat's signer must match the handover commitment. The user seat is
  // signed by the client session key (body.sig); the house seats by this sponsor.
  const sigs = [];
  const signers = [];
  for (let s = 0; s < sess.seatCount; s++) {
    signers.push(sess.sessionKeys[s]);
    if (s === sess.userSeat && body.sig) sigs.push(body.sig);
    else sigs.push(await account.sign({ hash: digest }));
  }
  // The match commit (Games.settle) is the important result: it records the game
  // and credits the player. The core session-close is a bonus but must never
  // hard-fail the demo (that is what froze a finished 2P match). Report either way.
  let coreTx = null;
  let coreSettleError = null;
  let coreCost = 0n;
  try {
    const rCore = await send(wallet, pub, {
      address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'settle',
      args: [sess.sessionId, finalHash, sess.seed, sess.players, sess.sessionKeys, sigs, signers],
      account,
    });
    coreTx = rCore.hash;
    coreCost = BigInt(rCore.costUsdc6);
  } catch (e) {
    coreSettleError = (e && (e.shortMessage || e.message)) || String(e);
  }
  sess.settleTx = rGame.hash;
  return { tx: rGame.hash, coreTx, finalHash, costUsdc6: (BigInt(rGame.costUsdc6) + coreCost).toString(), coreSettleError };
}

// ---------------------------------------------------------------- ludo-mp
//
// MULTIPLAYER (gfgnew/board/ludo-mp), Arc TESTNET ONLY. Same midchain shape as
// the demo above, but every seat is a REAL player: players[] + sessionKeys[]
// all come from the clients, and the settle carries every seat's own
// signature (the relay signs none). Single-player demo paths above are
// untouched; this block only adds mp* actions on isolated session state.

const MP_NET = GGI_NETS.testnet;
const MP_ADDR = {
  FoskaayGGI: MP_NET.contracts.FoskaayGGI,
  GFGGames: MP_NET.contracts.GFGGames,
  GFGPlayers: MP_NET.contracts.GFGPlayers,
};
const MP_GAME_TAG = keccak256(toBytes('ludo-mp'));

const mpChain = defineChain({
  id: MP_NET.chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [MP_NET.rpc] } },
});

function mpClients() {
  if (!SPONSOR_KEY) throw new Error('server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set');
  const account = accountFor(SPONSOR_KEY);
  const pub = createPublicClient({ chain: mpChain, transport: http(MP_NET.rpc) });
  const wallet = createWalletClient({ chain: mpChain, transport: http(MP_NET.rpc), account });
  return { account, pub, wallet };
}

const mpSessions = new Map(); // sessionId => lobby(0)/live(1)/settled(2): { sessionId, status, seed, seedCommit, state, startHash, lastHash, players, sessionKeys, seatCount, moves: [], tss: [], sigs: {}, handoverTs, connectTx, settleTx, createdAt }

// The mp game settle carries the move timestamps for the contract timer.
const mpGamesAbi = parseAbi([
  'function settle(bytes32 sessionId, (uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[] list, address[] seatPlayers, bytes32 gameTag, uint64[] moveTss) returns (uint256)',
  'function gameCount(bytes32 sessionId) view returns (uint256)',
  'function gamesOf(bytes32 sessionId) view returns ((uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[])',
  'function turnSecs() view returns (uint64)',
  'function maxMatchSecs() view returns (uint64)',
  'function isTurnExpired(uint64 lastTs, uint64 nowTs) view returns (bool)',
]);

async function mpGameRead(pub, fn, args) {
  return await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesRulesAbi, functionName: fn, args });
}

function mpNeedSession(body) {
  const s = mpSessions.get(String(body.sessionId));
  if (!s) throw new Error('unknown session (start or join a multiplayer match first)');
  return s;
}

/// SEAT GATE (anti-impersonation): the wallet calling a turn action must own
/// the acting seat from the on-chain-committed players list. The pure contract
/// enforces whose TURN it is; this enforces WHO may act for that seat, so one
/// phone can never move another player's tokens.
function mpSeatGate(sess, body, seat) {
  const wallet = String(body.wallet || '').toLowerCase();
  const owner = String(sess.players[seat] || '').toLowerCase();
  if (!wallet || wallet !== owner) throw new Error('not your turn seat (this seat belongs to another wallet)');
}

function mpViewOf(sess) {
  return viewOf(sess); // same 36-byte board decode, shared helper
}

/// Chain-anchored now (seconds). Move timestamps must never lie ahead of the
/// chain head, or settle's not-the-future check reverts under normal clock
/// skew. Wall clock is only ever rounded DOWN to chain time, never up, and
/// never below the previous stamp (testnet heads jitter backward).
async function mpNow(pub, floor) {
  const wall = Math.floor(Date.now() / 1000);
  let ts = wall;
  try {
    const head = await pub.getBlock({ blockTag: 'latest' });
    if (head && head.timestamp) ts = Math.min(wall, Number(head.timestamp));
  } catch (e) { /* wall fallback */ }
  if (floor && ts < floor) ts = floor;
  return ts;
}

async function mpStep(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = mpClients();
  const newState = await mpGameRead(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []]);
  const prevHash = sess.moves.length ? sess.lastHash : sess.startHash;
  const newHash = await mpGameRead(pub, 'hashState', [newState]);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  const floor = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  const ts = await mpNow(pub, floor);
  sess.state = newState;
  sess.lastHash = newHash;
  sess.moves.push({ kind, seat, seatLabel: 'seat' + seat, tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig, ts });
  sess.tss.push(ts);
  return mpViewOf(sess);
}

/// MP lobby: the host opens a room (NO handover yet). Returns the code + link.
/// players/sessionKeys start as [hostWallet, hostKey]; joiners append until
/// begin. Solo test: the host device holds every seat and sends full arrays.
async function doMpCreate(body) {
  const { pub } = mpClients();
  const seatCount = Number(body.seatCount || 2);
  if (seatCount !== 2 && seatCount !== 4) throw new Error('seatCount must be 2 or 4');
  const host = String(body.wallet || (Array.isArray(body.players) && body.players[0]) || '');
  const hostKey = String(body.sessionKey || (Array.isArray(body.sessionKeys) && body.sessionKeys[0]) || '');
  if (!host || !hostKey) throw new Error('signed-in host wallet + session key required');
  const players = Array.isArray(body.players) && body.players.length > 1 ? Array.from(body.players) : [host];
  const sessionKeys = Array.isArray(body.sessionKeys) && body.sessionKeys.length > 1 ? Array.from(body.sessionKeys) : [hostKey];
  const { account } = mpClients();
  const sessionId = body.sessionId || keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [account.address, BigInt(Date.now())]));
  const seed = keccak256(toBytes('ggi-ludo-mp-' + sessionId));
  const seedCommit = keccak256(seed);
  const state0 = await mpGameRead(pub, 'getInitialState', [seatCount, 0]);
  const startHash = await mpGameRead(pub, 'hashState', [state0]);
  const code = BigInt(sessionId).toString(36).toUpperCase().slice(-6);
  const sess = { sessionId, code, status: 0, seed, seedCommit, state: state0, startHash, lastHash: startHash, players, sessionKeys, seatCount, moves: [], tss: [], sigs: {}, handoverTs: 0, connectTx: null, settleTx: null, createdAt: Date.now() };
  mpSessions.set(sessionId, sess);
  return { sessionId, code, seatCount, players, status: 0, view: mpViewOf(sess) };
}

/// MPJOIN: one tap. A signed-in wallet claims the first free seat with its own
/// silently-generated session key address. No wallet copying: the code/link is
/// the only thing shared. Joins lock once the match begins.
async function doMpJoin(body) {
  const sess = mpNeedSession(body);
  if (sess.status !== 0) throw new Error('match already started, no new joins');
  const wallet = String(body.wallet || '');
  const key = String(body.sessionKey || '');
  if (!wallet || !key) throw new Error('signed-in wallet + session key required');
  const lower = sess.players.map(String).map((x) => x.toLowerCase());
  if (lower.indexOf(wallet.toLowerCase()) !== -1) {
    return { sessionId: sess.sessionId, seat: lower.indexOf(wallet.toLowerCase()), players: sess.players, status: sess.status, rejoined: true, view: mpViewOf(sess) };
  }
  if (sess.players.length >= sess.seatCount) throw new Error('all seats are taken');
  sess.players.push(wallet);
  sess.sessionKeys.push(key);
  return { sessionId: sess.sessionId, seat: sess.players.length - 1, players: sess.players, status: sess.status, view: mpViewOf(sess) };
}

/// MPLOBBY: free read of who is seated (for the host + joiners to watch fill).
async function doMpLobby(body) {
  const sess = mpNeedSession(body);
  return { sessionId: sess.sessionId, code: sess.code, status: sess.status, players: sess.players, seatCount: sess.seatCount, connectTx: sess.connectTx, settleTx: sess.settleTx };
}

/// MPBEGIN: host (players[0]) starts the match when every seat is filled. The
/// ONE handover commits the final set + seed; sponsor pays. Joins lock after.
async function doMpBegin(body) {
  const { account, pub, wallet } = mpClients();
  const sess = mpNeedSession(body);
  if (sess.status !== 0) throw new Error('match already started');
  const caller = String(body.wallet || '').toLowerCase();
  if (!caller || caller !== String(sess.players[0] || '').toLowerCase()) throw new Error('only the host can begin');
  if (sess.players.length !== sess.seatCount) throw new Error('waiting for players (' + sess.players.length + '/' + sess.seatCount + ')');
  const accounts = [MP_ADDR.GFGGames, MP_ADDR.GFGPlayers];
  const games = 1;
  const [feeBase, feePerAccount, feePerGame] = await Promise.all([
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feeBase' }),
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerAccount' }),
    pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'feePerGame' }),
  ]);
  const fee = feeBase + feePerAccount * BigInt(accounts.length) + feePerGame * BigInt(games);
  const r = await send(wallet, pub, {
    address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'handoverWithAccounts',
    args: [sess.sessionId, MP_ADDR.GFGGames, sess.startHash, sess.seedCommit, sess.players, sess.sessionKeys, 2, accounts, games],
    value: fee, account,
  });
  let handoverTs = Math.floor(Date.now() / 1000);
  try {
    const blk = await pub.getBlock({ blockNumber: r.rc.blockNumber });
    if (blk && blk.timestamp) handoverTs = Number(blk.timestamp);
  } catch (e) { /* wall-clock fallback */ }
  sess.status = 1;
  sess.handoverTs = handoverTs;
  sess.connectTx = r.hash;
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { sessionId: sess.sessionId, status: 1, players: sess.players, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), view: mpViewOf(sess) };
}

/// MPROLL: free. Dice from the core randomN, applied via the mp game contract.
async function doMpRoll(body) {
  const { pub } = mpClients();
  const sess = mpNeedSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const d = decodeState(sess.state);
  mpSeatGate(sess, body, d.turn);
  const seeds = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'randomN', args: [sess.seed, d.rollCounter, 2] });
  const view = await mpStep(sess, 0, d.turn, 0, 0, Array.from(seeds));
  const nd = decodeState(sess.state);
  return { view, dice1: nd.dieA, dice2: nd.dieB, costUsdc6: '0', gasless: true };
}

/// MPMOVE: free.
async function doMpMove(body) {
  const sess = mpNeedSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const seat = Number(body.seat);
  const d = decodeState(sess.state);
  if (seat !== d.turn) throw new Error('not your turn');
  mpSeatGate(sess, body, seat);
  const view = await mpStep(sess, 1, Number(body.seat), Number(body.tokenIndex), Number(body.value), []);
  return { view, costUsdc6: '0', gasless: true };
}

/// MPPASS: free. Normal pass is seat-gated like a move. Timeout-advance is
/// PERMISSIONLESS but contract-gated: anyone may trigger it, yet it executes
/// only when the contract's own isTurnExpired says the deadline truly passed.
async function doMpPass(body) {
  const { pub } = mpClients();
  const sess = mpNeedSession(body);
  if (sess.status !== 1) throw new Error('match not live yet');
  const kind = body.timeout ? 3 : 2;
  const d = decodeState(sess.state);
  if (body.timeout) {
    const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
    const nowTs = await mpNow(pub);
    const expired = await pub.readContract({ address: MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'isTurnExpired', args: [BigInt(lastTs), BigInt(nowTs)] });
    if (!expired) throw new Error('turn still live');
  } else {
    mpSeatGate(sess, body, d.turn);
  }
  const view = await mpStep(sess, kind, d.turn, 0, 0, []);
  return { view, costUsdc6: '0', gasless: true };
}

async function doMpBoard(body) {
  const { pub } = mpClients();
  const sess = mpNeedSession(body);
  const v = mpViewOf(sess);
  let turnSecs = 45;
  try { turnSecs = Number(await pub.readContract({ address: MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'turnSecs' })); } catch (e) { /* default */ }
  const lastTs = sess.tss.length ? sess.tss[sess.tss.length - 1] : (sess.handoverTs || 0);
  return { view: v, status: sess.status, lastTs, turnSecs, serverNow: Math.floor(Date.now() / 1000), settled: sess.status === 2, settleTx: sess.settleTx };
}

async function doMpMoves(body) {
  const sess = mpSessions.get(String(body.sessionId));
  if (!sess) return { found: false, sessionId: body.sessionId };
  return {
    found: true, sessionId: sess.sessionId, gameLogic: MP_ADDR.GFGGames,
    startHash: sess.startHash, seedCommit: sess.seedCommit, finalHash: sess.lastHash,
    settled: !!sess.settleTx, players: sess.players, sessionKeys: sess.sessionKeys,
    sponsorAddress: mpClients().account.address, moves: sess.moves,
  };
}

async function doMpDigest(body) {
  const { pub } = mpClients();
  const sess = mpNeedSession(body);
  const finalHash = await mpGameRead(pub, 'hashState', [sess.state]);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  return { sessionId: sess.sessionId, finalHash, digest };
}

async function doMpSession(body) {
  const sess = mpSessions.get(String(body.sessionId));
  return { found: !!sess, sessionId: body.sessionId, status: sess ? sess.status : -1, connectTx: sess ? sess.connectTx : null, settleTx: sess ? sess.settleTx : null };
}

/// MPREJOIN: same untrusted-cache rule as the demo. Verify client-side.
async function doMpRejoin(body) {
  const { pub } = mpClients();
  const sid = String(body.sessionId);
  const walletAddr = String(body.wallet || '').toLowerCase();
  const sess = mpSessions.get(sid);
  if (sess && walletAddr && sess.players.map(String).map((x) => x.toLowerCase()).indexOf(walletAddr) === -1) {
    return { ok: false, reason: 'not your session' };
  }
  if (!sess) {
    try {
      const paid = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] });
      if (!paid) return { ok: false, reason: 'session not found on-chain' };
      return { ok: false, reason: 'mid-game moves are midchain state and never on Arc. This relay instance restarted and lost the signed log, so start a new match; if it was settled, the result is committed on-chain.' };
    } catch (e) {
      return { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) };
    }
  }
  return {
    ok: true, sessionId: sid, seatCount: sess.seatCount, status: sess.status, code: sess.code,
    players: sess.players, sessionKeys: sess.sessionKeys, seedCommit: sess.seedCommit,
    sponsorAddress: mpClients().account.address, startHash: sess.startHash,
    finalHash: sess.lastHash, settled: !!sess.settleTx, moves: sess.moves,
    view: mpViewOf(sess),
  };
}

/// MPSETTLE: commit the match + credit every earning seat, then close the core
/// session. body.sigs = [{seat, sig}] from the seats that signed (winner alone
/// suffices; the loser does nothing). Each signature is verified against that
/// seat's committed session key before anything is sent. The relay signs
/// nothing here.
async function doMpSettle(body) {
  const sess = mpNeedSession(body);
  const pairs = Array.from(body.sigs || []);
  if (!pairs.length) throw new Error('at least the winner seat must sign');
  return mpFireSettle(sess, pairs);
}

/// Shared settle executor: verifies seat signatures, commits the game with its
/// move timestamps (contract timer check), then closes the core session with
/// only the seats that signed. No loser cooperation needed.
async function mpFireSettle(sess, pairs) {
  const { account, pub, wallet } = mpClients();
  if (sess.status === 2) return { tx: sess.settleTx, coreTx: sess.coreSettleTx || null, already: true };
  const finalHash = await mpGameRead(pub, 'hashState', [sess.state]);
  const digest = await pub.readContract({ address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] });
  const sigs = [];
  const signers = [];
  const seen = {};
  for (const p of pairs) {
    const seat = Number(p.seat);
    if (!(seat >= 0 && seat < sess.seatCount) || seen[seat]) continue;
    seen[seat] = true;
    let got = '';
    try { got = await recoverAddress({ hash: digest, signature: p.sig }); } catch (e) { throw new Error('unparseable signature for seat ' + seat); }
    if (got.toLowerCase() !== String(sess.sessionKeys[seat]).toLowerCase()) throw new Error('bad signature for seat ' + seat);
    sigs.push(p.sig);
    signers.push(sess.sessionKeys[seat]);
  }
  if (!sigs.length) throw new Error('no valid seat signature');
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  const game = {
    turn: d.turn,
    seats: d.seatCount,
    step: sess.moves.length,
    board: sess.state,
    boardHash: finalHash,
    over: d.finishCount >= need,
  };
  const moveTss = [BigInt(sess.handoverTs || 0)].concat(sess.tss.map((t) => BigInt(t)));
  const rGame = await send(wallet, pub, {
    address: MP_ADDR.GFGGames, abi: mpGamesAbi, functionName: 'settle',
    args: [sess.sessionId, [game], sess.players, MP_GAME_TAG, moveTss],
    account,
  });
  let coreTx = null;
  let coreSettleError = null;
  let coreCost = 0n;
  try {
    const rCore = await send(wallet, pub, {
      address: MP_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'settle',
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

/// MPSIGN: a seat posts its final-hash signature (signed silently on its own
/// device with its own in-memory key). Stored after verification. When the
/// WINNER signature arrives on a terminal board, the relay auto-fires settle
/// immediately, so the loser does nothing and the game never waits on them.
async function doMpSign(body) {
  const sess = mpNeedSession(body);
  if (sess.status === 2) return { stored: true, settled: true, tx: sess.settleTx };
  const seat = Number(body.seat);
  if (!(seat >= 0 && seat < sess.seatCount)) throw new Error('unknown seat');
  mpSeatGate(sess, body, seat);
  sess.sigs[seat] = String(body.sig || '');
  const d = decodeState(sess.state);
  const need = d.seatCount === 2 ? 1 : 3;
  const over = d.finishCount >= need;
  if (over && d.order[0] === seat) {
    const pairs = Object.keys(sess.sigs).map((s) => ({ seat: Number(s), sig: sess.sigs[s] })).filter((p) => !!p.sig);
    const r = await mpFireSettle(sess, pairs);
    return { stored: true, settled: true, ...r };
  }
  return { stored: true, settled: false, seatsSigned: Object.keys(sess.sigs).length };
}

/// MPPOINTS: free read of a wallet's ludo-mp points + committed game count.
async function doMpPoints(body) {
  const { pub } = mpClients();
  const player = String(body.player || body.wallet || '');
  if (!player) return { points: '0' };
  const playersAbi = parseAbi(['function pointsOf(address player, bytes32 gameTag) view returns (uint64)']);
  const gamesAbiCount = parseAbi(['function gameCount(bytes32 sessionId) view returns (uint256)']);
  const points = await pub.readContract({ address: MP_ADDR.GFGPlayers, abi: playersAbi, functionName: 'pointsOf', args: [player, MP_GAME_TAG] });
  let committed = 0;
  try {
    if (body.sessionId) committed = Number(await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesAbiCount, functionName: 'gameCount', args: [String(body.sessionId)] }));
  } catch (e) { /* soft */ }
  return { points: points.toString(), committed };
}

/// MPGAME: free read of the last committed board of a settled session.
async function doMpGame(body) {
  const { pub } = mpClients();
  try {
    const count = Number(await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesAbi, functionName: 'gameCount', args: [String(body.sessionId)] }));
    if (!count) return { found: false };
    const list = await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesAbi, functionName: 'gamesOf', args: [String(body.sessionId)] });
    const last = list[list.length - 1];
    const dec = await pub.readContract({ address: MP_ADDR.GFGGames, abi: gamesRulesAbi, functionName: 'decodeState', args: [last.board] });
    return { found: true, gameCount: count, over: last.over, turn: dec[0], finishCount: dec[1], seatCount: dec[3], points: dec[6], boardHash: last.boardHash };
  } catch (e) { return { found: false, error: (e && (e.shortMessage || e.message)) || String(e) }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  try {
    let out;
    switch (body.action) {
      case 'demoCreate': out = await doDemoCreate(body); break;
      case 'demoRoll': out = await doDemoRoll(body); break;
      case 'demoMove': out = await doDemoMove(body); break;
      case 'demoPass': out = await doDemoPass(body); break;
      case 'demoBoard': out = await doDemoBoard(body); break;
      case 'demoMoves': out = await doDemoMoves(body); break;
      case 'demoDigest': out = await doDemoDigest(body); break;
      case 'demoSession': out = await doDemoSession(body); break;
      case 'demoSessions': out = await doDemoSessions(body); break;
      case 'walletSessions': out = await doWalletSessions(body); break;
      case 'demoRejoin': out = await doDemoRejoin(body); break;
      case 'demoGame': out = await doDemoGame(body); break;
      case 'demoSettle': out = await doDemoSettle(body); break;
      case 'mpCreate': out = await doMpCreate(body); break;
      case 'mpJoin': out = await doMpJoin(body); break;
      case 'mpLobby': out = await doMpLobby(body); break;
      case 'mpBegin': out = await doMpBegin(body); break;
      case 'mpRoll': out = await doMpRoll(body); break;
      case 'mpMove': out = await doMpMove(body); break;
      case 'mpPass': out = await doMpPass(body); break;
      case 'mpBoard': out = await doMpBoard(body); break;
      case 'mpMoves': out = await doMpMoves(body); break;
      case 'mpDigest': out = await doMpDigest(body); break;
      case 'mpSession': out = await doMpSession(body); break;
      case 'mpRejoin': out = await doMpRejoin(body); break;
      case 'mpSettle': out = await doMpSettle(body); break;
      case 'mpSign': out = await doMpSign(body); break;
      case 'mpPoints': out = await doMpPoints(body); break;
      case 'mpGame': out = await doMpGame(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = {
          address: account.address,
          sessionRegistry: ADDR.FoskaayGGI,
          games: ADDR.FoskaayGGIGames,
          players: ADDR.FoskaayGGIPlayers,
          ludo: ADDR.FoskaayGGILudo,
        };
        break;
      }
      default: res.status(400).json({ error: 'unknown action' }); return;
    }
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && (e.shortMessage || e.message)) || String(e) });
  }
}
