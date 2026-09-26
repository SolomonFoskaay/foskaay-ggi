// scripts/arc-diag-history.mjs — diagnose: does the start commit reach the chain,
// and will the history endpoint produce a row for the player?
import { readFileSync } from 'fs';
import { createPublicClient, defineChain, http, parseAbi, keccak256 } from 'viem';
const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const c = defineChain({ id: evm.chainId, name: evm.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [evm.rpc] } } });
const pub = createPublicClient({ chain: c, transport: http(evm.rpc) });
const MS = evm.contracts.matchSettlement;
const msAbi = parseAbi(['function matchOf(bytes32) view returns (address,address,bytes32,bytes32,bytes32,uint64,uint64,uint32,uint16,uint8,bool,bool)']);
const startedTopic = keccak256(Buffer.from('MatchStarted(bytes32,address,address,uint16,uint8,bytes32,uint64)'));
const settledTopic = keccak256(Buffer.from('MatchSettled(bytes32,bytes32,bytes32,uint32,uint64)'));

const latest = await pub.getBlockNumber();
let to = latest;
const starts = [], settles = [];
for (let r = 0; r < 8 && to > 0n; r++) {
  const from = to > 9000n ? to - 9000n : 0n;
  let logs = [];
  try { logs = await pub.getLogs({ address: MS, fromBlock: from, toBlock: to }); } catch (e) { break; }
  for (const l of logs) {
    if (l.topics[0] === startedTopic) starts.push(l);
    else if (l.topics[0] === settledTopic) settles.push(l);
  }
  if (from === 0n) break;
  to = from - 1n;
}
console.log('MatchStarted events:', starts.length, '| MatchSettled events:', settles.length);
for (const l of starts.slice(-5)) {
  const gameId = l.topics[1];
  const p1 = '0x' + l.topics[2].slice(26), p2 = '0x' + l.topics[3].slice(26);
  let m = null;
  try { m = await pub.readContract({ address: MS, abi: msAbi, functionName: 'matchOf', args: [gameId] }); } catch (e) { /* ignore */ }
  console.log('start gameId', gameId.slice(0, 22) + '...');
  console.log('   p1', p1, '| p2', p2, '| settled', m ? m[10] : '?', '| moves', m ? m[7] : '?');
  console.log('   tx', l.transactionHash);
}
if (!starts.length) console.log('NO start commits found in the scanned range.');
if (!settles.length) console.log('NO settlements found yet (expected if no match has finished a flush window).');
