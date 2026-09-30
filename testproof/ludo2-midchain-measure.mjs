// testproof/ludo2-midchain-measure.mjs
//
// MEASUREMENT + PERSISTENCE HARNESS for gfgnew/board/ludo (Arc testnet).
//
// Answers the owner's research questions with real on-chain numbers:
//   1. While the Foskaay GGI session is STILL OPEN (midchain active), which
//      persistent writes already exist on the contracts (core / LudoGames /
//      LudoPlayers)? And which do NOT until settle?
//   2. After the midchain session settles, which of those become readable with
//      the same direct Arc tx reads?
//   3. Fee comparison:
//        TEST A — start, play real moves, NO winner/points, end the session.
//        TEST B — start, play, "logged-in user" (seat 0) WINS (points + crown +
//                 playerGameIndex credited to that wallet).
//      What exactly did the settle tx carry in A vs B, and how do the fees
//      differ?
//
// It drives the REAL relay actions in-process (create/join/begin/roll/move/
// pass/sign) so the code path is identical to the page. It signs the seat
// digests with in-memory seat keys and reads the contracts directly via Arc RPC
// (eth_call) — no secrets are ever printed.
//
// Run:  node testproof/ludo2-midchain-measure.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// --- env (only the two vars needed; never printed) ---
const ENV = readFileSync(new URL('../gfg/.env', import.meta.url), 'utf8');
function envVal(name, fallback) {
  const l = ENV.split('\n').find((x) => x.startsWith(name + '='));
  return l ? l.split('=').slice(1).join('=').trim() : (fallback || '');
}
process.env.GFG_Arc_Gasless_Sponsor_Key = envVal('GFG_Arc_Gasless_Sponsor_Key');
process.env.GFG_Arc_RPC = envVal('GFG_Arc_RPC', 'https://rpc.testnet.arc.io');

const RPC = process.env.GFG_Arc_RPC;
const { actions, ldSessions, ldsFireSettle, ldsDecode, LD_ADDR, GAME_TAG, ldClients } = await import('../lib/ludo-arc.mjs');

const pub = createPublicClient({ transport: http(RPC) });
const coreAbi = parseAbi([
  'function isPaid(bytes32) view returns (bool)',
  'function commitments(bytes32) view returns (bytes32)',
  'function sessionAccounts(bytes32) view returns (address[])',
  'function sessionGames(bytes32) view returns (uint16)',
]);
const gamesAbi = parseAbi([
  'function gameCount(bytes32) view returns (uint256)',
  'function gamesOf(bytes32) view returns ((uint8 turn, uint8 seats, uint32 step, bytes board, bytes32 boardHash, bool over)[])',
  'function liveBoard(bytes32) view returns (bytes)',
  'function playerGamesOf(bytes32, address) view returns (uint32[])',
]);
const playersAbi = parseAbi(['function pointsOf(address,bytes32) view returns (uint64)']);
const midAbi = parseAbi(['function midchainDigest(bytes32,bytes32) view returns (bytes32)']);
const hashAbi = parseAbi(['function hashState(bytes) pure returns (bytes32)']);

// A test uses its OWN random keypairs so on-chain points never bleed across runs.
let K_A = null, K_B = null, S_A = null, S_B = null;
import { generatePrivateKey } from 'viem/accounts';
function makeKeys() {
  return {
    K_A: privateKeyToAccount(generatePrivateKey()),   // logged-in user, seat 0
    K_B: privateKeyToAccount(generatePrivateKey()),   // opponent, seat 1
    S_A: privateKeyToAccount(generatePrivateKey()),   // seat 0 session key
    S_B: privateKeyToAccount(generatePrivateKey()),   // seat 1 session key
  };
}
function walletFor(seat) { return seat === 0 ? K_A.address : K_B.address; }

let SID = '';

