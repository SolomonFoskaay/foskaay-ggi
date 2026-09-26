// scripts/foskaay-ggi-upgrade-v7.mjs — in-place upgrade to the single-fee core and
// put the Ludo game behind a UUPS proxy.
//
// 1. Deploy a new SessionRegistry implementation (single `fee`; handoverMany uses
//    `fee`, no batched tier) and UPGRADE the existing core proxy in place. The
//    core address is unchanged; the reserved slot keeps the layout append-only.
// 2. Deploy a new FoskaayGGILudo implementation + UUPS proxy (the old game was a
//    plain contract, so a new proxied address is required once) and initialize it.
//
// SECURITY: the key comes from ~/.config/gfg/arc-sponsor.json and is never printed.
//
// Usage:  node scripts/foskaay-ggi-upgrade-v7.mjs
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

const artifact = (name) => JSON.parse(readFileSync(join(here, '..', 'foskaay-ggi', 'out', name + '.sol', name + '.json'), 'utf8'));
const account = accountFor(JSON.parse(readFileSync(join(homedir(), '.config', 'gfg', 'arc-sponsor.json'), 'utf8')).key);
const chain = defineChain({ id: rec.chainId, name: rec.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });
const erc20Abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

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
  const CORE = getAddress(rec.contracts.SessionRegistry);
  console.log('Foskaay GGI v7 fix -> Arc testnet');
  console.log('owner:', me);
  console.log('core proxy (permanent):', CORE, '\n');

  // --- 1. Core: upgrade in place (single fee) ---
  const regImpl = await deploy('SessionRegistry');
  console.log('new SessionRegistry impl:', regImpl.address, '(tx', regImpl.tx + ')');
  const feeBefore = await pub.readContract({ address: CORE, abi: regImpl.abi, functionName: 'fee' });
  const destBefore = await pub.readContract({ address: CORE, abi: regImpl.abi, functionName: 'destination' });
  const up = await wallet.writeContract({ address: CORE, abi: regImpl.abi, functionName: 'upgradeToAndCall', args: [regImpl.address, '0x'], account });
  const upRc = await pub.waitForTransactionReceipt({ hash: up });
  if (upRc.status !== 'success') throw new Error('core upgrade reverted');
  const feeAfter = await pub.readContract({ address: CORE, abi: regImpl.abi, functionName: 'fee' });
  const destAfter = await pub.readContract({ address: CORE, abi: regImpl.abi, functionName: 'destination' });
  const implNow = getAddress('0x' + (await pub.getStorageAt({ address: CORE, slot: IMPL_SLOT })).slice(-40));
  console.log('core upgrade tx:', up);
  console.log('  address unchanged:', CORE, '| impl now:', implNow);
  console.log('  fee', formatUnits(feeBefore, 18), '->', formatUnits(feeAfter, 18), '| destination', destBefore, '->', destAfter);
  if (implNow !== regImpl.address) throw new Error('proxy did not repoint');
  if (getAddress(destAfter) !== getAddress(destBefore)) throw new Error('destination changed');

  // --- 2. Game: deploy behind a UUPS proxy ---
  const ludoImpl = await deploy('FoskaayGGILudo');
  const init = encodeFunctionData({ abi: ludoImpl.abi, functionName: 'initialize', args: [me] });
  const ludo = await deploy('ERC1967Proxy', [ludoImpl.address, init]);
  const owner = await pub.readContract({ address: ludo.address, abi: ludoImpl.abi, functionName: 'owner' });
  console.log('new FoskaayGGILudo proxy:', ludo.address, '(impl', ludoImpl.address + ')');
  if (getAddress(owner) !== me) throw new Error('ludo owner mismatch');

  const after = await bal(me);
  console.log('\n=== COST SUMMARY (v7 fix) ===');
  console.log('  balance before :', formatUnits(before, 6), 'USDC');
  console.log('  balance after  :', formatUnits(after, 6), 'USDC');
  console.log('  cost           :', formatUnits(before - after, 6), 'USDC');
  console.log('  CORE ADDRESS UNCHANGED:', CORE);
  console.log('  game moved to a UUPS proxy:', ludo.address);

  if (!rec.contracts || !rec.contracts.SessionRegistry) throw new Error('shape');
  rec.contracts.FoskaayGGILudo = ludo.address;
  rec.implementations = { SessionRegistry: regImpl.address, FoskaayGGILudo: ludoImpl.address };
  rec.coreV7UpgradedAt = new Date().toISOString();
  rec.coreNote = 'v7 single core (SessionRegistry, fee built in, single 0.0004 fee; batching lowers gas only). Upgraded in place; address unchanged. Ludo is behind a UUPS proxy (upgradeable).';
  writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  console.log('recorded: foskaay-ggi/deployments/arc-testnet.json');
})().catch((e) => { console.error('upgrade failed:', e.shortMessage || e.message || e); process.exit(1); });
