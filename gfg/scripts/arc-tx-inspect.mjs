// scripts/arc-tx-inspect.mjs — inspect specific Arc txs: status, revert reason,
// logs/events, gas. Read-only (free).
import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http, getAddress } from 'viem';
const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const c = defineChain({ id: evm.chainId, name: evm.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [evm.rpc] } } });
const pub = createPublicClient({ chain: c, transport: http(evm.rpc) });

const hashes = process.argv.slice(2);
if (!hashes.length) { console.log('usage: node scripts/arc-tx-inspect.mjs <txhash> [<txhash> ...]'); process.exit(1); }

for (const h of hashes) {
  console.log('\n===== ' + h + ' =====');
  let tx;
  try { tx = await pub.getTransaction({ hash: h }); } catch (e) { console.log('  getTransaction failed:', e.message); continue; }
  console.log('  to        ', tx.to);
  console.log('  from      ', tx.from);
  console.log('  value     ', tx.value?.toString());
  console.log('  nonce     ', tx.nonce, '| gas', tx.gas?.toString());
  console.log('  input sel ', tx.input ? tx.input.slice(0, 10) : '');
  let rc;
  try { rc = await pub.waitForTransactionReceipt({ hash: h }); } catch (e) { console.log('  receipt failed:', e.message); continue; }
  console.log('  status    ', rc.status, rc.status === 'success' ? '(LANDED)' : '(REVERTED)');
  console.log('  block     ', rc.blockNumber, '| gasUsed', rc.gasUsed?.toString());
  if (rc.logs && rc.logs.length) {
    console.log('  events    ', rc.logs.length);
    for (const l of rc.logs) console.log('    topic0', l.topics[0], '| addr', l.address);
  } else {
    console.log('  events    none');
  }
}
