// scripts/arc-wallet.mjs — check the Arc sponsor wallet, like `solana balance`.
//
// Shows the address (from the local key file) plus the live USDC balance, gas
// price and block on Arc. It reads ONLY the public address from the file; the
// key value is never printed, used, or transmitted by this tool.
//
// Usage:
//   node scripts/arc-wallet.mjs            # Arc Testnet (default)
//   node scripts/arc-wallet.mjs mainnet    # Arc Mainnet
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPublicClient, defineChain, http, formatEther } from 'viem';

const NETWORKS = {
  testnet: { name: 'Arc Testnet', id: 5042002, rpc: 'https://rpc.testnet.arc.io' },
  mainnet: { name: 'Arc Mainnet', id: 5042, rpc: 'https://rpc.mainnet.arc.io' },
};
const which = (process.argv[2] || 'testnet').toLowerCase();
const net = NETWORKS[which] || NETWORKS.testnet;
const file = join(homedir(), '.config', 'gfg', 'arc-sponsor.json');

if (!existsSync(file)) {
  console.error('No Arc sponsor wallet found. Create one first:');
  console.error('  node scripts/arc-sponsor-wallet.mjs');
  process.exit(1);
}

const address = JSON.parse(readFileSync(file, 'utf8')).address;

const chain = defineChain({
  id: net.id,
  name: net.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [net.rpc] } },
});
const client = createPublicClient({ chain, transport: http(net.rpc) });

const [balance, gasPrice, blockNumber, chainId] = await Promise.all([
  client.getBalance({ address }),
  client.getGasPrice(),
  client.getBlockNumber(),
  client.getChainId(),
]);

console.log('address:  ' + address);
console.log('network:  ' + net.name + ' (chain ' + chainId + ')');
console.log('balance:  ' + formatEther(balance) + ' USDC');
console.log('gas:      ' + (Number(gasPrice) / 1e9).toFixed(2) + ' Gwei');
console.log('block:    ' + blockNumber.toString());
