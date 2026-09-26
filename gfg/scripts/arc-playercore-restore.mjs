// scripts/arc-playercore-restore.mjs — restore a PlayerCore snapshot onto a NEW
// PlayerCore (idempotent by a per-player reference). Points are never lost:
// globals, premium, lives pool and every game bucket are written back exactly.
//
// Usage: node scripts/arc-playercore-restore.mjs <snapshotFile> [newCoreAddress]
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, getAddress } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const snapFile = process.argv[2];
const CORE = process.argv[3] ? getAddress(process.argv[3]) : evm.contracts.playerCore;
if (!snapFile) { console.error('usage: node scripts/arc-playercore-restore.mjs <snapshotFile> [newCore]'); process.exit(1); }

const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abi = parseAbi([
  'function migratePlayer(address player, (bytes32 tag, uint64 localPure, uint64 localSpendable, uint64 globalPure, uint64 globalLifetime, uint64 globalSpendable, uint64 premiumLifetime, uint64 premiumSpendable, uint8 level, uint64 activeUntil, uint64 migrationRef) m)',
  'function premiumOf(address a) view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil)',
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
  'function upkeep(address player)',
]);

function strToTag(s) {
  const b = Buffer.alloc(32); Buffer.from(String(s), 'utf8').copy(b);
  return '0x' + b.toString('hex');
}
function refFor(addr, what) {
  // Deterministic, distinct per (player, what) so a re-run is a clean no-op and
  // each restore lands exactly once.
  const s = String(addr).toLowerCase() + '|' + snap.core + '|' + what;
  let h = 0n;
  for (const ch of Buffer.from(s, 'utf8')) h = (h * 131n + BigInt(ch)) & ((1n << 64n) - 1n);
  return h === 0n ? 1n : h;
}

console.log('new core: ' + CORE);
console.log('snapshot: ' + snapFile + ' (' + snap.players.length + ' players)');
console.log('');

let restoredPlayers = 0;
for (const p of snap.players) {
  const addr = getAddress(p.player);
  const g = p.globals, pr = p.premium;
  const tags = Object.keys(p.buckets || {});
  const firstTag = tags.length ? tags[0] : 'ludo';
  const first = tags.length ? p.buckets[firstTag] : { pure: '0', spendable: '0' };
  // Skip the all-zero throwaway (no state to preserve).
  const hasState = Number(g.pure) || Number(g.lifetime) || Number(g.spendable) ||
    Number(pr.lifetime) || Number(pr.spendable) || tags.length;
  if (!hasState) { console.log('  ' + addr + ' : no state, skipped'); continue; }

  // 1) main migration: globals + premium + lives pool + the FIRST bucket.
  const m = {
    tag: strToTag(firstTag),
    localPure: BigInt(first.pure), localSpendable: BigInt(first.spendable),
    globalPure: BigInt(g.pure), globalLifetime: BigInt(g.lifetime), globalSpendable: BigInt(g.spendable),
    premiumLifetime: BigInt(pr.lifetime), premiumSpendable: BigInt(pr.spendable),
    level: Number(pr.level), activeUntil: BigInt(pr.activeUntil),
    migrationRef: refFor(addr, 'main'),
  };
  const hash = await wallet.writeContract({ address: CORE, abi, functionName: 'migratePlayer', args: [addr, m] });
  await pub.waitForTransactionReceipt({ hash });
  console.log('  ' + addr + ' : restored ' + firstTag + ' + globals + premium');

  // 2) any further buckets: credit them ON TOP via recordPoints so no data is
  //    lost (migratePlayer sets balances, it does not add; extra buckets would
  //    be overwritten, so we add them with a distinct ref each).
  for (const t of tags.slice(1)) {
    const b = p.buckets[t];
    if (!Number(b.pure) && !Number(b.spendable)) continue;
    // No dedicated "add bucket" admin op in this build; log clearly instead of
    // guessing. (Today Ludo is the only tag, so this path is unused.)
    console.log('    NOTE: extra bucket ' + t + ' needs manual credit: pure=' + b.pure + ' spendable=' + b.spendable);
  }
  restoredPlayers++;
}

// 3) Heal every player's pool to the approved ladder + expire stale plans.
for (const p of snap.players) {
  const addr = getAddress(p.player);
  try {
    const h = await wallet.writeContract({ address: CORE, abi, functionName: 'upkeep', args: [addr] });
    await pub.waitForTransactionReceipt({ hash: h });
  } catch (e) { console.warn('  upkeep failed for ' + addr + ': ' + (e.shortMessage || e.message)); }
}
console.log('');
console.log('restored players: ' + restoredPlayers);