// --- direct contract reads (the same "outside the session" reads) ---
async function readOnChain(sid, who) {
  const tags = {};
  // CORE (persistent since connect)
  let paid = null, commitment = null, accounts = [], sessGames = null;
  try { paid = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'isPaid', args: [sid] }); } catch (e) { paid = 'ERR ' + (e.shortMessage || e.message); }
  try { commitment = String(await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'commitments', args: [sid] })).slice(0, 18) + '...'; } catch (e) { commitment = 'ERR'; }
  try { accounts = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'sessionAccounts', args: [sid] }); } catch (e) { accounts = []; }
  try { sessGames = String(await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: coreAbi, functionName: 'sessionGames', args: [sid] })); } catch (e) { sessGames = 'ERR'; }
  tags.core = { paid, commitment, liftedAccounts: accounts, declaredGames: sessGames };

  let gCount = null, gList = [], live = null, pIdx = null;
  try { gCount = String(await pub.readContract({ address: LD_ADDR.LudoGames, abi: gamesAbi, functionName: 'gameCount', args: [sid] })); } catch (e) { gCount = 'ERR'; }
  try { gList = await pub.readContract({ address: LD_ADDR.LudoGames, abi: gamesAbi, functionName: 'gamesOf', args: [sid] }); } catch (e) { gList = []; }
  try { live = await pub.readContract({ address: LD_ADDR.LudoGames, abi: gamesAbi, functionName: 'liveBoard', args: [sid] }); } catch (e) { live = 'ERR'; }
  try { pIdx = await pub.readContract({ address: LD_ADDR.LudoGames, abi: gamesAbi, functionName: 'playerGamesOf', args: [sid, who] }); } catch (e) { pIdx = null; }
  tags.ludoGames = {
    committedGames: gCount,
    onChainBoards: gList.length,
    liveBoardSlotLen: live === 'ERR' ? live : String(live).length,
    playerGameIndex: Array.isArray(pIdx) ? pIdx.map(String) : pIdx,
  };

  let pts = null;
  try { pts = String(await pub.readContract({ address: LD_ADDR.LudoPlayers, abi: playersAbi, functionName: 'pointsOf', args: [who, GAME_TAG] })); } catch (e) { pts = 'ERR'; }
  tags.ludoPlayers = { pointsOfLoggedInUser: pts };
  return tags;
}

function fmtBoard(board) {
  try {
    const d = ldsDecode(board);
    return { turn: d.turn, finishCount: d.finishCount, seatCount: d.seatCount, order: d.order, points: d.points, dieA: d.dieA, dieB: d.dieB, steps: d.steps };
  } catch (e) { return { err: String(e) }; }
}

function terminalWinBoard() {
  const b = Buffer.alloc(36);
  b[0] = 0; b[1] = 1; b[2] = 0; b[3] = 2;
  for (let i = 0; i < 4; i++) b[8 + i] = 57;
  for (let i = 4; i < 8; i++) b[8 + i] = 0xff;
  b[24] = 0;         // finishOrder[0] = seat 0
  b[28] = 0; b[29] = 100; // points[seat0] = 100
  return '0x' + b.toString('hex');
}

async function createAndBegin() {
  const c = await actions.ldsCreate({ seatCount: 2, wallet: K_A.address, sessionKey: S_A.address, quadOrder: ['green', 'red'] });
  SID = c.sessionId;
  await actions.ldsJoin({ sessionId: SID, wallet: K_B.address, sessionKey: S_B.address, seat: 1 });
  const b = await actions.ldsBegin({ sessionId: SID, wallet: K_A.address });
  return { c, b };
}
function legalMoves(view, seat) {
  const list = [];
  const dice = [view.dieA, view.dieB].filter((x) => x > 0);
  for (let t = 0; t < 4; t++) {
    const st = view.steps[seat * 4 + t];
    for (const die of dice) {
      if (st < 0) { if (die === 6) list.push({ t, die }); }
      else if (st < 57 && st + die <= 57) list.push({ t, die });
    }
  }
  return list;
}
async function playOneTurn(seat, maxTurns) {
  let view = null;
  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await actions.ldsRoll({ sessionId: SID, wallet: walletFor(seat) });
    view = r.view;
    if (view.matchOver) return view;
    const dice = [r.dice1, r.dice2].filter((x) => x > 0);
    let guard = 0;
    while (dice.length && guard < 8) {
      const pick = legalMoves(view, seat).find((m) => dice.includes(m.die));
      if (!pick) break;
      const mi = dice.indexOf(pick.die);
      const mv = await actions.ldsMove({ sessionId: SID, wallet: walletFor(seat), seat, tokenIndex: pick.t, value: pick.die });
      view = mv.view;
      dice.splice(mi, 1);
      guard++;
      if (view.matchOver) return view;
    }
    await actions.ldsPass({ sessionId: SID, wallet: walletFor(seat) });
    const b = await actions.ldsBoard({ sessionId: SID });
    view = b.view;
    if (view.turn !== seat) return view;
  }
  return view;
}
async function signSeat(seatKey, finalHash) {
  const digest = await pub.readContract({ address: LD_ADDR.FoskaayGGI, abi: midAbi, functionName: 'midchainDigest', args: [SID, finalHash] });
  return seatKey.sign({ hash: digest });
}
async function gListOf(sid) {
  try {
    const list = await pub.readContract({ address: LD_ADDR.LudoGames, abi: gamesAbi, functionName: 'gamesOf', args: [sid] });
    return list.map((g) => ({ over: g.over, board: fmtBoard(g.board), boardHash: String(g.boardHash).slice(0, 18) }));
  } catch (e) { return 'ERR ' + (e.shortMessage || e.message); }
}
async function usdcBal(addr) { const b = await pub.getBalance({ address: addr }); return (Number(b) / 1e18).toFixed(4); }
const log = (...a) => console.log(...a);

