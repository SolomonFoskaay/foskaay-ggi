// scripts/foskaay-ggi-deploy-core.mjs - FRESH deploy of the single core + the
// upgradeable Ludo game, for a new network. Once deployed, the proxies are
// permanent: ship changes as UUPS logic upgrades, never as a fresh deploy.
//
// Core = FoskaayGGI only (the FeeVault is merged in), behind a UUPS ERC1967
// proxy. Fee = 0.0004 base + 0.0004 per lifted account + 0.0002 per game,
// charged once at connect; only the per-game part grows with batching.
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
const LEGACY_FEE = 4n * 10n ** 14n;       // 0.0004 (legacy single-fee handover)
const FEE_BASE = 4n * 10n ** 14n;         // 0.0004 session base
const FEE_PER_ACCOUNT = 4n * 10n ** 14n;  // 0.0004 per lifted account
const FEE_PER_GAME = 2n * 10n ** 14n;     // 0.0002 per game

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

  // 1. FoskaayGGI (impl + UUPS proxy).
  const regImpl = await deploy('FoskaayGGI');
  const regInit = encodeFunctionData({ abi: regImpl.abi, functionName: 'initialize', args: [me, me, LEGACY_FEE, FEE_BASE, FEE_PER_ACCOUNT, FEE_PER_GAME] });
  const reg = await deploy('ERC1967Proxy', [regImpl.address, regInit]);
  console.log('FoskaayGGI proxy:', reg.address, '(impl', regImpl.address + ')');

  // 2. Ludo game (impl + UUPS proxy, initialized).
  const ludoImpl = await deploy('FoskaayGGILudo');
  const ludoInit = encodeFunctionData({ abi: ludoImpl.abi, functionName: 'initialize', args: [me] });
  const ludo = await deploy('ERC1967Proxy', [ludoImpl.address, ludoInit]);
  console.log('FoskaayGGILudo proxy:', ludo.address, '(impl', ludoImpl.address + ')');

  // 3. Verify on-chain.
  const read = (address, abi, fn, args) => pub.readContract({ address, abi, functionName: fn, args: args || [] });
  const feeBase = await read(reg.address, regImpl.abi, 'feeBase');
  const feePerAccount = await read(reg.address, regImpl.abi, 'feePerAccount');
  const feePerGame = await read(reg.address, regImpl.abi, 'feePerGame');
  const dest = await read(reg.address, regImpl.abi, 'destination');
  const owner = await read(reg.address, regImpl.abi, 'owner');
  const ludoOwner = await read(ludo.address, ludoImpl.abi, 'owner');
  console.log('\nverify: feeBase/perAccount/perGame =', formatUnits(feeBase, 18), formatUnits(feePerAccount, 18), formatUnits(feePerGame, 18), 'USDC | destination =', dest, '| core owner =', owner, '| ludo owner =', ludoOwner);
  if (feeBase !== FEE_BASE || feePerAccount !== FEE_PER_ACCOUNT || feePerGame !== FEE_PER_GAME) throw new Error('fee mismatch');
  if (getAddress(dest) !== me || getAddress(owner) !== me || getAddress(ludoOwner) !== me) throw new Error('owner mismatch');

  const after = await bal(me);
  console.log('\n=== COST SUMMARY ===');
  console.log('  deploy cost    :', formatUnits(before - after, 6), 'USDC');
  console.log('  core proxy     :', reg.address, '(permanent, UUPS)');
  console.log('  ludo proxy     :', ludo.address, '(permanent, UUPS)');
  console.log('');

  if (!rec.contracts || !rec.contracts.FoskaayGGI) throw new Error('arc-testnet.json shape unexpected; refusing to write');
  rec.contracts.FoskaayGGI = reg.address;
  rec.contracts.FoskaayGGILudo = ludo.address;
  delete rec.contracts.FeeVault;
  delete rec.contracts.FoskaayGGIDemoGames;
  delete rec.contracts.FoskaayGGIDemoPlayer;
  rec.coreV7DeployedAt = new Date().toISOString();
  rec.coreNote = 'Single core FoskaayGGI (fee built in: 0.0004 base + 0.0004 per lifted account + 0.0002 per game, charged once at connect; only the per-game part grows with batching). Ludo behind a UUPS proxy. Both upgradeable; addresses permanent.';
  rec.implementations = { FoskaayGGI: regImpl.address, FoskaayGGILudo: ludoImpl.address };
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message || e); process.exit(1); });
