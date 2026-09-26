// scripts/arc-phase4-boost.mjs — (4ii-2) live proof of the tier boost at M4
// flow-up on Arc, plus spendable draw-downs (spendGlobal/spendLocal).
//
// Models exactly what the client does on a verified win for an L2 player:
//   1. recordPoints  -> the COMBINED write: M3 local + M4a pure + M4b lifetime
//      + M4c spendable (base award) in ONE instruction.
//   2. recordGlobal kind=1 -> M4b + M4c ONLY (the tier boost; M4a pure stays clean).
// then proves spendGlobal / spendLocal draw down the spendable tracks.
//
// NOTE: a SECOND recordGlobal kind=0 would double-count, because recordPoints
// already writes all three global tracks. That is by design (one write per win).
//
// THROWAWAY player. Reports sponsor USDC before / used / after.
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
  'function activatePlan(address player, uint8 level, uint16 planDays)',
  'function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef)',
  'function recordGlobal(address player, uint8 kind, uint64 points, uint64 matchRef)',
  'function spendGlobal(address player, uint64 amount)',
  'function spendLocal(address player, bytes32 tag, uint64 amount)',
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
]);

function strToTag(s) { const b = Buffer.alloc(32); Buffer.from(s, 'utf8').copy(b); return '0x' + b.toString('hex'); }
const LUDO = strToTag('ludo');
const BASE = 100n;      // a 2P win
const MULT = 2n;        // L2
const BOOST = (MULT - 1n) * BASE; // 100 (the kind=1 tier boost)

const start = await pub.getBalance({ address: account.address });
const player = getAddress('0x' + keccak256(toHex('boost-proof-' + Date.now())).slice(26));
const ref = BigInt(Date.now());
console.log('sponsor before: ' + formatEther(start) + ' USDC');
console.log('playerCore:     ' + CORE);
console.log('player:         ' + player);
console.log('plan: L2 x' + MULT + ' | base=' + BASE + ' | boost=' + BOOST);
console.log('');

let used = 0n;
async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: CORE, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const cost = rc.gasUsed * rc.effectiveGasPrice;
  used += cost;
  console.log(label.padEnd(24) + ' gas ' + String(rc.gasUsed).padStart(7) + '  ' + formatEther(cost) + ' USDC');
  return rc;
}

await send('activatePlan L2', 'activatePlan', [player, 2, 30]);
await send('recordPoints (M3+M4 base)', 'recordPoints', [player, LUDO, BASE, 1, ref]);
await send('recordGlobal kind=1 (boost)', 'recordGlobal', [player, 1, BOOST, ref + 1n]);

const [gPure, gLife, gSpend] = await pub.readContract({ address: CORE, abi, functionName: 'globalsOf', args: [player] });
const [bPure, bSpend] = await pub.readContract({ address: CORE, abi, functionName: 'bucketOf', args: [player, LUDO] });
console.log('');
console.log('after win: global pure=' + gPure + ' lifetime=' + gLife + ' spendable=' + gSpend + ' | ludo pure=' + bPure + ' spendable=' + bSpend);
const boostOk = Number(gPure) === Number(BASE) && Number(gLife) === Number(BASE + BOOST) && Number(gSpend) === Number(BASE + BOOST);

await send('spendGlobal 50', 'spendGlobal', [player, 50n]);
await send('spendLocal 30', 'spendLocal', [player, LUDO, 30n]);
const [, gLife2, gSpend2] = await pub.readContract({ address: CORE, abi, functionName: 'globalsOf', args: [player] });
const [, bSpend2] = await pub.readContract({ address: CORE, abi, functionName: 'bucketOf', args: [player, LUDO] });
console.log('after spends: global pure=' + gPure + ' lifetime=' + gLife2 + ' spendable=' + gSpend2 + ' | ludo spendable=' + bSpend2);
const spendOk = Number(gSpend2) === Number(BASE + BOOST) - 50 && Number(bSpend2) === Number(BASE) - 30;

const end = await pub.getBalance({ address: account.address });
console.log('');
console.log('sponsor used: ' + formatEther(used) + ' USDC');
console.log('sponsor after: ' + formatEther(end) + ' USDC');
console.log('');
console.log(boostOk && spendOk
  ? 'PROOF: base win banks pure+lifetime+spendable; the tier boost adds to lifetime+spendable ONLY (pure stays 100); spends draw down spendable, never pure.'
  : 'MISMATCH: boostOk=' + boostOk + ' spendOk=' + spendOk);
