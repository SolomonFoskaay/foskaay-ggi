// scripts/core-admin-fix-premium.mjs
// Admin repair tool for the Player Core premium track (arcv2m5).
//
// Purpose: SET an account's premium balances outright and optionally clear the
// plan. This repairs an account corrupted by the 2026-08 frontend bug that
// credited an absurd premium amount (one live account held a junk level 112 and
// a 10^19 lifetime), and it also covers refunds/corrections.
//
// Runs on the MagicBlock ER (the core is delegated), gasless, signed by the
// sponsor key, which is the core's stored admin_authority.
//
// Usage:
//   node scripts/core-admin-fix-premium.mjs <wallet> --lifetime 0 --spendable 0 --clear-plan
//   node scripts/core-admin-fix-premium.mjs <wallet> --show
//
// --show is read-only: it prints the current core premium view and exits.

import './load-env.mjs';
import { PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const CORE_SEED = Buffer.from('gfgcore');
const baseConn = createConnection(baseRpcUrl(), 'confirmed');
const sponsor = loadSponsor();

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

function premiumView(c) {
  if (!c) return null;
  return {
    lifetime: c.premiumLifetime.toString(),
    spendable: c.premiumSpendable.toString(),
    level: c.subscriptionLevel,
    subUntil: c.subscriptionActiveUntil.toString(),
    boosterUntil: c.boosterActiveUntil.toString(),
    livesPool: c.livesPool,
    adminAuthority: c.adminAuthority ? c.adminAuthority.toBase58() : '-',
  };
}

async function main() {
  const walletStr = process.argv[2];
  if (!walletStr || walletStr.startsWith('--')) throw new Error('usage: node scripts/core-admin-fix-premium.mjs <wallet> [--show | --lifetime N --spendable N [--clear-plan]]');
  const wallet = new PublicKey(walletStr);
  const [corePda] = PublicKey.findProgramAddressSync([CORE_SEED, wallet.toBytes()], PROGRAM_ID);

  const st = await getDelegationStatus(baseConn, corePda).catch(() => null);
  const url = (st && st.isDelegated && regionUrlForFqdn(st.fqdn)) || (st && st.isDelegated && pickErRpcUrl()) || baseRpcUrl();
  const conn = createConnection(url, 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const before = await program.account.playerCore.fetch(corePda);
  console.log(`[fix-premium] core ${corePda.toBase58()} (region ${st && st.isDelegated ? 'ER' : 'base'})`);
  console.log('  before:', JSON.stringify(premiumView(before)));

  if (process.argv.includes('--show')) return;

  const lifetime = Number(arg('--lifetime') ?? 0);
  const spendable = Number(arg('--spendable') ?? 0);
  const clearPlan = process.argv.includes('--clear-plan');

  if (before.adminAuthority.toBase58() !== sponsor.publicKey.toBase58()) {
    throw new Error(`core admin_authority is ${before.adminAuthority.toBase58()}, not the sponsor ${sponsor.publicKey.toBase58()} - cannot sign this correction`);
  }

  const sig = await program.methods
    .adminFixCorePremium(new BN(lifetime), new BN(spendable), clearPlan)
    .accounts({ payer: sponsor.publicKey, playerAuthority: wallet, core: corePda })
    .rpc();
  console.log(`  tx ${sig}`);

  const after = await program.account.playerCore.fetch(corePda);
  console.log('  after: ', JSON.stringify(premiumView(after)));
}

main().catch((e) => { console.error(`[fix-premium] FAILED: ${e.transactionMessage || e.message}`); process.exit(1); });
