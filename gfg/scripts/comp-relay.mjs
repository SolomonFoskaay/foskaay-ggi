// scripts/comp-relay.mjs
// S2 competition lifecycle on the gfg-dice program (devnet, gasless ER).
//
// The platform (sponsor key) runs the escrow lifecycle; winners claim gasless
// on the ER with their session key. One Competition PDA per sponsor (seed
// `gfgcomp` + sponsor pubkey), so there is ONE active competition at a time —
// the natural cadence for daily/weekly/monthly cycles.
//
// Lifecycle:
//   createComp()        initialize_comp + delegate_comp (base layer, sponsor pays)
//   fundComp(amount)    sponsor locks prize pool on-chain BEFORE the event (ER)
//   closeComp()         sponsor closes entry after ends_at (ER)
//   settleComp(winners) program splits 70/30, sponsor submits winner table (ER)
//   claimComp(pda, idx) winner claims their allocation (ER, winner session key)
//
// Runs as:
//   - local relay server (scripts/relay-server.mjs) under /api/comp/*
//   - Vercel serverless (api/comp.mjs) — see that file for routing
//
// Security note: on devnet the pool is mirror points (free money), so this
// proves the escrow lifecycle end-to-end. Server-side entry gating + verified
// payouts are mainnet security items (security-queue.md, never client-served).

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import './load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, routerUrl, getDelegationStatus, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, mkWallet } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const COMP_SEED = Buffer.from('gfgcomp');
const BASE_URL = baseRpcUrl();
const ER_URL = pickErRpcUrl();
const ER_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region (see delegate-relay.mjs)
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

export function compPda(sponsorPubkey) {
  return PublicKey.findProgramAddressSync([COMP_SEED, new PublicKey(sponsorPubkey).toBytes()], PROGRAM_ID)[0];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const retry = async (fn, n = 4, delay = 400) => {
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { await sleep(delay); }
  }
  return null;
};

function baseConn() {
  return createConnection(BASE_URL, 'confirmed');
}