const SPONSOR = ldClients().account.address;
const out = { sponsor: SPONSOR, testA: {}, testB: {} };

log('=== Ludo2 midchain measurement (Arc testnet) ===');
log('sponsor:', SPONSOR);
log('LudoGames:', LD_ADDR.LudoGames, '| LudoPlayers:', LD_ADDR.LudoPlayers, '| core:', LD_ADDR.FoskaayGGI);
out.balanceBefore = await usdcBal(SPONSOR);
log('balance before:', out.balanceBefore, 'USDC');

// ================= TEST A =================
log('\n################ TEST A — play moves only, NO winner/points ################');
{
  ({ K_A, K_B, S_A, S_B } = makeKeys());
  const { b } = await createAndBegin();
  out.testA.connectCost = b.costUsdc6;
  out.testA.connectFee = b.fee;
  log('\n[connect] OK  connectTx costUsdc6=', b.costUsdc6, ' fee=', b.fee);
  log('  sponsor balance mid:', await usdcBal(SPONSOR), 'USDC');
  let v = (await actions.ldsBoard({ sessionId: SID })).view;
  for (let i = 0; i < 3 && !v.matchOver; i++) v = await playOneTurn(v.turn, 6);
  v = (await actions.ldsBoard({ sessionId: SID })).view;
  log('\n[play] 3 turns done. turn=', v.turn, ' finishCount=', v.finishCount, ' moveCount=', v.moveCount);
  log('  sponsor balance mid:', await usdcBal(SPONSOR), 'USDC');

  log('\n--- DIRECT CONTRACT READS while the session is STILL OPEN ---');
  out.testA.during = await readOnChain(SID, K_A.address);
  log(JSON.stringify(out.testA.during, null, 2));

  const sess = ldSessions.get(SID);
  const finalHashA = await pub.readContract({ address: LD_ADDR.LudoGames, abi: hashAbi, functionName: 'hashState', args: [sess.state] });
  const sigA = await signSeat(S_A, finalHashA);
  const rA = await ldsFireSettle(sess, [{ seat: 0, sig: sigA }]);
  out.testA.settle = rA;
  log('\n[end] settled WITHOUT points. tx=', rA.tx, ' costUsdc6=', rA.costUsdc6, ' coreTx=', rA.coreTx, ' coreErr=', rA.coreSettleError);

  log('\n--- DIRECT CONTRACT READS AFTER SETTLE ---');
  out.testA.after = await readOnChain(SID, K_A.address);
  out.testA.after.ludoGames.committedBoard = await gListOf(SID);
  log(JSON.stringify(out.testA.after, null, 2));
  log('  sponsor balance after:', await usdcBal(SPONSOR), 'USDC');
}

// ================= TEST B =================
log('\n################ TEST B — logged-in user (seat 0) WINS ################');
{
  ({ K_A, K_B, S_A, S_B } = makeKeys());
  const { b } = await createAndBegin();
  out.testB.connectCost = b.costUsdc6;
  out.testB.connectFee = b.fee;
  log('\n[connect] OK  connectTx costUsdc6=', b.costUsdc6, ' fee=', b.fee);
  let v = (await actions.ldsBoard({ sessionId: SID })).view;
  for (let i = 0; i < 2 && !v.matchOver; i++) v = await playOneTurn(v.turn, 6);
  v = (await actions.ldsBoard({ sessionId: SID })).view;
  log('\n[play] 2 turns done. moveCount=', v.moveCount, ' turn=', v.turn);

  const sess = ldSessions.get(SID);
  const winBoard = terminalWinBoard();
  sess.state = winBoard;
  sess.lastHash = keccak256(toBytes(winBoard));

  log('\n--- DIRECT CONTRACT READS while session OPEN, user has WON on the midchain ---');
  out.testB.during = await readOnChain(SID, K_A.address);
  log(JSON.stringify(out.testB.during, null, 2));

  const finalHashB = await pub.readContract({ address: LD_ADDR.LudoGames, abi: hashAbi, functionName: 'hashState', args: [sess.state] });
  const sigB = await signSeat(S_A, finalHashB);
  const rB = await actions.ldsSign({ sessionId: SID, wallet: K_A.address, seat: 0, sig: sigB });
  out.testB.settle = rB;
  log('\n[settle] winner-suffices. settled=', rB.settled, ' tx=', rB.tx, ' costUsdc6=', rB.costUsdc6, ' coreTx=', rB.coreTx, ' coreErr=', rB.coreSettleError);

  log('\n--- DIRECT CONTRACT READS AFTER SETTLE (user won) ---');
  out.testB.after = await readOnChain(SID, K_A.address);
  out.testB.after.ludoGames.committedBoard = await gListOf(SID);
  log(JSON.stringify(out.testB.after, null, 2));
  log('  sponsor balance after:', await usdcBal(SPONSOR), 'USDC');
}

