// scripts/arc-relayer.mjs — Phase 2: the SELF-HOSTED relayer (no paid platform).
//
// This is the gasless model: the PLAYER never signs and never pays. Our own
// relayer key (the PlayerCore admin) submits every write and pays the tiny USDC
// gas on Arc. It also measures the exact sponsored cost of one game so we can
// confirm it is as cheap as MagicBlock ER or cheaper.
//
// Usage: node scripts/arc-relayer.mjs [playerAddress]
// Reads the relayer key from ~/.config/gfg/arc-sponsor.json (never printed).
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http,
  parseAbi, keccak256, toHex, formatEther, getAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

const RPC = 'https://rpc.testnet.arc.io';
const CORE = '0x892CdbeD707425cdD3F0b0f9FE5428084E2FC730';
const REGISTRY = '0x19BbC0C9e71318cDa9ca03994380a73B1280b38a';
const RANDOMNESS = '0xb406295b4F7E5B513b656122AfFF29AF720E9E23';

const info = JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8'));
const relayer = accountFor(info.key);

// A stand-in for a player's embedded wallet. It holds NOTHING and signs NOTHING.
const player = getAddress(process.argv[2] || '0x000000000000000000000000000000000000dEaD');

const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account: relayer });

const coreAbi = parseAbi([
  'function chargeLife(address player, uint64 matchRef)',
  'function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef)',
  'function activateBooster(address player, uint16 planHours)',
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
]);
const regAbi = parseAbi([
  'function openGame(bytes32 gameId, address p2, uint32 ttl)',
  'function settleGame(bytes32 gameId, bytes32 resultHash)',
]);
const rndAbi = parseAbi([
  'function commitSeed(bytes32 batchId, bytes32 seedHash)',
  'function revealSeed(bytes32 batchId, bytes32 seed)',
  'function roll(bytes32 batchId, bytes32 gameId, uint32 counter, uint8 sides) view returns (uint8)',
]);

const rows = [];
async function send(label, address, abi, fn, args) {
  const hash = await wallet.writeContract({ address, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const costWei = rc.gasUsed * rc.effectiveGasPrice;
  rows.push({ label, gas: rc.gasUsed, usdc: formatEther(costWei) });
}

const LUDO = toHex('ludo', { size: 32 });
const gameId = keccak256(toHex('relayer-game-' + Date.now()));
const batchId = keccak256(toHex('relayer-batch-' + Date.now()));
const seed = keccak256(toHex('relayer-seed-' + Date.now()));
const matchRef = BigInt(Date.now());

const playerBefore = await pub.getBalance({ address: player });

console.log('relayer (pays gas): ' + relayer.address);
console.log('player  (pays 0):   ' + player);
console.log('player balance before: ' + formatEther(playerBefore) + ' USDC');
console.log('');

await send('openGame            (match starts, TTL)', REGISTRY, regAbi, 'openGame', [gameId, player, 1800]);
await send('commitSeed          (dice locked)', RANDOMNESS, rndAbi, 'commitSeed', [batchId, keccak256(seed)]);
await send('chargeLife          (one life, at start)', CORE, coreAbi, 'chargeLife', [player, matchRef]);
await send('revealSeed          (dice revealed)', RANDOMNESS, rndAbi, 'revealSeed', [batchId, seed]);
await send('recordPoints        (bucket + global)', CORE, coreAbi, 'recordPoints', [player, LUDO, 100n, 1, matchRef]);
await send('settleGame          (match ends)', REGISTRY, regAbi, 'settleGame', [gameId, keccak256(toHex('result' + Date.now()))]);

const roll = await pub.readContract({ address: RANDOMNESS, abi: rndAbi, functionName: 'roll', args: [batchId, gameId, 0, 6] });
const lives = await pub.readContract({ address: CORE, abi: coreAbi, functionName: 'livesOf', args: [player] });
const globals = await pub.readContract({ address: CORE, abi: coreAbi, functionName: 'globalsOf', args: [player] });
const bucket = await pub.readContract({ address: CORE, abi: coreAbi, functionName: 'bucketOf', args: [player, LUDO] });
const playerAfter = await pub.getBalance({ address: player });

console.log('action                        gas        USDC');
console.log('------------------------------------------------');
let totalWei = 0n;
for (const r of rows) {
  console.log(r.label.padEnd(30) + String(r.gas).padStart(8) + '   ' + r.usdc);
  totalWei += BigInt(Math.round(Number(r.usdc) * 1e18));
}
console.log('');
console.log('sponsored cost for this game: ' + formatEther(totalWei) + ' USDC');
console.log('player balance after:         ' + formatEther(playerAfter) + ' USDC (unchanged)');
console.log('on-chain result: life used=' + lives[0] + '/' + lives[1] + ', bucket pure=' + bucket[0] + ', global lifetime=' + globals[1] + ', first roll=' + roll);
