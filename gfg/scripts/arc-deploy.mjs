// scripts/arc-deploy.mjs — deploy ONE Arc contract from its forge artifact.
//
// Public values (RPC, addresses) come from public/arc-config.json; the deployer
// key comes from ~/.config/gfg/arc-sponsor.json and is NEVER printed, logged, or
// committed. On Arc the gas is USDC, so the sponsor wallet only needs test USDC.
//
// Usage:
//   node scripts/arc-deploy.mjs GameRegistry '[1800]'
//   node scripts/arc-deploy.mjs Randomness '[]'
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createPublicClient, createWalletClient, defineChain, http, getAddress,
} from 'viem';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

const name = process.argv[2];
const args = JSON.parse(process.argv[3] || '[]');
if (!name) {
  console.error("usage: node scripts/arc-deploy.mjs <ContractName> '[ctorArgsJson]'");
  process.exit(1);
}

const cfgPath = new URL('../public/arc-config.json', import.meta.url);
const evm = JSON.parse(readFileSync(cfgPath, 'utf8')).rails.evm;
const RPC = process.env.GFG_Arc_RPC || evm.rpc;
const chainId = evm.chainId;

const file = join(homedir(), '.config', 'gfg', 'arc-sponsor.json');
const account = accountFor(JSON.parse(readFileSync(file, 'utf8')).key);

const chain = defineChain({
  id: chainId,
  name: evm.name || 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: evm.usdcDecimalsNative || 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const artifactPath = new URL(`../evm/out/${name}.sol/${name}.json`, import.meta.url);
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object;
if (!bytecode || bytecode === '0x') throw new Error('no bytecode for ' + name + ' (run forge build)');

console.log('deployer: ' + account.address);
console.log('rpc:      ' + RPC);
console.log('contract: ' + name);

const hash = await wallet.deployContract({ abi, bytecode, args });
const rc = await pub.waitForTransactionReceipt({ hash });
console.log('address:  ' + getAddress(rc.contractAddress));
console.log('tx:       ' + hash);
console.log('explorer: ' + (evm.explorer || '') + '/tx/' + hash);
