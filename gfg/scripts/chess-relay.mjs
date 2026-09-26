// scripts/chess-relay.mjs - CHESS relay core (M1A Chess, single player).
//
// The relay/sponsor signs the one-time board create + delegate (base layer,
// idempotent), and the house signs the on-chain AI reply. Every player move
// afterwards runs GASLESS on the MagicBlock ER (player session key, 0 SOL).
// No crank, no second program. Soft-fail friendly ({ok, ...}).

import './load-env.mjs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const CHESS_SEED = Buffer.from('gfgchess');
const LIVES_SEED = Buffer.from('gfglives');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region pin

const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function refBN(matchRef) { return new BN(String(matchRef)); }

export function chessPda(matchRef) {
  return PublicKey.findProgramAddressSync([CHESS_SEED, refBN(matchRef).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}

function livesPdaFor(owner) {
  return PublicKey.findProgramAddressSync([LIVES_SEED, new PublicKey(owner).toBytes()], PROGRAM)[0];
}

async function hostUrl(pda) {
  try {
    const st = await getDelegationStatus(conn, pda);
    if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; }
  } catch (e) { /* fall through */ }
  return pickErRpcUrl();
}

export async function ensureChessDelegated(matchRef) {
  const pda = chessPda(matchRef);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return { pda: pda.toBase58(), delegated: false, why: 'not-created' };
  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (st && st.isDelegated) return { pda: pda.toBase58(), delegated: true, region: st.fqdn || '' };
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const tx = await prog.methods.delegateChessBoard(refBN(matchRef))
    .accounts({
      payer: sponsor.publicKey,
      bufferBoard: buffer,
      delegationRecordBoard: record,
      delegationMetadataBoard: metadata,
      board: pda,
      ownerProgram: PROGRAM,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: ER_VALIDATOR_ID, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return { pda: pda.toBase58(), delegated: true, sig };
}

// Create the chess board (sponsor pays) then delegate it to the ER. Idempotent.
export async function chessCreate({ matchRef, host, timeMs, incrementMs, solo }) {
  try {
    if (!matchRef || !host) return { ok: false, error: 'matchRef and host required' };
    const pda = chessPda(matchRef);
    const hostKey = new PublicKey(host);
    const info = await conn.getAccountInfo(pda).catch(() => null);
    let created = false;
    if (!info) {
      const tx = await prog.methods.initializeChessMatch(
        refBN(matchRef),
        new BN(Number(timeMs) || 600000),
        new BN(Number(incrementMs) || 0),
        Number(solo) === 0 ? 0 : 1,
      ).accounts({
        payer: sponsor.publicKey,
        host: hostKey,
        board: pda,
        systemProgram: SystemProgram.programId,
      }).transaction();
      tx.feePayer = sponsor.publicKey;
      const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig }, 'confirmed');
      created = true;
    }
    const d = await ensureChessDelegated(matchRef);
    return { ok: true, pda: pda.toBase58(), created, delegated: !!d.delegated };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// House-signed on-chain AI reply (region-aware ER write).
export async function chessAiMove({ matchRef, level }) {
  try {
    const pda = chessPda(matchRef);
    let url = await hostUrl(pda);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { url = await hostUrl(pda); } catch (e) { /* keep */ }
      try {
        const c = createConnection(url, 'confirmed', 8000);
        const info = await c.getAccountInfo(pda);
        if (info && info.owner.toBase58() === PROGRAM.toBase58()) break;
      } catch (e) { /* keep polling */ }
      await sleep(600);
    }
    const connEr = createConnection(url, 'confirmed');
    const bh = await connEr.getLatestBlockhash('confirmed');
    const tx = await prog.methods.aiChessMove(refBN(matchRef), Number(level) || 1)
      .accounts({ signer: sponsor.publicKey, board: pda })
      .transaction();
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.partialSign(sponsor);
    const sig = await connEr.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connEr.confirmTransaction({ signature: sig }, 'confirmed');
    return { ok: true, sig };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Read + decode the chess board (from its hosting region, base fallback).
export async function chessState({ matchRef }) {
  try {
    const pda = chessPda(matchRef);
    let url = await hostUrl(pda);
    let info = null;
    try {
      const c = createConnection(url, 'confirmed', 8000);
      info = await c.getAccountInfo(pda);
    } catch (e) { /* fall through */ }
    if (!info) info = await conn.getAccountInfo(pda).catch(() => null);
    if (!info || !info.data) return { ok: false, error: 'chess board not found' };
    const d = info.data;
    if (d.length < 8 + 212) return { ok: false, error: 'chess board too small' };
    const seats = [];
    for (let i = 0; i < 2; i++) {
      const s = d.subarray(18 + i * 32, 50 + i * 32);
      try { seats.push(new PublicKey(s).toBase58()); } catch (e) { seats.push(''); }
    }
    const position = [];
    for (let i = 0; i < 64; i++) position.push(d[82 + i]);
    return {
      ok: true,
      pda: pda.toBase58(),
      version: d[8],
      status: d[10],
      seatCount: d[11],
      result: d[12],
      endReason: d[13],
      sideToMove: d[14],
      castling: d[15],
      ep: d[16],
      checkFlag: d[17],
      seats,
      position,
      clockMs: [Number(d.readBigUInt64LE(146)), Number(d.readBigUInt64LE(154))],
      incrementMs: Number(d.readBigUInt64LE(162)),
      turnStartedAt: Number(d.readBigInt64LE(170)),
      startedAt: Number(d.readBigInt64LE(178)),
      finishedAt: Number(d.readBigInt64LE(186)),
      halfmove: d.readUInt16LE(194),
      fullmove: d.readUInt16LE(196),
      moveCount: d.readUInt32LE(198),
      drawOffer: d[210],
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function dispatch(action, params) {
  switch (action) {
    case 'create': return chessCreate(params);
    case 'ai': return chessAiMove(params);
    case 'state': return chessState(params);
    default: return { ok: false, error: 'unknown chess action: ' + action };
  }
}
