// scripts/migrate-to-core.mjs
// arcv2m3 (2026-09): move the RETIRED point ledgers INTO the Player Core.
//
// The retired accounts (created before the Player Core cutover) hold real
// points. Because the app now reads ONLY the core, those balances would look
// like 0. This script copies them into the core with the permissionless,
// idempotent on-chain instructions:
//   migrate_core_bucket(game_tag)  [gfgpoints, game_tag, player] -> core bucket
//   migrate_core_global            [gfgpoints, 'global', player] -> core globals
//   migrate_core_premium           [gfgprem, player]             -> core premium
// Each instruction reads the old bytes fully, adds them to the core, then
// ZEROES the source, so a re-run copies zero and no point is ever double
// counted or lost.
//
// Usage:
//   node scripts/migrate-to-core.mjs --audit          # READ-ONLY: show every wallet
//   node scripts/migrate-to-core.mjs --all            # migrate the union of wallets
//   node scripts/migrate-to-core.mjs --player <pk>    # migrate one wallet
//
// The wallet list is the SAME union the AS sweep uses: spend-ledger players +
// Supabase profiles.solana_wallet + the house key. Account existence is checked
// on-chain per PDA, so a wide list costs nothing.

import './load-env.mjs';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@anchor-lang/core';
import { readFileSync } from 'fs';
import { join } from 'path';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const CORE_SEED = Buffer.from('gfgcore');
const POINTS_SEED = Buffer.from('gfgpoints');
const GLOBAL_TAG = Buffer.from('global');
const PREMIUM_SEED = Buffer.from('gfgprem');
const GAME_TAGS = ['ludo'];

