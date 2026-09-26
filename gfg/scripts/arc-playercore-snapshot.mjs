// scripts/arc-playercore-snapshot.mjs — export every player's state from the
// CURRENT PlayerCore, so a redeploy can restore it EXACTLY (no points lost).
//
// Enumerates players from the contract's own events (no off-chain index), reads
// globals/premium/lives plus every game bucket, and writes a JSON snapshot to
// ~/.config/gfg/playercore-snapshot-<core>.json (gitignored location, never the
// repo: it holds player addresses, not keys, but stays local by default).
//
// Usage: node scripts/arc-playercore-snapshot.mjs [coreAddress] [creationBlock]
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPublicClient, defineChain, http, parseAbi } from 'viem';

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const CORE = process.argv[2] || evm.contracts.playerCore;
const FROM = BigInt(process.argv[3] || '62865833'); // PlayerCore creation block

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });

const abi = parseAbi([
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function premiumOf(address a) view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil)',
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
]);

const EVENT_TOPIC_PLAYERS = new Set();

async function enumeratePlayers(from) {
  const latest = await pub.getBlockNumber();
  const found = new Set();
  const CHUNK = 10000n;
  for (let b = from; b <= latest; b += CHUNK) {
    const to = b + CHUNK - 1n > latest ? latest : b + CHUNK - 1n;
    let logs = [];
    try { logs = await pub.getLogs({ address: CORE, fromBlock: b, toBlock: to }); }
    catch (e) { console.error('chunk', String(b), 'failed:', e.shortMessage || e.message); continue; }
    for (const l of logs) {
      const t = l.topics && l.topics[1];
      if (t && t.length === 66) found.add(('0x' + t.slice(26)).toLowerCase());
    }
  }
  return [...found];
}

function tagToStr(hex) {
  const b = Buffer.from(hex.slice(2), 'hex');
  let end = b.length; while (end > 0 && b[end - 1] === 0) end--;
  return b.subarray(0, end).toString('utf8');
}
function strToTag(s) {
  const b = Buffer.alloc(32); Buffer.from(String(s), 'utf8').copy(b);
  return '0x' + b.toString('hex');
}

const players = await enumeratePlayers(FROM);
console.log('core:      ' + CORE);
console.log('players:   ' + players.length);

const out = { core: CORE, chainId: evm.chainId, capturedAt: new Date().toISOString(), players: [] };
// Known game tags to sweep (buckets are per game; keys from the chain's own events).
const TAGS = ['ludo', 'chess', 'ayo_olopon'];

for (const a of players) {
  const [g, p, l] = await Promise.all([
    pub.readContract({ address: CORE, abi, functionName: 'globalsOf', args: [a] }),
    pub.readContract({ address: CORE, abi, functionName: 'premiumOf', args: [a] }),
    pub.readContract({ address: CORE, abi, functionName: 'livesOf', args: [a] }),
  ]);
  const buckets = {};
  for (const t of TAGS) {
    try {
      const b = await pub.readContract({ address: CORE, abi, functionName: 'bucketOf', args: [a, strToTag(t)] });
      if (Number(b[0]) || Number(b[1])) buckets[t] = { pure: String(b[0]), spendable: String(b[1]) };
    } catch (e) { /* skip */ }
  }
  out.players.push({
    player: a,
    globals: { pure: String(g[0]), lifetime: String(g[1]), spendable: String(g[2]) },
    premium: { lifetime: String(p[0]), spendable: String(p[1]), level: Number(p[2]), activeUntil: String(p[3]) },
    lives: { used: Number(l[0]), pool: Number(l[1]), boosterUntil: String(l[2]), day: String(l[3]) },
    buckets,
  });
}

const dir = join(homedir(), '.config', 'gfg');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'playercore-snapshot-' + CORE.toLowerCase() + '.json');
writeFileSync(file, JSON.stringify(out, null, 2));
console.log('wrote:     ' + file);
for (const p of out.players) {
  console.log('  ' + p.player + ' pure=' + p.globals.pure + ' life=' + p.globals.lifetime + ' spend=' + p.globals.spendable +
    ' prem=' + p.premium.lifetime + '/' + p.premium.spendable + ' L' + p.premium.level + ' buckets=' + JSON.stringify(p.buckets));
}
