// scripts/foskaay-ggi-cost-breakdown.mjs — exact per-component cost of one Ludo
// demo match on Arc testnet: the rail fee, every transaction's gas, and how the
// settle replay scales with the number of moves. Uses the local relay.
import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http, formatUnits, getAddress } from 'viem';

const rec = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/foskaay-ggi/deployments/arc-testnet.json', 'utf8'));
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rec.rpc] } } });
const pub = createPublicClient({ chain, transport: http(rec.rpc) });
const URL = 'http://localhost:8787/api/foskaay-ggi-sponsor';
const call = async (action, extra) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(action + ': ' + JSON.stringify(j));
  return j;
};
const usdc6 = (x) => formatUnits(x, 6);          // 6dp display
const gwei = (p) => (Number(p || 0) / 1e9).toFixed(2) + ' Gwei';

async function tx(label, hash) {
  const rc = await pub.waitForTransactionReceipt({ hash });
  const gasUsed = rc.gasUsed;
  const price = rc.effectiveGasPrice || 0n;
  const cost = (gasUsed * price) / 1_000_000_000_000n; // 18dp -> 6dp USDC
  console.log('  ' + label.padEnd(26) + ' gas=' + String(gasUsed).padStart(9) + '  price=' + gwei(price).padStart(12) + '  cost=' + usdc6(cost).padStart(12) + ' USDC');
  return { gasUsed, price, cost };
}

async function playMatch(plies) {
  const matchRef = Date.now();
  let log = [];
  const created = await call('demoCreate', { matchRef, seatCount: 2, userSeat: 0, user: rec.sponsor || '0xAd0A4348C7202E44e96c3FAE1cBB0B645dD86EB4', verifyMode: 1 });
  let board = created.board;
  for (let p = 0; p < plies && board.finishCount === 0; p++) {
    const roll = await call('demoRoll', { matchRef, log }); log = roll.log;
    const seat = roll.turn;
    const tks = roll.board.stepsWalked.slice(seat * 4, seat * 4 + 4);
    for (let d = 0; d < 2; d++) {
      const die = [roll.dice1, roll.dice2][d];
      for (let t = 0; t < 4; t++) {
        const s = tks[t];
        const legal = s === -1 ? die === 6 : (s < 57 && s + die <= 57);
        if (!legal) continue;
        try { const mv = await call('demoMove', { matchRef, log, seat, tokenIndex: t, steps: die }); log = mv.log; break; } catch (_) {}
      }
    }
    const ps = await call('demoPass', { matchRef, log }); log = ps.log; board = ps.board;
  }
  const settled = await call('demoSettle', { matchRef, log, sessionId: created.sessionId });
  return { created, settled, entries: log.length };
}

(async () => {
  console.log('Arc gas price (live):', gwei(await pub.getGasPrice()));
  const fee18 = await pub.readContract({ address: getAddress(rec.contracts.FeeVault), abi: [{ name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'fee' });
  console.log('Rail fee (FeeVault.fee):', formatUnits(fee18, 18), 'USDC\n');

  for (const plies of [12, 80]) {
    console.log('=== MATCH with ~' + plies + ' plies ===');
    const { created, settled, entries } = await playMatch(plies);
    console.log('  log entries:', entries, '| relay connect cost:', usdc6(BigInt(created.costUsdc6)), '| relay settle cost:', usdc6(BigInt(settled.costUsdc6)));
    const h = await tx('connect: handover (+fee)', created.connectTx);
    const c = await tx('connect: createMatch', created.tx);
    const s = await tx('settle: settleMatch(replay)', settled.tx);
    const r = await tx('settle: rail settle', settled.railTx);
    const fee = await pub.readContract({ address: getAddress(rec.contracts.FeeVault), abi: [{ name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'fee' });
    const fee6 = fee / 1_000_000_000_000n;
    const totalGas = h.cost + c.cost + s.cost + r.cost;
    const total = totalGas + fee6;
    console.log('  gas subtotal :', usdc6(totalGas), 'USDC');
    console.log('  rail fee     :', usdc6(fee6), 'USDC');
    console.log('  MATCH TOTAL  :', usdc6(total), 'USDC  ->  ' + (1 / Number(usdc6(total))).toFixed(1) + ' games per $1');
    console.log('  settle replay gas per log entry:', (Number(s.gasUsed) / entries).toFixed(0));
    console.log('');
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
