// api/comp.mjs
// Vercel serverless function: S2 competition lifecycle on the gfg-dice program.
// Routes:
//   GET  /api/comp            current competition state
//   POST /api/comp            { action: create|fund|close|settle, ... }
//   POST /api/comp/claim      { compPda, winnerIndex, winnerSecret }
// Requires GFG_Gasless_Sponsor_Keypair in the Vercel project settings.
// NOTE: claims require the winner's secret key in the request body, which is
// only acceptable for the devnet proof-of-life. On mainnet the winner signs
// client-side and posts only the signature (see security-queue.md).

import {
  createComp, fundComp, closeComp, settleComp, claimComp, fetchCompState, compPda,
} from '../scripts/comp-relay.mjs';
import { loadSponsor } from '../scripts/delegate-relay.mjs';
import { Keypair } from '@solana/web3.js';

export default async function handler(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.set(cors);
    res.status(204).end();
    return;
  }
  if (req.method === 'GET' && !req.url.includes('/claim')) {
    try {
      const sponsor = loadSponsor();
      const pda = compPda(sponsor.publicKey.toBase58()).toString();
      const state = await fetchCompState(pda);
      res.set(cors);
      res.status(200).json({ compPda: pda, state });
      return;
    } catch (e) {
      console.error('comp state error:', e.message);
      res.set(cors);
      res.status(500).json({ error: e.message });
      return;
    }
  }
  if (req.method === 'POST' && req.url.includes('/claim')) {
    try {
      const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
      if (!body.compPda || body.winnerIndex == null || !body.winnerSecret) {
        throw new Error('missing compPda/winnerIndex/winnerSecret');
      }
      const winnerKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(body.winnerSecret)));
      const result = await claimComp(body.compPda, Number(body.winnerIndex), winnerKeypair);
      res.set(cors);
      res.status(200).json(result);
      return;
    } catch (e) {
      console.error('comp claim error:', e.message);
      res.set(cors);
      res.status(500).json({ error: e.message });
      return;
    }
  }
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
      let result;
      if (body.action === 'create') result = await createComp({ entryFee: body.entryFee || 0, endsAt: body.endsAt });
      else if (body.action === 'fund') result = await fundComp(Number(body.amount));
      else if (body.action === 'close') result = await closeComp();
      else if (body.action === 'settle') result = await settleComp(body.winners, body.amounts);
      else throw new Error('unknown action (create|fund|close|settle)');
      res.set(cors);
      res.status(200).json(result);
      return;
    } catch (e) {
      console.error('comp error:', e.message);
      res.set(cors);
      res.status(500).json({ error: e.message });
      return;
    }
  }
  res.set(cors);
  res.status(405).json({ error: 'method not allowed' });
}
