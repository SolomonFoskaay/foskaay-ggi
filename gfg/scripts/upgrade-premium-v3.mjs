// scripts/upgrade-premium-v3.mjs — M5 v3 PREMIUM MIGRATION SWEEP.
//
// After the booster program deploy (PremiumPoints layout v3), every EXISTING
// premium ledger must run the permissionless migration so credit / activate /
// booster keep working (writes are version-gated at >= 3; reads stay fine).
//   - v1 accounts -> upgrade_premium_points (v1 -> v3)
//   - v2 accounts -> upgrade_premium_points_v3 (v2 -> v3)
//   - v3 accounts -> skipped (idempotent)
//
// Flow per account (mirrors migrate-to-as.mjs, adds the base-layer migration):
//   1. enumerate all gfgprem PDAs via getProgramAccounts (discriminator filter)
//      across the 3-region registry + base RPC (a delegated account's data lives
//      on its hosting ER region; merge duplicates).
//   2. version read; skip v3.
//   3. undelegate_premium_points on the hosting region (sponsor signs).
//   4. base-layer: sponsor runs the correct upgrade instruction (realloc rent
//      is tiny and the sponsor pays). Data preserved: fields copied field-by-
//      field by the program, booster_active_until = 0.
//   5. read-back verify: version == 3 && booster_active_until == 0.
//   6. re-delegate to AS (sponsor signs one delegate_premium_points step).
//
// Usage:
//   node scripts/upgrade-premium-v3.mjs            # sweep everything, live
//   node scripts/upgrade-premium-v3.mjs --player <pk>   # single wallet
//
// Env: sponsor via GFG_Gasless_Sponsor_Keypair or ~/.config/solana/id.json.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const V_AS = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const MP = new PublicKey('Magic11111111111111111111111111111111111111');
const MC = new PublicKey('MagicContext1111111111111111111111111111111');
const BASE_URL = baseRpcUrl();
const AS_MARKER = 'devnet-as';
const PREMIUM_SEED = Buffer.from('gfgprem');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function wallet(kp) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (t) => { t.partialSign(kp); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(kp)); return ts; },
  };
}

async function waitPickup(conn, pda) {
  for (let i = 0; i < 20; i++) {
    try { const info = await conn.getAccountInfo(pda); if (info) return true; } catch (e) { /* retry */ }
    await sleep(750);
  }
  return false;
}

async function waitUndelegated(baseConn, pda) {
  for (let i = 0; i < 20; i++) {
    const st = await getDelegationStatus(baseConn, pda).catch(() => null);
    if (st && !st.isDelegated) return true;
    await sleep(1500);
  }
  return false;
}

async function undelegateOnHost(sponsor, hostConn, player, pda) {
  const prog = new Program(idl, new AnchorProvider(hostConn, wallet(sponsor), { commitment: 'processed', skipPreflight: true }));
  const tx = await prog.methods.undelegatePremiumPoints()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player,
      premiumPoints: pda,
      magicProgram: MP,
      magicContext: MC,
    })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(hostConn, tx, [sponsor], { skipPreflight: true });
  await hostConn.confirmTransaction({ signature: sig }, 'processed');
  return sig;
}

