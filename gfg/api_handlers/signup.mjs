// api_handlers/signup.mjs
// Signup: claim the 500P bonus (idempotent), register the player's profile handle
// on-chain, and (if a refHandle was shared by the inviter) record the referral pair
// so the affiliate month-end settle can process it later. No cron, no external
// automation: these are per-signup actions only.

import { handleSignupFlow } from '../scripts/affiliate-relay.mjs';
import { isSignupClaimed } from '../scripts/affiliate-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
    if (!body.wallet) throw new Error('missing wallet');
    const result = await handleSignupFlow({ wallet: body.wallet, handle: body.handle, refHandle: body.refHandle });
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    // A repeat claim of the lifetime 500P bonus is a clean "already claimed",
    // never an error: tell the client so it can disable the button for good.
    if (isSignupClaimed(body.wallet)) {
      res.status(200).json({ ok: true, signupClaimed: true, alreadyClaimed: true });
      return;
    }
    console.error('signup error:', e.message);
    res.status(500).json({ error: e.message });
  }
}