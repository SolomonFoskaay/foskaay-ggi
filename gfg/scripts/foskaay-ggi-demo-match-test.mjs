import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http, formatUnits, getAddress } from 'viem';

const rec = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/foskaay-ggi/deployments/arc-testnet.json', 'utf8'));
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rec.rpc] } } });
const pub = createPublicClient({ chain, transport: http(rec.rpc) });
const erc20 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
const SPONSOR = getAddress('0xAd0A4348C7202E44e96c3FAE1cBB0B645dD86EB4');
const bal = async () => await pub.readContract({ address: rec.usdc, abi: erc20, functionName: 'balanceOf', args: [SPONSOR] });

const URL = 'http://localhost:8787/api/foskaay-ggi-sponsor';
const call = async (action, extra) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(action + ' failed: ' + JSON.stringify(j));
  return j;
};
const ymd = (x) => formatUnits(x, 6);

(async () => {
  const before = await bal();
  const matchRef = Date.now();
  let txCount = 0; let txCost = 0n; let freeCalls = 0;
  let log = [];

  // REPLAY mode: settle re-verifies the whole log on-chain. Tampering is rejected.
  const created = await call('demoCreate', { matchRef, seatCount: 2, userSeat: 0, user: SPONSOR, verifyMode: 1 });
  txCount++; txCost += BigInt(created.costUsdc6 || 0);
  console.log('connect (tx):', created.tx, 'cost', ymd(BigInt(created.costUsdc6 || 0)), 'USDC  seat', created.userSeat, 'mode', created.verifyMode);
  const during = await bal();
  console.log('balance after connect:', ymd(during));

  let board = created.board;
  for (let ply = 0; ply < 40 && board.finishCount === 0; ply++) {
    const roll = await call('demoRoll', { matchRef, log }); freeCalls++;
    log = roll.log;
    const dice = [roll.dice1, roll.dice2];
    const seat = roll.turn;
    const tks = roll.board.stepsWalked.slice(seat * 4, seat * 4 + 4);
    let didMove = false;
    for (let d = 0; d < 2 && !didMove; d++) {
      const die = dice[d];
      for (let t = 0; t < 4 && !didMove; t++) {
        const s = tks[t];
        const legal = s === -1 ? die === 6 : (s < 57 && s + die <= 57);
        if (!legal) continue;
        try {
          const mv = await call('demoMove', { matchRef, log, seat, tokenIndex: t, steps: die });
          freeCalls++; log = mv.log; didMove = true;
        } catch (_) { /* illegal under the contract's rules; skip */ }
      }
    }
    const ps = await call('demoPass', { matchRef, log }); freeCalls++; log = ps.log;
    board = ps.board;
    if (board.finishCount > 0) break;
  }
  console.log('played', freeCalls, 'FREE midchain calls (rolls+moves+passes),', log.length, 'log entries, 0 transactions');
  console.log('finishCount:', board.finishCount, 'winner:', board.winner);

  const settled = await call('demoSettle', { matchRef, log, sessionId: created.sessionId });
  txCount++; txCost += BigInt(settled.costUsdc6 || 0);
  console.log('settle (tx):', settled.tx, 'cost', ymd(BigInt(settled.costUsdc6 || 0)), 'USDC');

  const board2 = await call('demoBoard', { matchRef, log, user: SPONSOR });
  const after = await bal();
  console.log('\n=== MATCH COST (this run) ===');
  console.log('  transactions   :', txCount, '(connect + settle)');
  console.log('  free calls     :', freeCalls);
  console.log('  tx gas total   :', ymd(txCost), 'USDC');
  console.log('  balance before :', ymd(before), 'USDC');
  console.log('  balance after  :', ymd(after), 'USDC');
  console.log('  actual delta   :', ymd(before - after), 'USDC');
  console.log('  crown on-chain :', board2.crown, '(255 = no winner)');
  console.log('  user points    :', JSON.stringify(board2.userPoints));
})().catch((e) => { console.error('match test failed:', e.message); process.exit(1); });
