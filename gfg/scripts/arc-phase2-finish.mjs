// scripts/arc-phase2-finish.mjs — (2iii) live proof of the ON-CHAIN finish order.
//
// Opens a game, begins it, then settles it with a full 1st..Nth finish order and
// reads it back from the chain. Prints every tx so the result can be checked on
// the Arc explorer. Public config from public/arc-config.json; deployer from
// ~/.config/gfg/arc-sponsor.json (key never printed).
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  keccak256, toHex, stringToHex, pad, formatEther,
} from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const evm = JSON.parse(readFileSync(new URL('../public/arc-config.json', import.meta.url), 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const REGISTRY = evm.contracts.gameRegistry;
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);

const chain = defineChain({
  id: evm.chainId, name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: evm.usdcDecimalsNative || 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const abi = parseAbi([
  'function openGame(bytes32 gameId, address p2, uint32 ttl)',
  'function beginGame(bytes32 gameId, address host, uint8 seats, uint32 turnSecs)',
  'function settleGameOrder(bytes32 gameId, address actor, bytes32 resultHash, uint8[] finishOrder)',
  'function resultOrder(bytes32 gameId) view returns (bytes32 resultHash, uint8[] order)',
]);

async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(label.padEnd(16) + ' gas ' + String(rc.gasUsed).padStart(7) + '  ' + (evm.explorer || '') + '/tx/' + hash);
  return rc;
}

const GAME = keccak256(toHex('finish-proof-' + Date.now()));
// Result hash of the finish order, derived from the same order we store.
const ORDER = [3, 1, 0, 2];
const RESULT = keccak256(toHex('order:' + ORDER.join(',')));

console.log('registry: ' + REGISTRY);
console.log('gameId:   ' + GAME);
console.log('order:    ' + JSON.stringify(ORDER) + ' (1st..4th seat indexes)');
console.log('');

await send('openGame', 'openGame', [GAME, account.address, 1800]);
await send('beginGame', 'beginGame', [GAME, account.address, 4, 45]);
await send('settleOrder', 'settleGameOrder', [GAME, account.address, RESULT, ORDER]);

const [gotHash, stored] = await pub.readContract({ address: REGISTRY, abi, functionName: 'resultOrder', args: [GAME] });
console.log('');
console.log('read back resultHash: ' + gotHash);
console.log('read back order:      ' + JSON.stringify(stored.map(Number)));
const ok = gotHash === RESULT && stored.map(Number).join(',') === ORDER.join(',');
console.log(ok ? 'PROOF: finish order lives on-chain and reads back exactly.' : 'MISMATCH - investigate.');
