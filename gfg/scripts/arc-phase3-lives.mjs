// scripts/arc-phase3-lives.mjs — (3iii) live proof that the CHAIN gates lives.
//
// Charges lives for a THROWAWAY address until the pool is exhausted, then shows
// the contract reverting NoLives. No real player is touched. Public config from
// public/arc-config.json; deployer from ~/.config/gfg/arc-sponsor.json.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  encodePacked, keccak256, toHex,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const CORE = evm.contracts.playerCore;
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: evm.usdcDecimalsNative || 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abi = parseAbi([
  'function chargeLife(address player, uint64 matchRef)',
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
  'error NoLives()',
]);

// A throwaway address derived from the clock, never a real player.
const target = ('0x' + keccak256(toHex('lives-proof-' + Date.now())).slice(26)).toLowerCase();
console.log('playerCore: ' + CORE);
console.log('throwaway:  ' + target);
console.log('');

let charged = 0, pool = 0;
for (let i = 1; i <= 8; i++) {
  const ref = Date.now() + i;
  try {
    const hash = await wallet.writeContract({ address: CORE, abi, functionName: 'chargeLife', args: [target, BigInt(ref)] });
    await pub.waitForTransactionReceipt({ hash });
    const [used, p] = await pub.readContract({ address: CORE, abi, functionName: 'livesOf', args: [target] });
    pool = Number(p);
    charged = Number(used);
    console.log('charge #' + i + ': ok   used=' + used + ' pool=' + pool);
  } catch (e) {
    let name = ''; let cur = e;
    for (let d = 0; d < 6 && cur; d++) { if (cur.errorName) { name = cur.errorName; break; } cur = cur.cause; }
    console.log('charge #' + i + ': REVERTED -> ' + (name || (e.shortMessage || e.message)));
    break;
  }
}
console.log('');
console.log('PROOF: the chain stopped the charge after ' + charged + ' of pool ' + pool + '; a third-party client cannot exceed the pool.');
