// scripts/er-premium-points-harness.mjs
// M5 — on-chain harness proving the PREMIUM points + Active Tier launch engine:
// initialize_premium_points + delegate_premium_points + credit_premium_points
// + spend_premium_points + activate_subscription_level run against the live
// program and land on the correct buy-only premium ledger ([gfgprem, player]).
//
// Benchmark = the locked M5 spec (architecture.json / TEST section):
//   credit-then-activate: admin credits 5,000P -> activate_subscription_level(1)
//     deducts it and sets subscription_level=1 + active window (30d, no auto-renew).
//   idempotency: re-credit the SAME credit_ref = no-op (DuplicateCreditRef);
//     re-activate while a sub is already active = AlreadyActive.
//   spend guard: cannot spend premium below balance; premium never feeds
//     global (M4) or local (M3) ledgers.
//
// Flow:
//   1. Fresh player keypair (0 SOL). handleDelegate creates + delegates the
//      PREMIUM PDA alongside the other 4 PDAs.
//   2. handleCreditPremium credits 5,000P (ref=101). Delegation-aware: it
//      undelegates -> base-layer credit -> re-delegates to AS. Read back on the
//      ER: premium_lifetime=5000, premium_spendable=5000, level=0.
//   3. Idempotency: re-credit the SAME ref (101) must NO-OP (DuplicateCreditRef
//      guard surfaced by the relay, ledger unchanged at 5000/5000).
//   4. activate_subscription_level(1) (gasless ER write): spendable 5000 -> 0,
//      level 1, active_until ~ now+30d. Re-activate now = AlreadyActive.
//   5. spend_premium_points guard: spend 700 (>0 balance) succeeds; an
//      overdraw (spend while balance < amount) is rejected.
//   6. Premium never feeds global: the player's global points PDA stays 0/0/0.
//
// Run: node scripts/er-premium-points-harness.mjs   (exit 0 = pass)

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { createConnection, sendMagicTx, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, handleCreditPremium, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const PREMIUM_SEED = Buffer.from('gfgprem', 'utf8');
const GLOBAL_SEED = Buffer.from('global', 'utf8');
const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');
const PROGRAM_ID = new PublicKey(idl.address || idl.metadata?.address);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

// Decode through the Anchor account coder (the SAME path the client SDK's
// fetchPremiumPointsPda uses), never raw bytes.
const decodePremiumLedger = async (program, pda) => {
  const acct = await program.account.premiumPoints.fetch(pda).catch(() => null);
  if (!acct) return null;
  return {
    version: Number(acct.version ?? 0),
    adminAuthority: (acct.adminAuthority ?? acct.admin_authority)?.toBase58?.() ?? '',
    premiumLifetime: Number(acct.premiumLifetime ?? acct.premium_lifetime ?? 0),
    premiumSpendable: Number(acct.premiumSpendable ?? acct.premium_spendable ?? 0),
    subscriptionLevel: Number(acct.subscriptionLevel ?? acct.subscription_level ?? 0),
    subscriptionActiveUntil: Number(acct.subscriptionActiveUntil ?? acct.subscription_active_until ?? 0),
    lastCreditRef: (acct.lastCreditRef ?? acct.last_credit_ref)?.toString() ?? '0',
    lastSpendRef: (acct.lastSpendRef ?? acct.last_spend_ref)?.toString() ?? '0',
    lastSpendReason: Number(acct.lastSpendReason ?? acct.last_spend_reason ?? 0),
    spendCount: Number(acct.spendCount ?? acct.spend_count ?? 0),
  };
};

const decodeGlobalLedger = async (program, pda) => {
  const acct = await program.account.globalPoints.fetch(pda).catch(() => null);
  if (!acct) return null;
  return {
    globalPureLifetime: Number(acct.globalPureLifetime ?? acct.global_pure_lifetime ?? 0),
    globalLifetime: Number(acct.globalLifetime ?? acct.global_lifetime ?? 0),
    globalSpendableBalance: Number(acct.globalSpendableBalance ?? acct.global_spendable_balance ?? 0),
  };
};

function premiumPda(playerPubkey) {
  return PublicKey.findProgramAddressSync([PREMIUM_SEED, playerPubkey.toBytes()], PROGRAM_ID);
}
function globalPda(playerPubkey) {
  return PublicKey.findProgramAddressSync([POINTS_SEED, GLOBAL_SEED, playerPubkey.toBytes()], PROGRAM_ID);
}

async function waitErPickup(pda, tries = 30, delay = 600) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout for premium PDA');
}