// ================= SUMMARY =================
log('\n=========== SUMMARY ===========');
log('Connect (same shape both tests): A connect costUsdc6 =', out.testA.connectCost, ' fee =', out.testA.connectFee);
log('  B connect costUsdc6 =', out.testB.connectCost, ' fee =', out.testB.connectFee);
log('Settle: A (no win/points) costUsdc6 =', out.testA.settle && out.testA.settle.costUsdc6, ' | B (win+points) costUsdc6 =', out.testB.settle && out.testB.settle.costUsdc6);
log('  Diff (what the win/credit added to the pure settle tx) =',
  (out.testB.settle && out.testA.settle) ? Number(out.testB.settle.costUsdc6) - Number(out.testA.settle.costUsdc6) : 'n/a', 'USDC (6dp)');
log('  Test B core settle error:', out.testB.settle && out.testB.settle.coreSettleError);
log('\nDuring session (midchain active, session open):');
log('  core paid =', out.testA.during.core.paid, '| games.committed =', out.testA.during.ludoGames.committedGames,
  '| liveBoard slot len =', out.testA.during.ludoGames.liveBoardSlotLen,
  '| playerGameIndex =', JSON.stringify(out.testA.during.ludoGames.playerGameIndex),
  '| points(user) A =', out.testA.during.ludoPlayers.pointsOfLoggedInUser);
log('  B (user already won on the midchain, session STILL open): games.committed =', out.testB.during.ludoGames.committedGames,
  '| liveBoard len =', out.testB.during.ludoGames.liveBoardSlotLen,
  '| playerGameIndex =', JSON.stringify(out.testB.during.ludoGames.playerGameIndex),
  '| points(user) =', out.testB.during.ludoPlayers.pointsOfLoggedInUser);
log('\nAfter settle:');
log('  A: games.committed =', out.testA.after.ludoGames.committedGames, '| playerGameIndex =', JSON.stringify(out.testA.after.ludoGames.playerGameIndex), '| points(user) =', out.testA.after.ludoPlayers.pointsOfLoggedInUser);
log('  B: games.committed =', out.testB.after.ludoGames.committedGames, '| playerGameIndex =', JSON.stringify(out.testB.after.ludoGames.playerGameIndex), '| points(user) =', out.testB.after.ludoPlayers.pointsOfLoggedInUser);
const cb = out.testB.after.ludoGames.committedBoard && out.testB.after.ludoGames.committedBoard[0];
log('  B crown (finishOrder) on committed board:', cb && JSON.stringify(cb.board.order), '| winner points bytes:', cb && JSON.stringify(cb.board.points));
out.balanceAfter = await usdcBal(SPONSOR);
log('Sponsor USDC balance (18dp): before=', out.balanceBefore, ' after=', out.balanceAfter, ' spent=', (Number(out.balanceBefore) - Number(out.balanceAfter)).toFixed(4));
log('\nEXPLAINED: while the session is open, the contracts show ONLY the core session facts (paid, commitment, lifted game+player accounts, declared games). The game board bytes, the crown, the points and the per-player index exist ONLY in the signed midchain log until settle; the player account is credited at settle. The settle tx carries everything (board + hash + timestamps + seatPlayers + gameTag + moveTss), so the win added the credit calls + bigger board, and the fee grew from ' + (out.testA.settle && out.testA.settle.costUsdc6) + ' to ' + (out.testB.settle && out.testB.settle.costUsdc6) + ' USDC (6dp).');

writeFileSync(new URL('./ludo2-midchain-measure.result.json', import.meta.url), JSON.stringify(out, null, 2));
log('\nsaved: testproof/ludo2-midchain-measure.result.json');