// Base-layer send + confirm (sponsor signs). Used for initialize_comp /
// delegate_comp, which need funding.
async function sendBase(conn, program, sponsor, build) {
  const tx = await build;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// ER send + confirm (sponsor signs). Used for fund/close/settle which run
// gasless on the rollup.
async function sendEr(program, sponsor, build) {
  const tx = await build;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(program.provider.connection, tx, [sponsor], { skipPreflight: true });
  await program.provider.connection.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// Create the Competition escrow PDA and delegate it into the ER session.
// Idempotent per comp. Returns { compPda, state, steps: [{step, sig}] }.
export async function createComp({ entryFee = 0, endsAt = null } = {}) {
  const sponsor = loadSponsor();
  const conn = baseConn();
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  const pda = compPda(sponsor.publicKey);
  const compId = BigInt(Date.now()) / 1000n; // unix seconds as comp_id
  const deadline = endsAt ?? Math.floor(Date.now() / 1000) + 86400; // +1 day default

  const status = await retry(() => getDelegationStatus(conn, pda));
  const steps = [];
  if (!(status && status.isDelegated)) {
    const info = await retry(() => conn.getAccountInfo(pda));
    if (!info) {
      const sig = await sendBase(conn, program, sponsor,
        program.methods.initializeComp(new BN(compId), new BN(entryFee), new BN(deadline))
          .accounts({ comp: pda, payer: sponsor.publicKey, sponsor: sponsor.publicKey })
          .transaction()
      );
      steps.push({ step: 'initialize_comp', sig });
    }
    const sig = await delegateCompPda(program, conn, sponsor, pda);
    if (sig) steps.push({ step: 'delegate_comp', sig });
  }

  return { compPda: pda.toString(), compId: compId.toString(), state: await fetchCompState(pda.toString()), steps };
}

async function delegateCompPda(program, conn, sponsor, pda) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
  const sig = await sendBase(conn, program, sponsor,
      program.methods.delegateComp()
        .accounts({
          payer: sponsor.publicKey,
          comp: pda,
          bufferComp: buffer,
          delegationRecordComp: record,
          delegationMetadataComp: metadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
        .transaction()
    )
    .catch(async (err) => {
      await sleep(600);
      const after = await getDelegationStatus(conn, pda);
      if (after && after.isDelegated) return null;
      const detail = err.transactionMessage || err.transactionError?.message || err.message;
      throw new Error(`delegate_comp failed: ${detail}`);
    });
  return sig;
}

// ER program bound to the sponsor for gasless lifecycle ops.
function erProgram(sponsor) {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  return new Program(idl, provider);
}

// Sponsor locks `amount` into the escrow pool (gasless on the ER).
export async function fundComp(amount, sponsorPubkey) {
  if (!(amount > 0)) throw new Error('amount must be > 0');
  const sponsor = loadSponsor();
  const pda = compPda(sponsorPubkey || sponsor.publicKey.toBase58());
  const program = erProgram(sponsor);
  const sig = await sendEr(program, sponsor,
    program.methods.fundComp(new BN(amount))
      .accounts({ comp: pda, payer: sponsor.publicKey, sponsor: sponsor.publicKey })
      .transaction()
  );
  return { compPda: pda.toString(), sig };
}

// Sponsor closes entry once the deadline has passed (gasless on the ER).
export async function closeComp(sponsorPubkey) {
  const sponsor = loadSponsor();
  const pda = compPda(sponsorPubkey || sponsor.publicKey.toBase58());
  const program = erProgram(sponsor);
  const sig = await sendEr(program, sponsor,
    program.methods.closeComp()
      .accounts({ comp: pda, payer: sponsor.publicKey, sponsor: sponsor.publicKey })
      .transaction()
  );
  return { compPda: pda.toString(), sig };
}

// Sponsor settles: submits the winner table (pubkeys + amounts, sum <= 70% of
// pool). Program enforces the 70/30 rake. Gasless on the ER.
export async function settleComp(winners, amounts, sponsorPubkey) {
  if (!Array.isArray(winners) || winners.length !== 3) throw new Error('winners must be [pubkey, pubkey, pubkey]');
  const sponsor = loadSponsor();
  const pda = compPda(sponsorPubkey || sponsor.publicKey.toBase58());
  const program = erProgram(sponsor);
  const sig = await sendEr(program, sponsor,
    program.methods.settleComp(winners.map(w => new PublicKey(w)), amounts.map(a => new BN(a)))
      .accounts({ comp: pda, payer: sponsor.publicKey, sponsor: sponsor.publicKey })
      .transaction()
  );
  return { compPda: pda.toString(), sig };
}

// Winner claims their allocation gasless on the ER (their session key signs).
// `sponsorPubkey` identifies the comp PDA; `winnerKeypair` is the player.
// `gameTag` selects which game's per-game points ledger receives the prize
// (default 'ludo').
export async function claimComp(compPda, winnerIndex, winnerKeypair, gameTag = 'ludo') {
  const conn = new Connection(ER_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(winnerKeypair), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);
  const [pointsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('gfgpoints'), Buffer.from(gameTag, 'utf8'), winnerKeypair.publicKey.toBytes()], PROGRAM_ID);
  const pda = new PublicKey(compPda);

  // Read the sponsor out of the comp account so the seed constraint passes.
  const comp = await program.account.competition.fetch(pda);
  const sponsorKey = new PublicKey(comp.sponsor);
  const sig = await sendEr(program, winnerKeypair,
    program.methods.claimComp(gameTag, winnerIndex)
      .accounts({
        comp: pda,
        payer: winnerKeypair.publicKey,
        playerAuthority: winnerKeypair.publicKey,
        points: pointsPda,
        sponsor: sponsorKey,
      })
      .transaction()
  );
  return { compPda: pda.toString(), sig };
}

// Read the current on-chain competition state (any network, own account only).
export async function fetchCompState(compPda) {
  try {
    const conn = new Connection(ER_URL, 'confirmed');
    const sponsor = loadSponsor();
    const program = new Program(idl, new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
    const pda = new PublicKey(compPda);
    const info = await retry(() => program.account.competition.fetch(pda));
    if (!info) return null;
    return {
      compId: (info.compId ?? info.comp_id).toString(),
      sponsor: (info.sponsor ?? '').toString(),
      entryFee: Number(info.entryFee ?? info.entry_fee),
      endsAt: Number(info.endsAt ?? info.ends_at),
      prizePool: Number(info.prizePool ?? info.prize_pool),
      state: ['Open', 'Funded', 'Settled'][Number(info.state)],
      winnerCount: Number(info.winnerCount ?? info.winner_count),
      winners: (info.winners || []).map(w => ({
        winner: (w.winner ?? '').toString(),
        amount: Number(w.amount),
        claimed: !!w.claimed,
      })),
    };
  } catch (e) {
    return null;
  }
}
