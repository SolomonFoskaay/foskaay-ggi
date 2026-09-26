// api/credit-premium.mjs
// Vercel serverless function: the M5 admin credit entry point. Only the owner
// (holding GFG_OPERATOR_TOKEN) may credit a player's PREMIUM points ledger
// after a VERIFIED manual crypto (USDC) payment. This is the ONLY entry point for
// money-like value, so the operator gate is mandatory.
// Requires env vars: GFG_Gasless_Sponsor_Keypair + GFG_OPERATOR_TOKEN.

import { handleCreditPremium } from '../scripts/delegate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let body = {};
  try {
    body = typeof req.body === 'string' && req.body.length
      ? JSON.parse(req.body)
      : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }
  try {
    // (Removed 2026 public-release: the token was previously optional and a
    // missing token was allowed. That is a bypass and is gone - see below.)
    const expected = process.env.GFG_OPERATOR_TOKEN;
    // FAIL-CLOSED (public release hardening): the operator token is REQUIRED.
    // A missing token must NEVER be treated as allowed - previously it was, so
    // anyone could call this endpoint and have the relay sign a premium credit
    // to any wallet. Server-side only; no Supabase dependency.
    if (!expected || expected.length < 16) {
      res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' });
      return;
    }
    if (!body.token || String(body.token) !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    if (!body.player) throw new Error('missing "player" pubkey');
    // Upper bound matters: the 2026-08 bug passed a unix TIMESTAMP as the
    // amount (1,787,192,740), which credited a live account with ~1.8 billion
    // points. The program now hard-caps a single credit; this is the matching
    // server-side guard so a bad caller is rejected before any signing.
    const MAX_CREDIT_POINTS = 1_000_000;
    if (!Number.isInteger(body.points) || body.points <= 0) throw new Error('invalid points');
    if (body.points > MAX_CREDIT_POINTS) throw new Error(`points exceed the ${MAX_CREDIT_POINTS} per-credit maximum`);
    if (!Number.isInteger(body.creditRef) || body.creditRef <= 0) throw new Error('invalid creditRef');
    const result = await handleCreditPremium(body.player, body.points, body.creditRef);
    res.status(200).json(result);
  } catch (e) {
    console.error('credit-premium error:', e.message);
    res.status(500).json({ error: e.message });
  }
}