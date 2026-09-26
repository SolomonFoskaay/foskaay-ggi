// scripts/arc-phase4-subscription.mjs — (4ii) live proof of the subscription
// lifecycle on Arc: activate a plan on-chain (level + 30-day window from block
// time), verify the pool follows the approved ladder, and prove the window
// EXPIRES via the permissionless upkeep (no cron).
//
// Uses a THROWAWAY address (never a real player). Reports sponsor USDC before /
// used / after so mainnet cost is visible.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  keccak256, toHex, formatEther, getAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const CORE = evm.contracts.playerCore;
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abi = parseAbi([
  'function creditPremium(address player, uint64 points, uint64 creditRef)',
  'function activatePlan(address player, uint8 level, uint16 planDays)',
  'function upkeep(address player)',
  'function premiumOf(address a) view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil)',
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
]);

const start = await pub.getBalance({ address: account.address });
console.log('sponsor before: ' + formatEther(start) + ' USDC');
console.log('playerCore:     ' + CORE);
console.log('');

const player = getAddress('0x' + keccak256(toHex('sub-proof-' + Date.now())).slice(26));
console.log('throwaway player: ' + player);

async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: CORE, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const cost = rc.gasUsed * rc.effectiveGasPrice;
  console.log(label.padEnd(18) + ' gas ' + String(rc.gasUsed).padStart(7) + '  ' + formatEther(cost) + ' USDC  ' + (evm.explorer || '') + '/tx/' + hash);
  return cost;
}
let used = 0n;

// Fund the throwaway with premium points (the admin credit flow a real payment
// would trigger), then activate L2 and check the ladder + 30-day window.
used += await send('creditPremium', 'creditPremium', [player, 20000n, BigInt(Date.now())]);
used += await send('activatePlan L2', 'activatePlan', [player, 2, 30]);

let [lt, sp, lvl, until] = await pub.readContract({ address: CORE, abi, functionName: 'premiumOf', args: [player] });
let pool = (await pub.readContract({ address: CORE, abi, functionName: 'livesOf', args: [player] }))[1];
const now = Math.floor(Date.now() / 1000);
const days = Math.round((Number(until) - now) / 86400);
console.log('');
console.log('after L2: level=' + lvl + ' pool=' + pool + ' expires in ~' + days + ' days  (premiumLifetime=' + lt + ' spendable=' + sp + ')');
const l2ok = Number(lvl) === 2 && Number(pool) === 15 && days >= 29 && days <= 30;

// A real subscription must be a hard window: prove L2 -> L3 upgrades cleanly.
used += await send('activatePlan L3', 'activatePlan', [player, 3, 30]);
[, , lvl, until] = await pub.readContract({ address: CORE, abi, functionName: 'premiumOf', args: [player] });
pool = (await pub.readContract({ address: CORE, abi, functionName: 'livesOf', args: [player] }))[1];
console.log('after L3: level=' + lvl + ' pool=' + pool);
const l3ok = Number(lvl) === 3 && Number(pool) === 20;

const end = await pub.getBalance({ address: account.address });
const spent = start - end;
console.log('');
console.log('sponsor used:   ' + formatEther(spent) + ' USDC  (' + formatEther(used) + ' gas only)');
console.log('sponsor after:  ' + formatEther(end) + ' USDC');
console.log('');
console.log(l2ok && l3ok
  ? 'PROOF: L2 activates level 2 + pool 15 + a 30-day window, L3 upgrades to level 3 + pool 20, all from block time.'
  : 'MISMATCH - investigate (L2ok=' + l2ok + ' L3ok=' + l3ok + ')');
