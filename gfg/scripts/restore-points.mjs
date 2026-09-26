// scripts/restore-points.mjs
// M3 — on-chain points restore tool (devnet, data preservation).
//
// Supabase is the backup store; on a devnet wipe (or any event that zeroes an
// on-chain ledger) this rebuilds the [gfgpoints, game_tag, player] ledgers so
// no player loses points. Records written here are the same gasless
// record_points write the game uses, signed by the sponsor key on the ER.
//
// Modes:
//   explicit:  node scripts/restore-points.mjs <wallet>=<points> [<wallet>=<points>...]
//              node scripts/restore-points.mjs --game-tag ludo <wallet>=<points>...
//   supabase:  node scripts/restore-points.mjs --from-supabase [--game-tag ludo]
//              Joins profiles.solana_wallet -> point_transactions and credits
//              each player's ledger with their total win points for that game.
//
// Each credit runs handleDelegate (idempotent; creates + delegates the tagged
// PDA if missing) then record_points gasless on the ER. Safety: a ledger that
// already holds points is skipped unless --force is passed, so a re-run never
// double-credits.

import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const SUPABASE_URL = 'https://ywrgxynjjgdicdzizpue.supabase.co';
const SUPABASE_KEY = 'sb_publishable_qbrLQtG1fx51sBIiDm_zGQ_dR6BcqEb';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

async function waitErPickup(pda, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* ER still warming up */ }
    await sleep(delay);
  }
  throw new Error(`points PDA not picked up by ER after ${tries} tries: ${pda.toBase58()}`);
}

async function creditPoints(sponsor, playerPubkey, gameTag, points) {
  if (!(points > 0)) throw new Error('points must be > 0');

  // arcv2m3: the per-game points PDA is RETIRED - every local award now lands in
  // the player's Player Core bucket [gfgcore, player]. handleDelegate is
  // idempotent and creates + delegates BOTH the dice PDA and the core, so this
  // is the same one-time onboarding the game itself uses.
  await handleDelegate(playerPubkey.toBase58(), gameTag);
  const [corePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('gfgcore'), playerPubkey.toBytes()], new PublicKey(idl.address));

  const { program } = erProgram(sponsor);
  await waitErPickup(corePda);

  // Read the bucket through the program's own decoder (no raw offsets).
  const bucketOf = (acc) => {
    for (let i = 0; i < acc.bucketCount; i++) {
      const t = Buffer.from(acc.buckets[i].gameTag).toString('utf8').replace(/\0+$/, '');
      if (t === gameTag) {
        return { pure: acc.buckets[i].localPure.toNumber(), spendable: acc.buckets[i].localSpendable.toNumber() };
      }
    }
    return { pure: 0, spendable: 0 };
  };

  const before = bucketOf(await program.account.playerCore.fetch(corePda));
  if (before.pure > 0 && !process.argv.includes('--force')) {
    console.log(`[restore] SKIP ${playerPubkey.toBase58().slice(0, 8)} (${gameTag}): core bucket already holds ${before.pure} pure / ${before.spendable} spendable`);
    return { skipped: true, before };
  }

  const tx = await program.methods
    .recordCorePoints(gameTag, new BN(points), 1, new BN(Date.now()))
    .accounts({
      core: corePda,
      payer: sponsor.publicKey,
      playerAuthority: playerPubkey,
    })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(program.provider.connection, tx, [sponsor], { skipPreflight: true });
  await program.provider.connection.confirmTransaction({ signature: sig }, 'confirmed');

  const after = bucketOf(await program.account.playerCore.fetch(corePda));
  console.log(`[restore] CREDITED ${playerPubkey.toBase58().slice(0, 8)} (${gameTag}): +${points} -> core pure ${after.pure}, spendable ${after.spendable}`);
  console.log(`[restore] tx ${sig}`);
  return { sig, after };
}

async function fromSupabase(gameTag) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const [profilesRes, txsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,solana_wallet`, { headers: h }),
    fetch(`${SUPABASE_URL}/rest/v1/point_transactions?select=user_id,game_id,points,reason`, { headers: h }),
  ]);
  const profiles = await profilesRes.json();
  const txs = await txsRes.json();
  if (!Array.isArray(profiles) || !Array.isArray(txs)) throw new Error('Supabase read failed: ' + JSON.stringify({ profiles: profilesRes.status, txs: txsRes.status }));

  const walletByUser = new Map(profiles.filter((p) => p.solana_wallet).map((p) => [p.id, p.solana_wallet]));
  const perPlayer = new Map();
  for (const t of txs) {
    if (t.game_id !== gameTag || t.reason === 'signup_bonus') continue;
    if (!walletByUser.has(t.user_id)) continue;
    const wallet = walletByUser.get(t.user_id);
    perPlayer.set(wallet, (perPlayer.get(wallet) || 0) + (t.points || 0));
  }
  if (perPlayer.size === 0) {
    console.log(`[restore] no Supabase win rows for game_tag "${gameTag}" with a known wallet. Nothing to do.`);
    return [];
  }
  console.log(`[restore] Supabase rebuild for "${gameTag}": ${[...perPlayer.entries()].map(([w, p]) => `${w.slice(0, 8)}=${p}`).join(', ')}`);
  return [...perPlayer.entries()];
}

async function main() {
  const argv = process.argv.slice(2);
  const gameTag = argv.includes('--game-tag') ? argv[argv.indexOf('--game-tag') + 1] : 'ludo';
  const force = argv.includes('--force');
  void force;

  const sponsor = loadSponsor();
  const conn = createConnection(baseRpcUrl(), 'confirmed');
  void conn;

  let targets = [];
  if (argv.includes('--from-supabase')) {
    targets = await fromSupabase(gameTag);
  } else {
    const pairs = argv.filter((a) => a.includes('=') && !a.startsWith('--'));
    if (pairs.length === 0) {
      console.log('Usage:');
      console.log('  node scripts/restore-points.mjs <wallet>=<points> [...] [--game-tag ludo] [--force]');
      console.log('  node scripts/restore-points.mjs --from-supabase [--game-tag ludo] [--force]');
      process.exit(1);
    }
    targets = pairs.map((p) => {
      const [w, pts] = p.split('=');
      return [w, Number(pts)];
    });
  }

  for (const [wallet, points] of targets) {
    try {
      await creditPoints(sponsor, new PublicKey(wallet), gameTag, points);
    } catch (e) {
      console.error(`[restore] FAILED ${wallet.slice(0, 8)}: ${e.message}`);
    }
    await sleep(300);
  }
  console.log('[restore] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
