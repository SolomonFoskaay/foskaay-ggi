// scripts/browser-path-repro.mjs
// M3 — reproduction of the EXACT browser write path that a win triggers:
//   payer = the player's session key with 0 SOL (gasless on the ER),
//   playerAuthority = the same key,
//   via Anchor program.methods...rpc() on the ER RPC (like src/magicblock-er-vrf.js
//   recordPoints does) — NOT sponsor-as-payer via sendMagicTx (which is what
//   the earlier harnesses used).
// If this fails, we have reproduced the user's "no reward" bug on-chain.

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, pickErRpcUrl } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_URL = pickErRpcUrl();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decodeLedger = (data) => ({
  pure: data.length >= 16 ? Number(data.readBigUInt64LE(8)) : 0,
  spendable: data.length >= 24 ? Number(data.readBigUInt64LE(16)) : 0,
  last_points: data.length >= 32 ? Number(data.readBigUInt64LE(24)) : 0,
  reason: data.length >= 33 ? data[32] : 0,
  award_count: data.length >= 57 ? Number(data.readBigUInt64LE(49)) : 0,
});

async function waitErPickup(pda, tries = 30, delay = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await new Connection(ER_URL, 'confirmed').getAccountInfo(pda);
      if (info && info.data && info.data.length > 0) return info;
    } catch (_) { /* warming up */ }
    await sleep(delay);
  }
  throw new Error('ER pickup timeout');
}

async function main() {
  const sponsor = loadSponsor();
  const player = Keypair.generate(); // the "session key" — 0 SOL
  const baseConn = createConnection(baseRpcUrl());
  const bal = await baseConn.getBalance(player.publicKey);
  console.log(`player (payer, playerAuthority): ${player.publicKey.toBase58()}`);
  console.log(`player SOL balance: ${bal} lamports (must be 0 for a faithful repro)`);
  if (bal !== 0) console.log('!! player has SOL — still proceeding, but note the browser player always has 0');

  const { pointsPda } = await handleDelegate(player.publicKey.toBase58(), 'ludo');
  console.log(`pointsPda: ${pointsPda}`);
  await waitErPickup(new PublicKey(pointsPda));
  console.log('points PDA picked up by ER');

  // The browser builds the provider against the ER RPC with the SESSION KEY
  // as the signer + payer. mkWallet wraps a Keypair as an Anchor wallet.
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(player), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const read = async () => decodeLedger((await new Connection(ER_URL, 'confirmed').getAccountInfo(new PublicKey(pointsPda))).data);
  const A = await read();
  console.log('ledger before:', JSON.stringify(A));

  console.log('\n[1] record_points(+100) payer=player(0 SOL), playerAuthority=player, via .rpc() on ER...');
  const matchRef = new BN('83473290742'); // realistic u64 from a sig
  try {
    const sig = await program.methods
      .recordPoints('ludo', new BN(100), 1, matchRef)
      .accounts({ points: new PublicKey(pointsPda), payer: player.publicKey, playerAuthority: player.publicKey })
      .rpc();
    console.log('record_points sig:', sig);
  } catch (e) {
    console.log('record_points FAILED (this is the user\'s bug):', e.message || e);
    process.exit(2);
  }
  await sleep(2000);
  const B = await read();
  console.log('ledger after:', JSON.stringify(B));

  const ok = B.pure === A.pure + 100 && B.spendable === A.spendable + 100 && B.award_count === A.award_count + 1;
  console.log(ok ? '\nBROWSER-PATH REPRO PASS (0-SOL player payer works)' : '\nBROWSER-PATH REPRO FAIL (values wrong)');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
