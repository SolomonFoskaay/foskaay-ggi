// s1-tier-test.mjs — end-to-end harness for the S1 Active Tier "mirror only"
// path. Mirrors exactly what the browser does:
//   1. a fresh player is onboarded through the app-sponsored relay
//      (scripts/delegate-relay.mjs handleDelegate): dice PDA + points PDA
//      created + delegated, sponsor pays (~0.0086 SOL);
//   2. the player "buys" Tier 2 (1,000 spendable) — client/Supabase side, so
//      here we just apply computeWinReward() tier math (pure client logic);
//   3. a 1st-place win is banked: win-detection calls
//      magicblockDice.recordPoints(awarded, WIN_1ST, matchRef) — a pure
//      gasless ER write signed by the player session key (0 SOL), returning
//      the receipt signature;
//   4. we read the player's points PDA back from the ER and verify
//      total_points/award_count moved exactly as expected.
//
// Run: node scripts/lab/s1-tier-test.mjs  (needs a healthy devnet + sponsor)
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import bs58 from 'bs58';
import { BN } from 'bn.js';
import { pickErRpcUrl } from '../../src/gfg-rpc.js';

const ER_URL = pickErRpcUrl();
const PLAYER_SEED = Buffer.from('gfgplayerd');
const POINTS_SEED = Buffer.from('gfgpoints');

const idl = JSON.parse(readFileSync(new URL('../../src/gfg-dice-idl.json', import.meta.url), 'utf8'));

function loadSponsor() {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// matchRefFromSignature() from src/magicblock-er-vrf.js — first 8 bytes as u64.
function matchRefFromSignature(sig) {
  if (!sig) return new BN(0);
  try {
    const bytes = bs58.decode(sig);
    if (!bytes || bytes.length < 8) return new BN(0);
    return new BN(Buffer.from(bytes.slice(0, 8)).toString('hex'), 16);
  } catch (e) { return new BN(0); }
}

// The S1 ladder + daily-cap math, kept in lock-step with public/tiers.js.
// (This is the pure client function; it runs identically in the browser.)
function computeWinReward(base, tier, boostedToday) {
  const DAILY_BOOST_CAP = 1000;
  if (tier <= 1 || base <= 0) return { base, mult: 1, boosted: 0, total: base, capHit: false };
  const remaining = Math.max(0, DAILY_BOOST_CAP - boostedToday);
  const desired = base * (tier - 1);
  const boosted = Math.min(desired, remaining);
  return { base, mult: tier, boosted, total: base + boosted, capHit: boosted < desired };
}

async function main() {
  const sponsor = loadSponsor();
  console.log('sponsor:', sponsor.publicKey.toBase58());

  // === Step 1: fresh player onboarded through the relay ===
  const player = Keypair.generate();
  console.log('\n[1] fresh player:', player.publicKey.toBase58());

  const { handleDelegate } = await import('../../scripts/delegate-relay.mjs');
  const res = await handleDelegate(player.publicKey.toBase58());
  console.log('[1] relay:', res.delegated ? 'delegated OK' : 'FAILED', '| pda:', res.pda, '| pointsPda:', res.pointsPda);
  if (!res.delegated) throw new Error('relay did not delegate');

  const pointsPda = new PublicKey(res.pointsPda);
  const playerKey = res.pda;

  // === Step 2: Tier-2 buy (client/Supabase side) + boosted win math ===
  const tier = 2; // Tier 2 = 1,000 spendable/mo -> 2x
  const boostedToday = 0;
  const reward = computeWinReward(100, tier, boostedToday);
  console.log(`\n[2] Tier ${tier} win: base 100 -> mult ${reward.mult}x -> total ${reward.total} (boost +${reward.boosted})`);
  if (reward.total !== 200) throw new Error(`expected 200, got ${reward.total}`);

  // === Step 3: gasless ER record_points receipt (the on-chain mirror) ===
  const walletAdapter = {
    publicKey: player.publicKey,
    async signTransaction(t) { t.partialSign(player); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(player); return t; })); },
  };
  const erConn = new Connection(ER_URL, 'confirmed');
  const erProgram = new Program(idl, new AnchorProvider(erConn, walletAdapter, { commitment: 'confirmed', skipPreflight: true }));

  console.log('\n[3] waiting for ER pickup of points PDA...');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const info = await erConn.getAccountInfo(pointsPda); if (info && info.data.length > 0) break; } catch (_) {}
  }

  const matchRef = matchRefFromSignature('6nX' + 'a'.repeat(85)); // synthetic proof-roll sig
  const t0 = Date.now();
  const sig = await erProgram.methods
    .recordPoints('ludo', new BN(reward.total), 1 /* WIN_1ST */, matchRef)
    .accounts({ points: pointsPda, payer: player.publicKey, playerAuthority: player.publicKey })
    .rpc({ skipPreflight: true, commitment: 'confirmed' });
  console.log('[3] record_points receipt (gasless, 0 SOL):', sig, `(${Date.now() - t0}ms)`);

  // === Step 4: verify the PDA state on the ER ===
  console.log('\n[4] reading back player points PDA...');
  const acct = await erProgram.account.playerPoints.fetch(pointsPda);
  const pure = Number(acct.localPureLifetime ?? acct.local_pure_lifetime);
  const spendable = Number(acct.localSpendableBalance ?? acct.local_spendable_balance);
  const awardCount = Number(acct.awardCount ?? acct.award_count);
  console.log('[4] pure:', pure, '| spendable:', spendable, '| award_count:', awardCount, '| last_reason:', Number(acct.lastReason ?? acct.last_reason));
  if (pure !== reward.total) throw new Error(`expected pure ${reward.total}, got ${pure}`);
  if (spendable !== reward.total) throw new Error(`expected spendable ${reward.total}, got ${spendable}`);
  if (awardCount !== 1) throw new Error(`expected award_count 1, got ${awardCount}`);
  console.log('\n✅ S1 tier mirror PASS — boosted win recorded on-chain (both tracks), player paid 0 SOL');
}

main().catch(e => { console.error('\n❌ S1 tier test failed:', e.message || e); process.exit(1); });