const baseConn = createConnection(baseRpcUrl(), 'confirmed');
const sponsor = loadSponsor();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- wallet enumeration (same union as migrate-to-as.mjs) ----------
function spendLedgerPlayers() {
  try {
    const ledger = JSON.parse(readFileSync(join(process.cwd(), '.gfg-spend-ledger.json'), 'utf8'));
    const set = new Set();
    for (const pk of Object.keys(ledger.players || {})) set.add(pk);
    for (const ev of (ledger.events || [])) if (ev.player) set.add(ev.player);
    return [...set];
  } catch (e) { return []; }
}
const SUPABASE_URL = 'https://ywrgxynjjgdicdzizpue.supabase.co';
const SUPABASE_KEY = 'sb_publishable_qbrLQtG1fx51sBIiDm_zGQ_dR6BcqEb';
async function supabasePlayers() {
  try {
    const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=solana_wallet`, { headers: h });
    if (!res.ok) throw new Error(`supabase ${res.status}`);
    const rows = await res.json();
    const set = new Set();
    for (const p of rows) if (p && p.solana_wallet) set.add(p.solana_wallet);
    return [...set];
  } catch (e) {
    console.warn(`[core-migrate] WARN supabase lookup failed (${e.message})`);
    return [];
  }
}

// ---------- connections / programs (region-aware) ----------
const programsByUrl = new Map();
function programFor(conn) {
  const url = conn.rpcEndpoint || 'base';
  if (!programsByUrl.has(url)) {
    const provider = new AnchorProvider(conn, new Wallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
    programsByUrl.set(url, new Program(idl, provider));
  }
  return programsByUrl.get(url);
}
async function connFor(pda) {
  try {
    const st = await getDelegationStatus(baseConn, pda);
    if (st && st.isDelegated) {
      const url = regionUrlForFqdn(st.fqdn) || pickErRpcUrl();
      return { conn: createConnection(url, 'confirmed', 8000), delegated: true, url };
    }
    return { conn: baseConn, delegated: false, url: 'base' };
  } catch (e) {
    return { conn: baseConn, delegated: false, url: 'base' };
  }
}
async function fetchAcc(kind, pda) {
  const { conn, delegated, url } = await connFor(pda);
  const prog = programFor(conn);
  try {
    const acc = await prog.account[kind].fetch(pda);
    return { acc, delegated, url };
  } catch (e) {
    return null;
  }
}

// ---------- PDAs ----------
const coreFor = (pk) => PublicKey.findProgramAddressSync([CORE_SEED, pk.toBytes()], PROGRAM_ID)[0];
const pointsFor = (tag, pk) => PublicKey.findProgramAddressSync([POINTS_SEED, Buffer.from(tag, 'utf8'), pk.toBytes()], PROGRAM_ID)[0];
const globalFor = (pk) => PublicKey.findProgramAddressSync([POINTS_SEED, GLOBAL_TAG, pk.toBytes()], PROGRAM_ID)[0];
const premiumFor = (pk) => PublicKey.findProgramAddressSync([PREMIUM_SEED, pk.toBytes()], PROGRAM_ID)[0];

const n = (v) => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  try { if (typeof v.toNumber === 'function') return v.toNumber(); } catch (e) { /* > 2^53 */ }
  return Number(v.toString ? v.toString() : v);
};
function coreView(c) {
  if (!c) return null;
  const buckets = {};
  for (const b of (c.buckets || []).slice(0, c.bucketCount)) {
    const tag = Buffer.from(b.gameTag).toString('utf8').replace(/\0+$/, '');
    buckets[tag] = { pure: n(b.localPure), spendable: n(b.localSpendable) };
  }
  return {
    buckets,
    globalPure: n(c.globalPure), globalLifetime: n(c.globalLifetime), globalSpendable: n(c.globalSpendable),
    premiumLifetime: n(c.premiumLifetime), premiumSpendable: n(c.premiumSpendable),
    level: c.subscriptionLevel, subUntil: n(c.subscriptionActiveUntil), boosterUntil: n(c.boosterActiveUntil),
  };
}

// Make sure the player has a Player Core that exists AND is delegated (the
// migration writes land on the core, so it must be live on the ER). Uses the
// relay's idempotent handleDelegate: a player whose core is missing gets it
// created + delegated in the same call; an already-delegated player is a no-op.
async function ensureCore(pk) {
  const corePda = coreFor(pk);
  const st = await getDelegationStatus(baseConn, corePda).catch(() => null);
  if (!st || !st.isDelegated) {
    console.log(`    [ensureCore] onboarding Player Core for ${pk.toBase58().slice(0, 8)}..`);
    await handleDelegate(pk.toBase58(), 'ludo');
    for (let i = 0; i < 30; i++) {
      const s = await getDelegationStatus(baseConn, corePda).catch(() => null);
      if (s && s.isDelegated) break;
      await sleep(900);
    }
  }
  for (let i = 0; i < 25; i++) {
    const { conn } = await connFor(corePda);
    const info = await conn.getAccountInfo(corePda).catch(() => null);
    if (info) return true;
    await sleep(700);
  }
  return false;
}

// ---------- migrate one wallet ----------
async function migrateWallet(pkStr, { audit }) {
  let pk;
  try { pk = new PublicKey(pkStr); } catch (e) { return { player: pkStr, status: 'bad pubkey' }; }
  const corePda = coreFor(pk);
  const jobs = [];

  const coreRes = await fetchAcc('playerCore', corePda);
  const coreBefore = coreRes ? coreView(coreRes.acc) : null;

  // per-game bucket
  for (const tag of GAME_TAGS) {
    const pda = pointsFor(tag, pk);
    const res = await fetchAcc('playerPoints', pda);
    if (!res) continue;
    const pure = n(res.acc.localPureLifetime), spendable = n(res.acc.localSpendableBalance);
    if (pure > 0 || spendable > 0) jobs.push({ type: 'bucket', tag, pda, pure, spendable, delegated: res.delegated });
  }
  // global
  {
    const pda = globalFor(pk);
    const res = await fetchAcc('globalPoints', pda);
    if (res) {
      const pure = n(res.acc.globalPureLifetime), lifetime = n(res.acc.globalLifetime), spendable = n(res.acc.globalSpendableBalance);
      if (pure > 0 || lifetime > 0 || spendable > 0) jobs.push({ type: 'global', pda, pure, lifetime, spendable, delegated: res.delegated });
    }
  }
  // premium (v3 layout)
  {
    const pda = premiumFor(pk);
    const res = await fetchAcc('premiumPoints', pda);
    if (res) {
      const lifetime = n(res.acc.premiumLifetime), spendable = n(res.acc.premiumSpendable);
      if (lifetime > 0 || spendable > 0) jobs.push({ type: 'premium', pda, lifetime, spendable, delegated: res.delegated });
    }
  }

  if (audit) {
    const c = coreBefore;
    const cNonZero = c && (
      Object.values(c.buckets).some(b => b.pure > 0 || b.spendable > 0) ||
      c.globalPure > 0 || c.globalLifetime > 0 || c.globalSpendable > 0 ||
      c.premiumLifetime > 0 || c.premiumSpendable > 0
    );
    return { player: pkStr, coreBefore, jobs, coreNonZero: cNonZero, status: jobs.length ? 'HAS LEGACY' : 'clean' };
  }

  if (!jobs.length) return { player: pkStr, coreBefore, jobs: [], status: 'nothing to do' };

  try {
    await ensureCore(pk);
  } catch (e) {
    return { player: pkStr, coreBefore, jobs, status: `ERROR ensureCore: ${(e.transactionMessage || e.message || '').slice(0, 160)}` };
  }

  const results = [];
  const { conn: erConn } = await connFor(coreFor(pk));
  const prog = programFor(erConn);
  for (const job of jobs) {
    if (!job.delegated) { results.push(`${job.type}: NOT DELEGATED (left as-is)`); continue; }
    try {
      if (job.type === 'bucket') {
        const sig = await prog.methods.migrateCoreBucket(job.tag)
          .accounts({ payer: sponsor.publicKey, playerAuthority: pk, core: corePda, legacyPoints: job.pda })
          .rpc();
        results.push(`bucket/${job.tag}: +${job.pure}p/+${job.spendable}s -> ${String(sig).slice(0, 12)}`);
      } else if (job.type === 'global') {
        const sig = await prog.methods.migrateCoreGlobal()
          .accounts({ payer: sponsor.publicKey, playerAuthority: pk, core: corePda, legacyGlobal: job.pda })
          .rpc();
        results.push(`global: +${job.pure}p/+${job.lifetime}l/+${job.spendable}s -> ${String(sig).slice(0, 12)}`);
      } else {
        const sig = await prog.methods.migrateCorePremium()
          .accounts({ payer: sponsor.publicKey, playerAuthority: pk, core: corePda, legacyPremium: job.pda })
          .rpc();
        results.push(`premium: +${job.lifetime}l/+${job.spendable}s -> ${String(sig).slice(0, 12)}`);
      }
      await sleep(400);
    } catch (e) {
      results.push(`${job.type}: FAILED ${(e.transactionMessage || e.message || '').slice(0, 120)}`);
    }
  }
  const coreAfterRes = await fetchAcc('playerCore', corePda);
  return { player: pkStr, coreBefore, coreAfter: coreAfterRes ? coreView(coreAfterRes.acc) : null, jobs, results, status: 'migrated' };
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const audit = args.includes('--audit');
  const targets = new Set([sponsor.publicKey.toBase58()]);
  const pIdx = args.indexOf('--player');
  if (pIdx !== -1) targets.add(args[pIdx + 1]);
  if (args.includes('--all')) {
    for (const pk of spendLedgerPlayers()) targets.add(pk);
    for (const pk of await supabasePlayers()) targets.add(pk);
  }
  console.log(`[core-migrate] ${audit ? 'AUDIT (read-only)' : 'MIGRATE'} | wallets: ${targets.size}`);

  let hasLegacy = 0, migrated = 0;
  for (const pk of targets) {
    let r;
    try { r = await migrateWallet(pk, { audit }); }
    catch (e) { r = { player: pk, status: `ERROR ${(e.message || '').slice(0, 140)}` }; }
    if (r.status && /^ERROR/.test(r.status)) { console.log(`- ${pk} ${r.status}`); continue; }
    if (r.jobs && r.jobs.length) {
      hasLegacy++;
      console.log(`- ${pk} ${r.status} | core before: ${r.coreBefore ? JSON.stringify(r.coreBefore.buckets) : 'none'}`);
      for (const j of r.jobs) console.log(`    legacy ${j.type}${j.tag ? '/' + j.tag : ''} @ ${j.pda.toBase58().slice(0, 8)}.. pure=${j.pure ?? '-'} lifetime=${j.lifetime ?? '-'} spendable=${j.spendable} delegated=${j.delegated}`);
      if (r.results) { for (const x of r.results) console.log(`    -> ${x}`); }
      if (r.coreAfter) console.log(`    core after: ${JSON.stringify(r.coreAfter.buckets)} global=${r.coreAfter.globalLifetime} premiumL=${r.coreAfter.premiumLifetime}`);
      if (r.status === 'migrated') migrated++;
    } else if (audit && r.coreNonZero) {
      console.log(`- ${pk} CORE HOLDS POINTS | ${JSON.stringify(r.coreBefore)}`);
    }
  }
  console.log(`\n===== SUMMARY =====\nwallets with legacy balances: ${hasLegacy}\nmigrated: ${migrated}`);
}
main().catch(e => { console.error('fatal', e); process.exit(1); });
