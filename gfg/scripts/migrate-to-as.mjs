// scripts/migrate-to-as.mjs
// Moves an already-delegated PDA off a flaky ER region onto AS (devnet-as).
//
// WHY (proven, see scripts/lab/migrate-probe.mjs, temp/deleted):
//   - An account's ER state lives on EXACTLY ONE region: the validator the
//     relay/delegator pinned it to via remaining_accounts. All pre-2026-08-18
//     accounts are pinned to the US validator (MUS3hc9...).
//   - The client previously rotated US OUT of its ER endpoint list, so rolls
//     were submitted to AS/EU while the account lived on US -> the VRF
//     callback landed on US, unseen by the AS/EU poll -> "Timeout waiting for
//     callback result" (reproduced in E3: roll on AS of a US-pinned account
//     NEVER landed).
//   - Region-aware targeting (src/magicblock-er-vrf.js) fixed the client: every
//     write+poll now resolves the account's hosting region from the Router and
//     targets it. That made US-pinned accounts work WHILE US answers, but US
//     intermittently returns "-32005 client temporarily banned".
//   - The durable fix is to RE-PIN accounts to a healthy region (AS). Re-pinning
//     is NOT possible directly (the delegation program rejects a re-delegate on
//     an already-delegated account: DlpError 27 DelegationRecordAlreadyInitialized).
//     The ONLY path is:
//       1. undelegate on the region hosting it (our program's `undelegate*`
//          instruction; any payer, including the sponsor, may sign - the
//          player_authority is NOT a signer),
//       2. re-delegate via a single `delegate*` step pinned to AS.
//     Proven end-to-end in migrate-probe.mjs: after migration the roll callback
//     lands on AS.
//
// COVERS ALL FOUR PDA TYPES (2026-08-18): the DICE PDA (gfgplayerd, original),
// plus the M3 POINTS (gfgpoints + game_tag), Scope C RESULT (gfgresult) and M4
// GLOBAL PDAs. The points/result/global undelegate variants (undelegate_points
// / undelegate_result / undelegate_global_points) were added to the program
// with this deploy (additive, same program id, no schema/seed changes - see
// .opencode/rules/solana-upgrade-safety.md), so a points ledger can now leave
// a flaky region too. Every tracked PDA now lands on AS.
//
// Safety (see .opencode/rules/solana-upgrade-safety.md):
//   - No account data is created/deleted: undelegate commits the ER state back
//     to the base layer (the account's bytes persist there), re-delegate
//     re-hosts those same bytes on AS.
//   - Additive instructions only: no seed/layout/program-id change, so no
//     data migration is needed and existing accounts keep deserializing.
//   - Idempotent: accounts already on AS are skipped; non-delegated accounts
//     are skipped (the relay pins AS on their next use).
//   - Run while the target account is idle (not mid-roll / mid-record).
//
// Usage:
//   node scripts/migrate-to-as.mjs                # house (sponsor) only
//   node scripts/migrate-to-as.mjs --player <pk>  # one player (all 4 PDA types)
//   node scripts/migrate-to-as.mjs --all          # EVERY wallet the program has
//                                                 #   ever touched: spend-ledger
//                                                 #   players + Supabase profile
//                                                 #   wallets + house (union).
//
// --all (2026-08-19, COMPLETE SWEEP): the spend ledger alone is NOT complete -
// wallets that onboarded before the ledger existed (or outside the relay) have
// NO ledger entry, so a ledger-only sweep silently leaves their PDAs pinned to
// a flaky region (the owner's own 42Xs2... was on US while --all reported all
// green). The authoritative "every wallet ever initiated by the program" set is
// the UNION of the spend ledger, Supabase profiles.solana_wallet (every
// signed-in user) and the house key. Account existence is checked on-chain per
// PDA (missing = skipped), so the wider list costs nothing extra.
//
// Env: sponsor key via GFG_Gasless_Sponsor_Keypair (Vercel) or
// ~/.config/solana/id.json (local), exactly like the delegate relay.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn } from '../src/gfg-rpc.js';
import { loadSponsor, isValidGameTag } from './delegate-relay.mjs';
import { recordSpend } from './spend-ledger.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const V_AS = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const MP = new PublicKey('Magic11111111111111111111111111111111111111');
const MC = new PublicKey('MagicContext1111111111111111111111111111111');
const PLAYER_SEED = Buffer.from('gfgplayerd');
const GLOBAL_TAG = Buffer.from('global');
const BASE_URL = baseRpcUrl();
const AS_MARKER = 'devnet-as';
const PICKUP_WAIT_MS = 15000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { ts.forEach(t => t.partialSign(kp)); return ts; },
  };
}

