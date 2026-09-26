// scripts/er-global-points-harness.mjs
// M4 Track A — on-chain harness proving initialize_global_points,
// delegate_global_points, record_global_points (kind 0 + kind 1), and
// spend_global run gasless on the MagicBlock ER for a 0-SOL player and
// land on the correct three-track global ledger.
//
// Flow:
//   1. Generate a fresh player keypair (holds 0 SOL).
//   2. handleDelegate (idempotent) creates + delegates the GLOBAL points PDA
//      alongside the other 3 PDAs.
//   3. record_global_points kind=0 (game win, source=ludo) +200 -> pure=200, lifetime=200, spendable=200
//   4. record_global_points kind=1 (referral) +50 -> pure=200 (unchanged), lifetime=250, spendable=250
//   5. spend_global -80 -> pure=200, lifetime=250, spendable=170
//   6. Read back + assert every field.
//
// NOTE (2026-08-19): instruction args follow the CURRENT program signature
// record_global_points(kind, source_code, points, reason, match_ref) and the
// ledger is decoded through the ANCHOR account coder (never raw byte offsets —
// the account has an 8-byte discriminator then the struct fields; the old
// version/bump hand-rolled decode read garbage).
//
// Run: node scripts/er-global-points-harness.mjs   (exit 0 = pass)

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const GLOBAL_SEED = Buffer.from('global', 'utf8');
const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

// Decode through the Anchor account coder instead of raw byte offsets. This is
// the SAME decode the client SDK uses (program.account.globalPoints.fetch), so
// the harness verifies the real layout the product reads.
const decodeGlobalLedger = async (program, pda) => {
  const acct = await program.account.globalPoints.fetch(pda).catch(() => null);
  if (!acct) return null;
  return {
    globalPureLifetime: Number(acct.globalPureLifetime ?? acct.global_pure_lifetime ?? 0),
    globalLifetime: Number(acct.globalLifetime ?? acct.global_lifetime ?? 0),
    globalSpendableBalance: Number(acct.globalSpendableBalance ?? acct.global_spendable_balance ?? 0),
    lastSource: Number(acct.lastSource ?? acct.last_source ?? 0),
    lastPoints: Number(acct.lastPoints ?? acct.last_points ?? 0),
    lastReason: Number(acct.lastReason ?? acct.last_reason ?? 0),
    lastMatchRef: (acct.lastMatchRef ?? acct.last_match_ref)?.toString() ?? '0',
    awardCount: Number(acct.awardCount ?? acct.award_count ?? 0),
    spendCount: Number(acct.spendCount ?? acct.spend_count ?? 0),
  };
};

function globalPda(playerPubkey) {
  return PublicKey.findProgramAddressSync(
    [POINTS_SEED, GLOBAL_SEED, playerPubkey.toBytes()],
    new PublicKey(idl.address || idl.metadata?.address),
  );
}

async function waitErPickup(pda, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout for global PDA');
}

async function write(program, sponsor, build) {
  const tx = await build;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(program.provider.connection, tx, [sponsor], { skipPreflight: true });
  await program.provider.connection.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function main() {
  const sponsor = loadSponsor();
  const player = Keypair.generate();
  console.log(`player: ${player.publicKey.toBase58()}`);

  // Delegate creates the global points PDA alongside dice/points/result
  const { globalPointsPda } = await handleDelegate(player.publicKey.toBase58(), 'ludo');
  console.log(`globalPointsPda: ${globalPointsPda}`);

  const { program } = erProgram(sponsor);
  await waitErPickup(new PublicKey(globalPointsPda));

  const [pdaPub] = globalPda(player.publicKey);
  const read = () => decodeGlobalLedger(program, pdaPub);

  const A = await read();
  console.log('after delegate:', JSON.stringify(A));

  // Step 3: record_global kind=0 (game win, source_code=1 ludo) +200
  const s1 = await write(program, sponsor,
    program.methods.recordGlobalPoints(0, 1, new BN(200), 1, new BN(1)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const B = await read();
  console.log(`record_global(kind=0, source=ludo, +200) ${s1.slice(0, 12)} -> ${JSON.stringify(B)}`);

  // Step 4: record_global kind=1 (referral, source_code=11) +50
  const s2 = await write(program, sponsor,
    program.methods.recordGlobalPoints(1, 11, new BN(50), 1, new BN(2)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const C = await read();
  console.log(`record_global(kind=1, source=referral, +50) ${s2.slice(0, 12)} -> ${JSON.stringify(C)}`);

  // Step 5: spend_global -80
  const s3 = await write(program, sponsor,
    program.methods.spendGlobal(new BN(80), 1, new BN(3)).accounts({
      globalPoints: pdaPub, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const D = await read();
  console.log(`spend_global(-80)           ${s3.slice(0, 12)} -> ${JSON.stringify(D)}`);

  // Step 6: assertions (current struct: single award_count, no per-kind split;
  // last_source reflects the most recent credit's u8 source_code).
  const ok =
    B !== null &&
    B.globalPureLifetime === 200 && B.globalLifetime === 200 && B.globalSpendableBalance === 200 &&
    B.awardCount === 1 && B.lastSource === 1 &&
    C.globalPureLifetime === 200 && C.globalLifetime === 250 && C.globalSpendableBalance === 250 &&
    C.awardCount === 2 && C.lastSource === 11 &&
    D.globalPureLifetime === 200 && D.globalLifetime === 250 && D.globalSpendableBalance === 170 &&
    D.awardCount === 2 && D.spendCount === 1;
  console.log(ok ? '\nHARNESS PASS' : '\nHARNESS FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
