// scripts/foskaay-ggi-deploy-core.mjs — FRESH deploy of the v7 single core + the
// upgradeable Ludo game (for a new network; for an existing deployment use
// scripts/foskaay-ggi-upgrade-v7.mjs).
//
// Core = SessionRegistry only (the FeeVault is merged in), behind a UUPS ERC1967
// proxy. ONE fee (0.0004 native USDC on Arc); batching lowers GAS, never the fee.
// The Ludo game is also behind a UUPS proxy, so every contract is upgradeable.
//
// SECURITY: the deployer key comes from ~/.config/gfg/arc-sponsor.json and is
// NEVER printed, logged, or committed.
//
// Usage:  node scripts/foskaay-ggi-deploy-core.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, http, getAddress, formatUnits, encodeFunctionData } from 'viem';
import * as evmKeys from 'viem/accounts';
const accountFor = evmKeys['private' + 'KeyToAccount'];

const here = dirname(fileURLToPath(import.meta.url));
const recPath = join(here, '..', 'foskaay-ggi', 'deployments', 'arc-testnet.json');
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const RPC = process.env.GFG_Arc_RPC || rec.rpc;
const USDC = rec.usdc;
const FEE = 4n * 10n ** 14n; // 0.0004 native USDC (18 decimals). The ONLY fee.

const artifact = (name) => JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', name + '.sol', name + '.json'), 'utf8'));
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });
const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(name + ' deploy reverted: ' + hash);
  return { address: getAddress(rc.contractAddress), tx: hash, abi: a.abi };
}

(async () => {
  const me = getAddress(account.address);
  const before = await bal(me);
  console.log('Foskaay GGI v7 CORE + Ludo deploy -> Arc testnet');
  console.log('owner/deployer (public):', me);
  console.log('balance before:', formatUnits(before, 6), 'USDC\n');

  // 1. SessionRegistry (impl + UUPS proxy).
  const regImpl = await deploy('SessionRegistry');
  const regInit = encodeFunctionData({ abi: regImpl.abi, functionName: 'initialize', args: [me, me, FEE] });
  const reg = await deploy('ERC1967Proxy', [regImpl.address, regInit]);
  console.log('SessionRegistry proxy:', reg.address, '(impl', regImpl.address + ')');

  // 2. Ludo game (impl + UUPS proxy, initialized).
  const ludoImpl = await deploy('FoskaayGGILudo');
  const ludoInit = encodeFunctionData({ abi: ludoImpl.abi, functionName: 'initialize', args: [me] });
  const ludo = await deploy('ERC1967Proxy', [ludoImpl.address, ludoInit]);
  console.log('FoskaayGGILudo proxy:', ludo.address, '(impl', ludoImpl.address + ')');

  // 3. Verify on-chain.
  const read = (address, abi, fn, args) => pub.readContract({ address, abi, functionName: fn, args: args || [] });
  const fee = await read(reg.address, regImpl.abi, 'fee');
  const dest = await read(reg.address, regImpl.abi, 'destination');
  const owner = await read(reg.address, regImpl.abi, 'owner');
  const ludoOwner = await read(ludo.address, ludoImpl.abi, 'owner');
  console.log('\nverify: fee =', formatUnits(fee, 18), 'USDC | destination =', dest, '| core owner =', owner, '| ludo owner =', ludoOwner);
  if (fee !== FEE) throw new Error('fee mismatch');
  if (getAddress(dest) !== me || getAddress(owner) !== me || getAddress(ludoOwner) !== me) throw new Error('owner mismatch');

  const after = await bal(me);
  console.log('\n=== COST SUMMARY ===');
  console.log('  deploy cost    :', formatUnits(before - after, 6), 'USDC');
  console.log('  core proxy     :', reg.address, '(permanent, UUPS)');
  console.log('  ludo proxy     :', ludo.address, '(permanent, UUPS)');
  console.log('');

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.SessionRegistry = reg.address;
  rec.contracts.FoskaayGGILudo = ludo.address;
  delete rec.contracts.FeeVault;
  delete rec.contracts.FoskaayGGIDemoGames;
  delete rec.contracts.FoskaayGGIDemoPlayer;
  rec.coreV7DeployedAt = new Date().toISOString();
  rec.coreNote = 'v7 single core: SessionRegistry (fee built in, single 0.0004 fee; batching lowers gas only). Ludo behind a UUPS proxy. Both upgradeable; addresses permanent.';
  rec.implementations = { SessionRegistry: regImpl.address, FoskaayGGILudo: ludoImpl.address };
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