async function migrateBase(baseConn, sponsor, player, pda, version) {
  const prog = new Program(idl, new AnchorProvider(baseConn, wallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const accounts = { payer: sponsor.publicKey, premiumPoints: pda, systemProgram: SystemProgram.programId };
  const tx = version >= 2
    ? await prog.methods.upgradePremiumPointsV3().accounts(accounts).transaction()
    : await prog.methods.upgradePremiumPoints().accounts(accounts).transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function reDelegateToAs(baseConn, sponsor, player, pda) {
  const prog = new Program(idl, new AnchorProvider(baseConn, wallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
  const tx = await prog.methods.delegatePremiumPoints()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player,
      premiumPoints: pda,
      bufferPremiumPoints: buffer,
      delegationRecordPremiumPoints: record,
      delegationMetadataPremiumPoints: metadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
  await sleep(3000);
  return sig;
}

async function readBoosterAndVersion(baseConn, pda) {
  const info = await baseConn.getAccountInfo(pda);
  if (!info || !info.data) return null;
  const d = info.data;
  if (d.length < 124) return { version: d.length >= 9 ? d[8] : 0, booster: 0, len: d.length };
  return { version: d[8], booster: Number(d.readBigInt64LE(116)), len: d.length };
}

function spendLedgerPlayers() {
  const set = new Set();
  try {
    const file = new URL('../.gfg-spend-ledger.json', import.meta.url).pathname;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    (Object.keys(j.players || {})).forEach(p => set.add(p));
    (j.players || {});
  } catch (e) { /* no ledger */ }
  return [...set];
}

async function supabasePlayers() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const set = new Set();
  if (!url || !key) return [...set];
  try {
    const r = await fetch(url + '/rest/v1/profiles?select=solana_wallet', { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    const j = await r.json();
    (Array.isArray(j) ? j : []).forEach(row => { if (row && row.solana_wallet) set.add(row.solana_wallet); });
  } catch (e) { /* optional */ }
  return [...set];
}

export async function upgradePremiumPda(playerPubkey) {
  const player = new PublicKey(playerPubkey);
  const [pda] = PublicKey.findProgramAddressSync([PREMIUM_SEED, player.toBytes()], PROGRAM_ID);
  const baseConn = createConnection(BASE_URL, 'confirmed');
  const info = await baseConn.getAccountInfo(pda);
  if (!info || !info.data) return { player: player.toBase58(), pda: pda.toBase58(), status: 'SKIP no premium account' };
  const version = info.data[8];
  if (version >= 3) return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'SKIP already v3' };
  return runMigration({ player, pda, data: info.data }, baseConn);
}

async function runMigration({ player, pda, data }, baseConn) {
  const version = data.length >= 9 ? data[8] : 0;
  const sponsor = loadSponsor();
  const label = version === 1 ? 'v1' : 'v2';
  const st = await getDelegationStatus(baseConn, pda).catch(() => null);

  let hostConn = null;
  if (st && st.isDelegated) {
    const host = regionUrlForFqdn(st.fqdn);
    if (!host) return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'FAIL unmapped fqdn' };
    hostConn = createConnection(host, 'processed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] });
    await waitPickup(hostConn, pda);
    try {
      await undelegateOnHost(sponsor, hostConn, player, pda);
      console.log(`  [${label}] undelegated on ${host}`);
    } catch (e) {
      return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'FAIL undelegate: ' + (e.message || '').slice(0, 140) };
    }
    await waitUndelegated(baseConn, pda);
  }

  try {
    const sig = await migrateBase(baseConn, sponsor, player, pda, version);
    console.log(`  [${label}] migrated base-layer ${sig}`);
  } catch (e) {
    return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'FAIL migrate: ' + (e.message || '').slice(0, 140) };
  }

  const rb = await readBoosterAndVersion(baseConn, pda);
  if (!rb || rb.version !== 3 || rb.booster !== 0) {
    return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'FAIL verify: ' + JSON.stringify(rb) };
  }

  let delegateSig = null;
  try {
    delegateSig = await reDelegateToAs(baseConn, sponsor, player, pda);
  } catch (e) {
    return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'MIGRATED but re-delegate FAILED: ' + (e.message || '').slice(0, 120) };
  }
  return { player: player.toBase58(), pda: pda.toBase58(), version, status: 'UPGRADED to v3 + re-delegated AS', delegateSig: (delegateSig || '').slice(0, 16) };
}

async function main() {
  const args = process.argv.slice(2);
  const playerArg = args.indexOf('--player') >= 0 ? args[args.indexOf('--player') + 1] : null;
  const results = [];
  if (playerArg) { results.push(await upgradePremiumPda(playerArg)); }
  else {
    const wallets = new Set([...spendLedgerPlayers(), ...(await supabasePlayers())]);
    console.log(`Sweeping ${wallets.size} wallet(s) (spend ledger + Supabase profiles) for premium PDAs...`);
    for (const w of wallets) { results.push(await upgradePremiumPda(w)); }
  }
  console.log('\nRESULTS:');
  results.forEach(r => console.log(JSON.stringify(r)));
  const fails = results.filter(r => /FAIL/.test(r.status || ''));
  if (fails.length) { console.log(`${fails.length} FAILURE(s)`); process.exitCode = 1; }
}
main();