async function write(program, sponsor, build) {
  const tx = await build;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(program.provider.connection, tx, [sponsor], { skipPreflight: true });
  const resp = await program.provider.connection.confirmTransaction({ signature: sig }, 'confirmed');
  // A failed on-chain instruction confirms with value.err set; surface it as a
  // throw with the raw detail so the harness can match the Custom error code.
  const rerr = resp && resp.value && resp.value.err;
  if (rerr) throw new Error('Transaction failed on-chain: ' + JSON.stringify(rerr));
  return sig;
}

let failures = 0;
function assert(label, cond, extra) {
  if (cond) console.log(`  ok  ${label}`);
  else { failures++; console.log(`FAIL  ${label}${extra ? ' :: ' + extra : ''}`); }
}

// PointsError custom codes (Anchor 6000 base; see the enum in lib.rs).
const ERR = {
  DuplicateCreditRef: 6026,
  InsufficientPremiumBalance: 6024,
  AlreadyActive: 6025,
  NotAdmin: 6027,
};
// A thrown tx surfaces as 'Transaction failed on-chain: {"InstructionError":...
// {"Custom":6016}' (or a BN/u32 variant); match the numeric code anywhere.
function customCode(e) {
  const s = String(e && e.message || e);
  const m = s.match(/["':]?\s*Custom\s*[:=]?\s*(\d+)/i) || s.match(/Custom[^\d]*(\d+)/);
  return m ? Number(m[1]) : null;
}
function rejectedWith(e, code) {
  const c = customCode(e);
  const s = String(e && e.message || e).toLowerCase();
  const msgMatch =
    code === ERR.DuplicateCreditRef ? /duplicate credit/i.test(s) || /credit_ref already/i.test(s) || /DuplicateCreditRef/i.test(s)
    : code === ERR.InsufficientPremiumBalance ? /insufficient premium balance/i.test(s) || /InsufficientPremiumBalance/i.test(s)
    : code === ERR.NotAdmin ? /admin authority/i.test(s) || /NotAdmin/i.test(s)
    : false;
  return msgMatch || c === code;
}

async function main() {
  const sponsor = loadSponsor();
  const player = Keypair.generate();
  console.log(`player: ${player.publicKey.toBase58()}`);
  const playerStr = player.publicKey.toBase58();

  // Step 1: onboarding creates + delegates the premium PDA
  const { premiumPointsPda } = await handleDelegate(playerStr, 'ludo');
  console.log(`premiumPointsPda: ${premiumPointsPda}`);
  const [premPub] = premiumPda(player.publicKey);
  const [gblPub] = globalPda(player.publicKey);

  const { program } = erProgram(sponsor);
  await waitErPickup(premPub);

  const readPrem = () => decodePremiumLedger(program, premPub);
  const readGlobal = () => decodeGlobalLedger(program, gblPub);

  const A = await readPrem();
  console.log('after delegate:', JSON.stringify(A));
  assert('fresh premium ledger is zero (lifetime/spendable 0, level 0)',
    A !== null && A.premiumLifetime === 0 && A.premiumSpendable === 0 && A.subscriptionLevel === 0,
    JSON.stringify(A));

  // Step 2: admin credit 5,000P (ref=101)
  const c1 = await handleCreditPremium(playerStr, 5000, 101);
  console.log(`credit(5000, ref=101) sig ${(c1.sig || '').slice(0, 12)} undelegated=${c1.undelegated} redelegated=${c1.redelegated}`);
  await waitErPickup(premPub); // re-delegated PDA re-appears on the ER
  await sleep(800);
  const B = await readPrem();
  console.log('after credit:', JSON.stringify(B));
  assert('admin credit banks 5000 lifetime + 5000 spendable',
    B !== null && B.premiumLifetime === 5000 && B.premiumSpendable === 5000,
    JSON.stringify(B));
  assert('last_credit_ref recorded = 101', B !== null && B.lastCreditRef === '101', JSON.stringify(B));

  // Step 3: idempotency — same credit_ref must be a no-op (DuplicateCreditRef)
  let dupRejected = false;
  try {
    await handleCreditPremium(playerStr, 5000, 101);
  } catch (e) {
    dupRejected = rejectedWith(e, ERR.DuplicateCreditRef);
    console.log('  re-credit(same ref) rejected:', String(e && e.message || e).slice(0, 80));
  }
  const C = await readPrem();
  assert('re-credit SAME ref is rejected (no double credit)', dupRejected, '(was accepted — double credit risk!)');
  assert('ledger unchanged after rejected re-credit (5000/5000)',
    C !== null && C.premiumLifetime === 5000 && C.premiumSpendable === 5000,
    JSON.stringify(C));

  //   Step 4: activate_subscription_level(1) (gasless ER) — spendable 5000 -> 0,
//   level 1 (L1 = 5,000P at 500 pts = $1; owner 2026-08-31)
  const s1 = await write(program, sponsor,
    program.methods.activateSubscriptionLevel(new BN(1)).accounts({
      premiumPoints: premPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const D = await readPrem();
  const now = Math.floor(Date.now() / 1000);
  console.log(`activate_subscription_level(1) ${s1.slice(0, 12)} -> ${JSON.stringify(D)}`);
  assert('activation deducts the full 5,000 spendable (spendable now 0)',
    D !== null && D.premiumSpendable === 0 && D.premiumLifetime === 5000, JSON.stringify(D));
  assert('subscription_level = 1 (L1, 5,000P)', D !== null && D.subscriptionLevel === 1, JSON.stringify(D));
  assert('subscription_active_until ~ now+30d (window, NO auto-renew field)',
    D !== null && D.subscriptionActiveUntil >= now + 29 * 86400 && D.subscriptionActiveUntil <= now + 31 * 86400,
    `active_until=${D && D.subscriptionActiveUntil} now=${now}`);

  // Step 4b: re-activate while a sub is already active -> AlreadyActive
  const ERR_ALREADY_ACTIVE = 6025;
  let reactRejected = false;
  try {
    await write(program, sponsor,
      program.methods.activateSubscriptionLevel(new BN(1)).accounts({
        premiumPoints: premPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
      }).transaction());
  } catch (e) {
    reactRejected = rejectedWith(e, ERR_ALREADY_ACTIVE);
    console.log('  re-activate rejected:', String(e && e.message || e).slice(0, 80));
  }
  const E = await readPrem();
  assert('re-activate while sub active is rejected (AlreadyActive)', reactRejected);
  assert('ledger still spendable 0 / level 1 after rejected re-activate',
    E !== null && E.premiumSpendable === 0 && E.subscriptionLevel === 1, JSON.stringify(E));

  // Step 5: credit a second tranche (ref=202) so the spend guard can be tested
  const c2 = await handleCreditPremium(playerStr, 1000, 202);
  await waitErPickup(premPub);
  await sleep(800);
  const F = await readPrem();
  console.log('after second credit (1000, ref=202):', JSON.stringify(F));
  assert('second credit banks 1000 (total 6000 lifetime / 1000 spendable)',
    F !== null && F.premiumLifetime === 6000 && F.premiumSpendable === 1000, JSON.stringify(F));

  // Step 5b: spend_premium_points 700 -> spendable 300 (lifetime untouched)
  const s2 = await write(program, sponsor,
    program.methods.spendPremiumPoints(new BN(700), 21, new BN(901)).accounts({
      premiumPoints: premPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const G = await readPrem();
  console.log(`spend_premium(-700, reason=21, ref=901) ${s2.slice(0, 12)} -> ${JSON.stringify(G)}`);
  assert('premium spend draws only spendable (300 left, lifetime 6000 intact)',
    G !== null && G.premiumSpendable === 300 && G.premiumLifetime === 6000, JSON.stringify(G));
  assert('last_spend_reason = 21 and spend ref recorded', G !== null && G.lastSpendReason === 21 && G.lastSpendRef === '901', JSON.stringify(G));

  // Step 5c: overdraw (spend 999999) -> rejected, no change
  let overRejected = false;
  try {
    await write(program, sponsor,
      program.methods.spendPremiumPoints(new BN(999999), 21, new BN(902)).accounts({
        premiumPoints: premPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
      }).transaction());
  } catch (e) {
    overRejected = rejectedWith(e, ERR.InsufficientPremiumBalance);
    console.log('  overdraw rejected:', String(e && e.message || e).slice(0, 80));
  }
  const H = await readPrem();
  assert('overdraw > spendable is rejected', overRejected);
  assert('ledger unchanged after overdraw (300 spendable)',
    H !== null && H.premiumSpendable === 300 && H.premiumLifetime === 6000, JSON.stringify(H));

  // Step 6: premium NEVER feeds global (M4 stays 0/0/0)
  const GL = await readGlobal();
  assert('player global ledger untouched (0/0/0 — premium is buy-only)',
    GL !== null && GL.globalPureLifetime === 0 && GL.globalLifetime === 0 && GL.globalSpendableBalance === 0,
    JSON.stringify(GL));

  console.log(failures === 0 ? '\nHARNESS PASS' : `\nHARNESS FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });