// scripts/foskaay-ggi-midchain-test.mjs — drive one Ludo match through the
// Foskaay GGI Midchain relay: connect (tx), free rolls/moves/passes (eth_call),
// settle (tx). Prints the real cost and the on-chain links.
import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http, formatUnits, getAddress } from 'viem';

const rec = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/foskaay-ggi/deployments/arc-testnet.json', 'utf8'));
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rec.rpc] } } });
const pub = createPublicClient({ chain, transport: http(rec.rpc) });
const erc20 = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const SPONSOR = getAddress('0xAd0A4348C7202E44e96c3FAE1cBB0B645dD86EB4');
const bal = () => pub.readContract({ address: rec.usdc, abi: erc20, functionName: 'balanceOf', args: [SPONSOR] });
const URL = 'http://localhost:8787/api/foskaay-ggi-sponsor';
const call = async (action, extra) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(action + ': ' + JSON.stringify(j));
  return j;
};
const usdc = (x) => formatUnits(BigInt(x || 0), 6);

(async () => {
  const before = await bal();
  const created = await call('demoCreate', { seatCount: 2, userSeat: 0, user: SPONSOR });
  const sid = created.sessionId;
  console.log('connect (tx):', created.connectTx, 'cost', usdc(created.costUsdc6), 'USDC | fee', formatUnits(BigInt(created.fee), 18));
  let free = 0, view = created.view;
  for (let ply = 0; ply < 60 && !view.matchOver; ply++) {
    const roll = await call('demoRoll', { sessionId: sid }); free++;
    view = roll.view;
    let dice = [roll.dice1, roll.dice2];
    const seat = view.turn;
    for (const die of dice) {
      let tks = view.steps.slice(seat * 4, seat * 4 + 4);
      let moved = false;
      for (let t = 0; t < 4 && !moved; t++) {
        const s = tks[t];
        const legal = s === -1 ? die === 6 : (s < 57 && s + die <= 57);
        if (!legal) continue;
        try { const mv = await call('demoMove', { sessionId: sid, seat, tokenIndex: t, value: die }); free++; view = mv.view; moved = true; } catch (_) {}
      }
    }
    const ps = await call('demoPass', { sessionId: sid }); free++; view = ps.view;
  }
  console.log('played', free, 'FREE midchain calls (rolls+moves+passes), 0 transactions');
  console.log('finishCount:', view.finishCount, 'winner:', view.winner, 'points:', JSON.stringify(view.points));

  const settled = await call('demoSettle', { sessionId: sid });
  const after = await bal();
  console.log('settle  (tx):', settled.tx, 'cost', usdc(settled.costUsdc6), 'USDC');
  console.log('\n=== MATCH COST ===');
  console.log('  2 transactions (connect + settle)');
  console.log('  total:', usdc(before - after), 'USDC  ->', (1 / Number(usdc(before - after))).toFixed(1), 'games per $1');
  console.log('  links: https://explorer.testnet.arc.io/tx/' + created.connectTx);
  console.log('         https://explorer.testnet.arc.io/tx/' + settled.tx);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