// Registered game tags used for per-game points PDAs (mirrors delegate-relay).
const GAME_TAGS = ['ludo', 'ludo_lab', 'sandbox', 'ayo_olopon', 'ayo_lab'];

async function waitPickup(conn, pda) {
  const deadline = Date.now() + PICKUP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length > 0) return true;
    } catch (e) { /* keep polling */ }
    await sleep(600);
  }
  return false;
}

async function waitDelegation(baseConn, pda, target) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const st = await getDelegationStatus(baseConn, pda).catch(() => null);
    if (st && st.isDelegated === target) return st;
    await sleep(900);
  }
  return null;
}

// ---- per-type descriptors: name label, pda seed, delegate/undelegate ix ---- //
// Each entry is driven by the SAME `#[delegate]`/`#[commit]` factory: the
// delegate instruction takes { buffer_*, delegation_record_*, delegation_metadata_*,
// <pda>, owner_program, delegation_program, system_program } + the AS validator
// as a remaining account; the undelegate instruction takes { payer,
// player_authority, <pda>, magic_program, magic_context }.
// Account keys use the camelCase forms the relay's delegate helpers use
// (bufferPlayer/bufferPoints/...); Anchor's snake_case→camelCase auto-mapping
// for these helper accounts is not reliable downstream of the `#[delegate]`
// macro, so mirror delegate-relay exactly.
const TYPES = {
  dice: {
    label: 'dice',
    seedsFor: (player) => [PLAYER_SEED, player.toBytes()],
    delegateIx: 'delegate',
    delegateAccount: 'player',
    bufAccount: 'bufferPlayer',
    recAccount: 'delegationRecordPlayer',
    metaAccount: 'delegationMetadataPlayer',
    undelegateIx: 'undelegate',
    undelegateAccount: 'player',
  },
  points: {
    label: 'points',
    // game_tag is data, so one delegate/undelegate per game tag.
    seedsFor: (player, gameTag) => [Buffer.from('gfgpoints'), Buffer.from(gameTag, 'utf8'), player.toBytes()],
    delegateIx: 'delegatePoints',
    delegateAccount: 'points',
    bufAccount: 'bufferPoints',
    recAccount: 'delegationRecordPoints',
    metaAccount: 'delegationMetadataPoints',
    undelegateIx: 'undelegatePoints',
    undelegateAccount: 'points',
    gameTagArg: true, // delegatePoints(gameTag) / undelegatePoints(gameTag)
  },
  result: {
    label: 'result',
    seedsFor: (player) => [Buffer.from('gfgresult'), player.toBytes()],
    delegateIx: 'delegateResult',
    delegateAccount: 'result',
    bufAccount: 'bufferResult',
    recAccount: 'delegationRecordResult',
    metaAccount: 'delegationMetadataResult',
    undelegateIx: 'undelegateResult',
    undelegateAccount: 'result',
  },
  global: {
    label: 'global',
    seedsFor: (player) => [Buffer.from('gfgpoints'), GLOBAL_TAG, player.toBytes()],
    delegateIx: 'delegateGlobalPoints',
    delegateAccount: 'globalPoints',
    bufAccount: 'bufferGlobalPoints',
    recAccount: 'delegationRecordGlobalPoints',
    metaAccount: 'delegationMetadataGlobalPoints',
    undelegateIx: 'undelegateGlobalPoints',
    undelegateAccount: 'global_points',
  },
};

