// scripts/er-points-harness.mjs
// M3 — on-chain harness proving record_core_points + spend_core_local run gasless
// on the MagicBlock ER for a 0-SOL player (sponsor signs, mirroring the client's
// session-key write path) and land on the correct two-track CORE bucket.
//
// arcv2m3 (2026-09): the per-game points PDA [gfgpoints, game_tag, player] is
// RETIRED; every local award now lands in the player's Player Core
// [gfgcore, player]. This harness targets the core bucket for 'ludo'.
//
// Flow:
//   1. Generate a fresh player keypair (holds 0 SOL, like every real player).
//   2. handleDelegate (idempotent) creates + delegates the dice PDA AND the core.
//   3. record_core_points +150 twice -> bucket pure=300, spendable=300.
//   4. spend_core_local 40           -> bucket spendable=260, pure=300.
//   5. Read back + assert from the ER-hosted copy.

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return { program: new Program(idl, provider), conn };
}

// Read one game bucket out of a decoded Player Core account.
const bucketOf = (acc, tag = 'ludo') => {
  for (let i = 0; i < acc.bucketCount; i++) {
    const t = Buffer.from(acc.buckets[i].gameTag).toString('utf8').replace(/\0+$/, '');
    if (t === tag) {
      return { pure: acc.buckets[i].localPure.toNumber(), spendable: acc.buckets[i].localSpendable.toNumber() };
    }
  }
  return { pure: 0, spendable: 0 };
};

async function waitErPickup(pda, tries = 20, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout');
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
  console.log(`player: ${player.publicKey.toBase58()} (balance: ${await createConnection(baseRpcUrl()).getBalance(player.publicKey)} lamports — expect 0)`);

  await handleDelegate(player.publicKey.toBase58(), 'ludo');
  const [corePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('gfgcore'), player.publicKey.toBytes()], new PublicKey(idl.address));
  console.log(`corePda: ${corePda.toBase58()}`);

  const { program } = erProgram(sponsor);
  await waitErPickup(corePda);

  const read = async () => bucketOf(await program.account.playerCore.fetch(corePda));

  const A = await read();
  console.log('after delegate:', JSON.stringify(A));

  const s1 = await write(program, sponsor,
    program.methods.recordCorePoints('ludo', new BN(150), 1, new BN(1)).accounts({
      core: corePda, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const B = await read();
  console.log(`record_core_points(+150) ${s1.slice(0, 12)} -> ${JSON.stringify(B)}`);

  const s2 = await write(program, sponsor,
    program.methods.recordCorePoints('ludo', new BN(150), 1, new BN(2)).accounts({
      core: corePda, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const C = await read();
  console.log(`record_core_points(+150) ${s2.slice(0, 12)} -> ${JSON.stringify(C)}`);

  const s3 = await write(program, sponsor,
    program.methods.spendCoreLocal('ludo', new BN(40), 5, new BN(7)).accounts({
      core: corePda, payer: sponsor.publicKey, playerAuthority: player.publicKey,
    }).transaction());
  await sleep(1500);
  const D = await read();
  console.log(`spend_core_local(-40)   ${s3.slice(0, 12)} -> ${JSON.stringify(D)}`);

  const ok =
    B.pure === 150 && B.spendable === 150 &&
    C.pure === 300 && C.spendable === 300 &&
    D.pure === 300 && D.spendable === 260;
  console.log(ok ? '\nHARNESS PASS' : '\nHARNESS FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
