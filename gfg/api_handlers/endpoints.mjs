// api/endpoints.mjs
// Vercel serverless function backing the admin dashboard endpoint watchlist +
// ops panel. Runs the shared SERVER-SIDE probe (scripts/endpoints-probe.mjs);
// leak-scan findings never leave the server (logged server-side only).

import { runProbe } from '../scripts/endpoints-probe.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  try {
    const result = await runProbe();
    res.status(200).setHeader('Cache-Control', 'no-store').json(result);
  } catch (e) {
    console.error('[endpoints] probe failed:', e.message);
    res.status(500).json({ error: e.message });
  }
}