function pdaFor(kind, player, gameTag) {
  const seeds = kind.seedsFor(new PublicKey(player), gameTag);
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

// Delegate a single PDA to AS (sponsor signs, one `delegate*` step). The
// account already exists (owner = our program after undelegate).
async function reDelegatePdaToAs(baseConn, player, pda, kind, gameTag) {
  const sponsor = loadSponsor();
  const prog = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

  // Build the account map cased per the IDL account names. The relay
  // (delegate-relay) proven working form uses pure camelCase keys
  // (bufferGlobalPoints/globalPoints); snake_case multi-word keys are not
  // reliably matched by Anchor's resolver for the #[delegate] helpers.
  const accounts = {
    payer: sponsor.publicKey,
    playerAuthority: player,
    [kind.bufAccount]: buffer,
    [kind.recAccount]: record,
    [kind.metaAccount]: metadata,
    [kind.delegateAccount]: pda,
    ownerProgram: PROGRAM_ID,
    delegationProgram: DELEGATION_PROGRAM,
    systemProgram: SystemProgram.programId,
  };

  let tx;
  if (kind.gameTagArg) {
    tx = await prog.methods[kind.delegateIx](gameTag).accounts(accounts).remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }]).transaction();
  } else {
    tx = await prog.methods[kind.delegateIx]().accounts(accounts).remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }]).transaction();
  }
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
  await sleep(3000);
  const after = await waitDelegation(baseConn, pda, true);
  return { sig, after };
}

