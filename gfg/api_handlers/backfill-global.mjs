// api/backfill-global.mjs
// Vercel serverless: backfills orphaned M3 points into M4 global ledger.
// Security: re-derives the gap from on-chain M3 (never trusts client input).
// Requires GFG_Gasless_Sponsor_Keypair in Vercel env (JSON array of 64 ints).

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { pickErRpcUrl, createConnection } from '../src/gfg-rpc.js';
import { sourceCodeFor } from '../scripts/point-sources.mjs';

const ER_URL = pickErRpcUrl();
const BASE_RPC = 'https://api.devnet.solana.com';
const POINTS_SEED = Buffer.from('gfgpoints', 'utf8');
const GLOBAL_SEED = Buffer.from('global', 'utf8');
const ER_BACKOFF = [400, 800, 1200, 1800, 2500];

function loadSponsor() {
  const raw = process.env.GFG_Gasless_Sponsor_Keypair;
  if (!raw) throw new Error('GFG_Gasless_Sponsor_Keypair env not set');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { wallet, sourceTag, matchRef } = req.body;
    if (!wallet || !sourceTag || !matchRef) throw new Error('missing wallet/sourceTag/matchRef');

    // Convert the tag -> on-chain source_code exactly like the live M4 path
    // (source of truth is the M3 game tag; a client can never input a source
    // code the live path would bank differently). Unknown tag -> refuse.
    const sourceCode = sourceCodeFor(sourceTag);
    if (sourceCode === 0) throw new Error('invalid sourceTag (no source_code for: ' + sourceTag + ')');

    const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
    const programId = new PublicKey(idl.address || idl.metadata?.address);
    const playerPub = new PublicKey(wallet);

    const erConn = createConnection(ER_URL, 'confirmed', 30000, { backoffMs: ER_BACKOFF });
    const baseConn = new Connection(BASE_RPC, 'confirmed');

    // Read M3 local pure
    const m3Pda = PublicKey.findProgramAddressSync(
      [POINTS_SEED, Buffer.from(sourceTag, 'utf8'), playerPub.toBytes()], programId,
    )[0];
    let m3Info = await erConn.getAccountInfo(m3Pda).catch(() => null);
    if (!m3Info) m3Info = await baseConn.getAccountInfo(m3Pda);
    if (!m3Info) return res.json({ ok: false, error: 'No M3 points found for this game' });
    const m3Pure = Number(m3Info.data.readBigUInt64LE(8));

    // Read M4 global pure
    const m4Pda = PublicKey.findProgramAddressSync(
      [POINTS_SEED, GLOBAL_SEED, playerPub.toBytes()], programId,
    )[0];
    let m4Info = await erConn.getAccountInfo(m4Pda).catch(() => null);
    if (!m4Info) m4Info = await baseConn.getAccountInfo(m4Pda);
    const m4Pure = m4Info ? Number(m4Info.data.readBigUInt64LE(8)) : 0;

    const gap = m3Pure - m4Pure;
    if (gap <= 0) return res.json({ ok: false, error: 'No orphaned points (M3=' + m3Pure + ', M4=' + m4Pure + ')' });

    // Execute backfill via ER
    const sponsor = loadSponsor();
    const provider = new AnchorProvider(erConn, sponsor, { commitment: 'confirmed', skipPreflight: true });
    const program = new Program(idl, provider);

    const tx = await program.methods.recordGlobalPoints(
      0, sourceCode, new BN(gap), 1, new BN(Date.now()),
    ).accounts({
      payer: sponsor.publicKey, playerAuthority: playerPub, globalPoints: m4Pda,
    }).transaction();

    tx.feePayer = sponsor.publicKey;
    const sig = await provider.connection.sendTransaction(tx, [sponsor], { skipPreflight: true });
    await erConn.confirmTransaction({ signature: sig }, 'confirmed');

    return res.json({ ok: true, signature: sig, gap, m3Pure, m4PureBefore: m4Pure });
  } catch (e) {
    console.error('[backfill-global] error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
