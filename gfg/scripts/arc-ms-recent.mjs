// scripts/arc-ms-recent.mjs — list recent MatchSettlement txs (start/settle),
// with status (success/reverted), so a failed one can be identified.
import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http } from 'viem';
const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const c = defineChain({ id: evm.chainId, name: evm.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [evm.rpc] } } });
const pub = createPublicClient({ chain: c, transport: http(evm.rpc) });
const MS = evm.contracts.matchSettlement;
const GR = evm.contracts.gameRegistry;

const latest = await pub.getBlockNumber();
console.log('latest block', latest.toString(), '| MatchSettlement', MS);
// Walk back and inspect blocks that touched either contract.
const targets = new Set([MS.toLowerCase(), GR.toLowerCase()]);
let seen = 0;
let to = latest;
for (let r = 0; r < 6 && to > 0n && seen < 12; r++) {
  const from = to > 2000n ? to - 2000n : 0n;
  let logs = [];
  try {
    logs = await pub.getLogs({ address: [MS, GR], fromBlock: from, toBlock: to });
  } catch (e) { console.log('  getLogs err', e.message); break; }
  const byTx = new Map();
  for (const l of logs) byTx.set(l.transactionHash, { block: l.blockNumber, addr: l.address });
  const hashes = [...byTx.keys()].reverse();
  for (const h of hashes) {
    if (seen >= 12) break;
    const info = byTx.get(h);
    let rc;
    try { rc = await pub.getTransactionReceipt({ hash: h }); } catch (e) { continue; }
    let tx;
    try { tx = await pub.getTransaction({ hash: h }); } catch (e) { tx = {}; }
    seen++;
    console.log('---');
    console.log('  tx     ', h);
    console.log('  status ', rc.status, '| block', rc.blockNumber.toString(), '| gasUsed', rc.gasUsed.toString());
    console.log('  to     ', info.addr, info.addr.toLowerCase() === MS.toLowerCase() ? '(MatchSettlement)' : '(GameRegistry)');
    console.log('  sel    ', tx.input ? tx.input.slice(0, 10) : '');
    console.log('  events ', rc.logs.length, rc.logs.map(l => l.topics[0].slice(0, 18)).join(' '));
  }
  if (from === 0n) break;
  to = from - 1n;
}