// Migrate ONE player's PDA of one kind (dice / one game tag's points / result
// / global) to AS. Returns a summary object. Skips already-AS and non-delegated.
export async function migratePlayerPda(playerPubkey, kind, { baseConn, gameTag } = {}) {
  const player = new PublicKey(playerPubkey);
  const conn = baseConn || createConnection(BASE_URL, 'confirmed');
  const pda = pdaFor(kind, player, gameTag);
  const label = kind.gameTagArg ? `${kind.label}[${gameTag}]` : kind.label;

  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (!st || !st.isDelegated) {
    return { player: player.toBase58(), pda: pda.toBase58(), kind: label, status: 'SKIP not delegated (relay pins AS on next use)' };
  }
  if (st.fqdn && st.fqdn.includes(AS_MARKER)) {
    return { player: player.toBase58(), pda: pda.toBase58(), kind: label, currentRegion: st.fqdn, status: 'SKIP already AS' };
  }

  // 1) Undelegate on the hosting region (sponsor signs; player_authority is
  //    not a signer). Must be sent to the region the account lives on.
  const host = regionUrlForFqdn(st.fqdn);
  if (!host) return { player: player.toBase58(), pda: pda.toBase58(), kind: label, currentRegion: st.fqdn, status: 'SKIP unmapped region fqdn' };
  console.log(`[migrate] ${player.toBase58().slice(0, 8)} ${label} ${pda.toBase58().slice(0, 8)} is on ${host} - undelegating on that region...`);
  const hostConn = createConnection(host, 'processed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] });
  await waitPickup(hostConn, pda);
  const sponsor = loadSponsor();

  // Account map: payer, player_authority, <pda>, magic_program, magic_context.
  const undelegateAccounts = {
    payer: sponsor.publicKey,
    playerAuthority: player,
    [kind.undelegateAccount]: pda,
    magicProgram: MP,
    magicContext: MC,
  };
  const hostProg = new Program(idl, new AnchorProvider(hostConn, mkWallet(sponsor), { commitment: 'processed', skipPreflight: true }));
  let undelegateSig = null;
  try {
    let tx;
    if (kind.gameTagArg) {
      tx = await hostProg.methods[kind.undelegateIx](gameTag).accounts(undelegateAccounts).transaction();
    } else {
      tx = await hostProg.methods[kind.undelegateIx]().accounts(undelegateAccounts).transaction();
    }
    tx.feePayer = sponsor.publicKey;
    undelegateSig = await sendMagicTx(hostConn, tx, [sponsor], { skipPreflight: true });
    await hostConn.confirmTransaction({ signature: undelegateSig }, 'processed');
  } catch (e) {
    return { player: player.toBase58(), pda: pda.toBase58(), kind: label, currentRegion: host, status: `FAIL undelegate: ${(e.message || '').slice(0, 140)}` };
  }
  await waitDelegation(conn, pda, false);
  console.log(`  undelegate ${undelegateSig} -> isDelegated=false`);

  await waitDelegation(conn, pda, false);
  await sleep(3000);

  // 2) Re-delegate to AS (sponsor signs, one `delegate*` step).
  const balanceBefore = await conn.getBalance(sponsor.publicKey).catch(() => null);
  const rd = await reDelegatePdaToAs(conn, player, pda, kind, gameTag);
  const balanceAfter = await conn.getBalance(sponsor.publicKey).catch(() => null);
  const spent = Math.max(0, (balanceBefore ?? balanceAfter) - balanceAfter);
  if (spent > 0) {
    // Honest ops accounting: re-pins are migration costs borne by the sponsor,
    // not player onboarding, so they land as cap-exempt `migration` events
    // attributed to the player (never block their onboarding cap map).
    recordSpend(player.toBase58(), spent, { category: 'migration', steps: 1, capExempt: true });
    console.log(`  re-delegate spent ${(spent / 1e9).toFixed(6)} SOL (migration, cap-exempt)`);
  }
  const nowAs = !!(rd.after && rd.after.isDelegated && rd.after.fqdn && rd.after.fqdn.includes(AS_MARKER));
  return {
    player: player.toBase58(),
    pda: pda.toBase58(),
    kind: label,
    status: nowAs ? 'MIGRATED -> AS' : `CHECK after: ${(rd.after && rd.after.fqdn) || 'no fqdn'}`,
    undelegateSig: rd.sig,
    fqdn: (rd.after && rd.after.fqdn) || null,
  };
}

// Migrate every PDA type for a player: dice, each registered game tag's points
// PDA (only if it has been created), result, global.
export async function migratePlayerAll(playerPubkey, { baseConn } = {}) {
  const player = new PublicKey(playerPubkey);
  const results = [];
  results.push(await migratePlayerPda(player.toBase58(), TYPES.dice, { baseConn }));

  // Points PDAs exist only for game tags that have actually been used; check
  // the account exists (getDelegationStatus errors on a missing PDA's buffer,
  // so probe getAccountInfo first via a light status check).
  for (const gameTag of GAME_TAGS) {
    const pda = pdaFor(TYPES.points, player, gameTag);
    const conn = baseConn || createConnection(BASE_URL, 'confirmed');
    const info = await conn.getAccountInfo(pda).catch(() => null);
    if (!info || info.data.length === 0) continue; // never initialized
    results.push(await migratePlayerPda(player.toBase58(), TYPES.points, { baseConn, gameTag }));
  }

  results.push(await migratePlayerPda(player.toBase58(), TYPES.result, { baseConn }));
  results.push(await migratePlayerPda(player.toBase58(), TYPES.global, { baseConn }));
  return results;
}

function spendLedgerPlayers() {
  try {
    const ledger = JSON.parse(readFileSync(join(process.cwd(), '.gfg-spend-ledger.json'), 'utf8'));
    const set = new Set();
    for (const pk of Object.keys(ledger.players || {})) set.add(pk);
    for (const ev of (ledger.events || [])) if (ev.player) set.add(ev.player);
    return [...set];
  } catch (e) {
    return [];
  }
}

// Every signed-in wallet (Supabase profiles.solana_wallet). The spend ledger
// misses wallets that onboarded before the ledger existed; Supabase profiles
// are created for every email-OTP sign-in, so this is the authoritative "all
// users" list. Read via the REST API with the publishable key (matches
// scripts/restore-points.mjs).
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
    console.warn(`[migrate] WARN supabase profiles lookup failed (${e.message}) - using spend ledger only`);
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sponsor = loadSponsor();
  const targets = new Set([sponsor.publicKey.toBase58()]); // house always

  const pIdx = args.indexOf('--player');
  if (pIdx !== -1) targets.add(args[pIdx + 1]);
  if (args.includes('--all')) {
    for (const pk of spendLedgerPlayers()) targets.add(pk);
    for (const pk of await supabasePlayers()) targets.add(pk);
  }

  const baseConn = createConnection(BASE_URL, 'confirmed');
  const results = [];
  for (const pk of targets) {
    try { results.push(...await migratePlayerAll(pk, { baseConn })); }
    catch (e) { results.push({ player: pk, status: `ERROR ${(e.message || '').slice(0, 140)}` }); }
  }
  console.log('\n===== MIGRATION SUMMARY =====');
  for (const r of results) console.log(`- ${r.player.slice(0, 8)}.. ${r.pda ? r.pda.slice(0, 8) + '..' : ''} ${r.kind || ''} ${r.status}`);
}

if (process.argv[1] && process.argv[1].endsWith('migrate-to-as.mjs')) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}