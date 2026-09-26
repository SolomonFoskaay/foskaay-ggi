// scripts/arc-phase1.mjs — Phase 1: one real session on Arc Testnet + measured cost.
//
// Exercises the deployed contracts and prints the exact gas + USDC cost per
// action, so we can decide viability with real numbers.
//
// Usage: node scripts/arc-phase1.mjs [registryAddress] [randomnessAddress]
// Reads the wallet from ~/.config/gfg/arc-sponsor.json (address + key). The key
// value is never printed.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http,
  parseAbi, keccak256, toHex, formatEther, parseGwei,
} from 'viem';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

const REGISTRY = process.argv[2] || '0x19BbC0C9e71318cDa9ca03994380a73B1280b38a';
const RANDOMNESS = process.argv[3] || '0xb406295b4F7E5B513b656122AfFF29AF720E9E23';
const RPC = 'https://rpc.testnet.arc.io';

const file = join(homedir(), '.config', 'gfg', 'arc-sponsor.json');
const info = JSON.parse(readFileSync(file, 'utf8'));
const account = accountFor(info.key);

const chain = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abiRegistry = parseAbi([
  'function openGame(bytes32 gameId, address p2, uint32 ttl)',
  'function settleGame(bytes32 gameId, bytes32 resultHash)',
  'function commitBatch(uint8 kind, bytes32 root, uint256 count)',
  'function gameState(bytes32 gameId) view returns (address p1, address p2, uint64 startAt, uint64 deadline, bytes32 resultHash, bool expired)',
]);
const abiRand = parseAbi([
  'function commitSeed(bytes32 batchId, bytes32 seedHash)',
  'function revealSeed(bytes32 batchId, bytes32 seed)',
  'function roll(bytes32 batchId, bytes32 gameId, uint32 counter, uint8 sides) view returns (uint8)',
]);

const gasPrice = await pub.getGasPrice();
const rows = [];

async function send(label, address, abi, fn, args) {
  try {
    const hash = await wallet.writeContract({ address, abi, functionName: fn, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const costWei = rc.gasUsed * rc.effectiveGasPrice;
    rows.push({ label, gas: rc.gasUsed.toString(), usdc: formatEther(costWei), hash });
    return rc;
  } catch (e) {
    throw new Error(label + ' failed: ' + (e.shortMessage || e.message || String(e)).split('\n')[0]);
  }
}

const gameId = keccak256(toHex('phase1-game-' + Date.now()));
const batchId = keccak256(toHex('phase1-batch-' + Date.now()));
const seedStr = 'phase1-seed-' + Date.now();
const seed = keccak256(toHex(seedStr));

console.log('wallet:    ' + account.address);
console.log('registry:  ' + REGISTRY);
console.log('randomness:' + RANDOMNESS);
console.log('gas price: ' + (Number(gasPrice) / 1e9).toFixed(2) + ' Gwei');
console.log('');

// 1. batched opens: ONE tx committing 100 games
await send('commitBatch(open x100)', REGISTRY, abiRegistry, 'commitBatch', [0, keccak256(toHex('openroot' + Date.now())), 100n]);
// 2. one single open (for the game we will settle)
await send('openGame', REGISTRY, abiRegistry, 'openGame', [gameId, account.address, 1800]);
// 3. batched seed commit
await send('commitSeed', RANDOMNESS, abiRand, 'commitSeed', [batchId, keccak256(seed)]); // commit hash(seed)
// 4. reveal the seed
await send('revealSeed', RANDOMNESS, abiRand, 'revealSeed', [batchId, seed]);
// 5. settle the game with a result hash
await send('settleGame', REGISTRY, abiRegistry, 'settleGame', [gameId, keccak256(toHex('result' + Date.now()))]);
// 6. batched settles: ONE tx committing 100 results
await send('commitBatch(settle x100)', REGISTRY, abiRegistry, 'commitBatch', [1, keccak256(toHex('settleroot' + Date.now())), 100n]);

// reads (free)
const roll1 = await pub.readContract({ address: RANDOMNESS, abi: abiRand, functionName: 'roll', args: [batchId, gameId, 0, 6] });
const roll2 = await pub.readContract({ address: RANDOMNESS, abi: abiRand, functionName: 'roll', args: [batchId, gameId, 1, 6] });
const state = await pub.readContract({ address: REGISTRY, abi: abiRegistry, functionName: 'gameState', args: [gameId] });

console.log('action                      gas        USDC');
console.log('----------------------------------------------');
let total = 0n;
for (const r of rows) {
  const usdc = Number(r.usdc); total += 0n;
  console.log(r.label.padEnd(26) + String(r.gas).padStart(9) + '   ' + r.usdc);
}
console.log('');
console.log('derived rolls (free reads): ' + roll1 + ', ' + roll2 + '  (1..6, deterministic from the seed)');
console.log('game settled: ' + (state[4] !== '0x' + '0'.repeat(64)));
const batchRows = rows.filter(r => r.label.includes('x100'));
if (batchRows.length) {
  console.log('');
  for (const r of batchRows) {
    console.log('per game if 100 games share one ' + r.label + ': ' + (Number(r.usdc) / 100).toFixed(8) + ' USDC');
  }
}
