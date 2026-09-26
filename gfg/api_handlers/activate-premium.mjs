// api/activate-premium.mjs
// Vercel serverless: admin activates a subscription for a player after credit.
// Level is an optional body field (1/2/3); default Level 1. The relay spends
// the matching premium points (500/1,000/1,500) via activate_subscription_level.
// Authority-gated via GFG_OPERATOR_TOKEN, sponsor-signed, delegation-aware.

import { handleAdminActivatePremium } from '../scripts/delegate-relay.mjs';

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
    const expected = process.env.GFG_OPERATOR_TOKEN;
    // FAIL-CLOSED (public release hardening): token REQUIRED, missing is denied.
    if (!expected || expected.length < 16) {
      res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' });
      return;
    }
    if (!body.token || String(body.token) !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    if (!body.player) throw new Error('missing "player" pubkey');
    const result = await handleAdminActivatePremium(body.player, body.level);
    res.status(200).json(result);
  } catch (e) {
    console.error('activate-premium error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
