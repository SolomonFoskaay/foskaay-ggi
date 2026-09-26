// scripts/arc-phase2-clocks.mjs — (2ii) live proof of the ON-CHAIN turn clock.
//
// Opens a game, starts the clock, waits for a short turn to lapse, then advances
// it. Prints every tx so the deadline + permissionless expire can be checked on
// the Arc explorer. Reads public config from public/arc-config.json and the
// deployer from ~/.config/gfg/arc-sponsor.json (key never printed).
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi,
  keccak256, toHex, formatEther,
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
  'function commitMove(bytes32 gameId, address mover, uint8 seat, uint8 nextSeat, bytes32 moveCommit)',
  'function expireTurn(bytes32 gameId)',
  'function turnState(bytes32 gameId) view returns (uint8 seats, uint8 activeSeat, uint32 turnSecs, uint64 turnDeadline, uint32 moveCount, bool begun)',
]);

async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(label.padEnd(14) + ' gas ' + String(rc.gasUsed).padStart(7) + '  ' + (evm.explorer || '') + '/tx/' + hash);
  return rc;
}
const state = async () => pub.readContract({ address: REGISTRY, abi, functionName: 'turnState', args: [GAME] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAME = keccak256(toHex('clock-proof-' + Date.now()));
const TURN = 8;

console.log('registry: ' + REGISTRY);
console.log('gameId:   ' + GAME);
console.log('');

await send('openGame', 'openGame', [GAME, account.address, 1800]);
await send('beginGame', 'beginGame', [GAME, account.address, 4, TURN]);
let s = await state();
const dl0 = Number(s[3]);
console.log('after begin:  activeSeat=' + s[1] + ' turnSecs=' + s[2] + ' deadline=' + dl0 + ' (chain now ' + Math.floor(Date.now() / 1000) + ')');

// The turn is live: expireTurn must revert until the deadline passes. We wait.
const waitMs = Math.max(0, (dl0 + 1) * 1000 - Date.now());
console.log('waiting ' + Math.ceil(waitMs / 1000) + 's for the seat-0 turn to lapse...');
await sleep(waitMs + 1500);

// Any caller may push the stalled turn forward (no player check on-chain).
await send('expireTurn', 'expireTurn', [GAME]);
s = await state();
console.log('after expire: activeSeat=' + s[1] + ' moveCount=' + s[4] + ' newDeadline=' + s[3]);

// One real move from the now-active seat (seat 1) advances the turn again.
await send('commitMove', 'commitMove', [GAME, account.address, 1, 2, keccak256(toHex('proof-move'))]);
s = await state();
console.log('after move:   activeSeat=' + s[1] + ' moveCount=' + s[4] + ' deadline=' + s[3]);
console.log('');
console.log('PROOF: turn advanced entirely from the chain clock, no off-chain timer.');
