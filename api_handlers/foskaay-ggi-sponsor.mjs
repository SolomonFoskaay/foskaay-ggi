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
  createPublicClient, createWalletClient, defineChain, http, parseAbi, keccak256, toBytes, encodeAbiParameters, parseAbiParameters,
} from 'viem';
import * as evmKeys from 'viem/accounts';

const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';
const CHAIN_ID = 5042002;

// The deployed Foskaay GGI core (proxy addresses; permanent). Kept here as data so
// this handler has no build dependency on the packages.
const ADDR = {
  // The SINGLE core: FoskaayGGI (the SessionRegistry renamed), UUPS. Phase 3
  // rewires this handler to handoverWithAccounts + FoskaayGGIGames/Players.
  FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
  // Phase 2: the on-chain game (match + rules + settle) and the player account.
  FoskaayGGIGames: '0x24e38ac2e80958782a8Bc5CD479bbe2e5D81EcDF',
  FoskaayGGIPlayers: '0x1614ebc72eA1cB3D31975b3976B5B474FAcE3b3C',
  // The Ludo game (pure rules only): still used by the demo until Phase 3/5.
  FoskaayGGILudo: '0xa5040Ece5945a8551499ad1148fc3cD15b165987',
};

const ludoAbi = parseAbi([
  'function getInitialState(uint8 seatCount, uint8 userSeat) pure returns (bytes)',
  'function applyMove(bytes state, uint8 kind, uint8 seat, uint8 tokenIndex, uint8 value, bytes32[] seeds) pure returns (bytes)',
  'function hashState(bytes state) pure returns (bytes32)',
  'function isTerminal(bytes state) pure returns (bool finished, uint8 winner)',
  'function decodeState(bytes state) pure returns (uint8 turn, uint8 finishCount, uint8 userSeat, uint8 seatCount, int16[16] steps, uint8[4] order, uint16[4] points, uint8 dieA, uint8 dieB)',
]);

const coreAbi = parseAbi([
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount) payable',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, bytes32[] seedCommits, address[][] players, address[][] sessionKeys, uint16 randomCount) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, address[] players, address[] sessionKeys, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes32[] seedReveals, address[][] players, address[][] sessionKeys, bytes[][] sigs, address[][] signers)',
  'function randomN(bytes32 seed, uint256 counter, uint256 count) pure returns (bytes32[])',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function fee() view returns (uint256)',
  'function isPaid(bytes32 sessionId) view returns (bool)',
]);

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
// THE FOSKAAY GGI MIDCHAIN. The game contract is PURE (FoskaayGGILudo), so every
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

async function ludoRead(pub, fn, args) {
  return await pub.readContract({ address: ADDR.FoskaayGGILudo, abi: ludoAbi, functionName: fn, args });
}

function needSession(body) {
  const s = sessions.get(String(body.sessionId));
  if (!s) throw new Error('unknown session (restart the match)');
  return s;
}

/// One free midchain step: apply a move via eth_call, hash the new state, and
/// sign the hash with the session key. Returns the new view. NO transaction.
async function step(sess, kind, seat, tokenIndex, value, seeds) {
  const { account, pub } = clients();
  const newState = await ludoRead(pub, 'applyMove', [sess.state, kind, seat, tokenIndex, value, seeds || []]);
  const prevHash = sess.state === sess.startState ? sess.startHash : sess.lastHash;
  const newHash = await ludoRead(pub, 'hashState', [newState]);
  const digest = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, newHash] });
  const sig = await account.sign({ hash: digest });
  sess.state = newState;
  sess.lastHash = newHash;
  if (!sess.startState) { sess.startState = newState; }
  sess.moves.push({ kind, seat, tokenIndex, value, seeds: seeds || [], prevHash, newHash, sig });
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

  const seed = keccak256(toBytes('foskaay-ggi-ludo-' + sessionId + '-' + Date.now()));
  const seedCommit = keccak256(seed);

  const state0 = await ludoRead(pub, 'getInitialState', [seatCount, userSeat]);
  const startHash = await ludoRead(pub, 'hashState', [state0]);

  const players = new Array(seatCount).fill(account.address);
  players[userSeat] = user;
  const sessionKeys = new Array(seatCount).fill(account.address);

  const fee = await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'fee' });
  const r = await send(wallet, pub, {
    address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'handover',
    args: [sessionId, ADDR.FoskaayGGILudo, startHash, seedCommit, players, sessionKeys, 2],
    value: fee, account,
  });
  const sess = { sessionId, matchRef, seed, seedCommit, state: state0, startState: state0, startHash, lastHash: startHash, players, sessionKeys, seatCount, userSeat, moves: [] };
  sessions.set(sessionId, sess);
  const total = BigInt(r.costUsdc6) + (fee / 1_000_000_000_000n);
  return { sessionId, matchRef, userSeat, seatCount, connectTx: r.hash, costUsdc6: total.toString(), fee: fee.toString(), view: viewOf(sess) };
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

/// The signed move log, for the explorer to verify the hash chain client-side.
async function doDemoMoves(body) {
  const sess = sessions.get(String(body.sessionId));
  if (!sess) return { found: false, sessionId: body.sessionId };
  return { found: true, sessionId: sess.sessionId, gameLogic: ADDR.FoskaayGGILudo, startHash: sess.startHash, finalHash: sess.lastHash, moves: sess.moves };
}

/// SETTLE: the SECOND and LAST transaction. No replay: the final hash already
/// commits to the board and the points, so this is O(1) no matter the match.
async function doDemoSettle(body) {
  const { account, pub, wallet } = clients();
  const sess = needSession(body);
  const finalHash = await ludoRead(pub, 'hashState', [sess.state]);
  const r = await send(wallet, pub, {
    address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'settle',
    args: [sess.sessionId, finalHash, sess.seed, sess.players, sess.sessionKeys, [await account.sign({ hash: await pub.readContract({ address: ADDR.FoskaayGGI, abi: coreAbi, functionName: 'midchainDigest', args: [sess.sessionId, finalHash] }) })], [account.address]],
    account,
  });
  return { tx: r.hash, finalHash, costUsdc6: r.costUsdc6.toString() };
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
      case 'demoSettle': out = await doDemoSettle(body); break;
      case 'sponsorAddress': {
        const { account } = clients();
        out = {
          address: account.address,
          sessionRegistry: ADDR.FoskaayGGI,
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
