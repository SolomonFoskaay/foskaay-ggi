// api/roll.mjs
// Vercel serverless function: server-side "house" dice roll for Ludo computer
// turns. Performs one GASLESS roll on the MagicBlock ER VRF queue signed by
// the house (sponsor) key, which never leaves the server. Returns the
// on-chain result + signature for the client to display and prove.
//
// Requires GFG_Gasless_Sponsor_Keypair (set in Vercel project settings), same as
// api/delegate.mjs.

import { handleHouseRoll } from '../scripts/roll-relay.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const result = await handleHouseRoll();
    res.status(200).setHeader('Cache-Control', 'no-store').json(result);
  } catch (e) {
    console.error('[roll] house roll failed:', e.message);
    res.status(500).json({ error: e.message });
  }
}