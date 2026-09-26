// api_handlers/multiplayer.mjs — MULTIPLAYER rail endpoint (M12, AGM-FREE).
// Serves the standalone game-agnostic multiplayer actions: create / begin /
// join / commit / state / finish. The rail (public/universal/multiplayer) calls
// this; it is NOT built on the removed AGM order book. Soft-fail friendly.

import { dispatch } from '../scripts/multiplayer-relay.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let body = {};
  if (req.method === 'GET') {
    try { body = new URL('http://x' + req.url).searchParams; } catch (e) { body = {}; }
  } else {
    try { body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {}); }
    catch (e) { res.status(400).json({ ok: false, error: 'invalid JSON body' }); return; }
  }
  const action = body.action || body.get?.('action');
  if (!action) { res.status(400).json({ ok: false, error: 'missing action' }); return; }
  try {
    const r = await dispatch(action, {
      game: Number(body.game ?? body.get?.('game')),
      matchRef: Number(body.matchRef ?? body.get?.('mathRef') ?? body.get?.('match_ref')),
      host: (body.host ?? body.get?.('host')) || null,
      seats: Number(body.seats ?? body.get?.('seats')),
      stakeUsdCents: Number(body.stakeUsdCents ?? body.get?.('stakeUsdCents') ?? 0) || 0,
      // arc2m1 timer: the PROGRAM decides turn_secs (DEFAULT_TURN_SECS). Pass 0
      // through - no off-chain fallback injects a duration.
      turnSecs: Number(body.turnSecs ?? body.get?.('turnSecs') ?? 0) || 0,
      maxMatchSecs: Number(body.maxMatchSecs ?? body.get?.('maxMatchSecs') ?? 3600) || 3600,
      seat: Number(body.seat ?? body.get?.('seat')),
      winnerSeat: Number(body.winnerSeat ?? body.get?.('winnerSeat')),
      moveCommit: body.moveCommit ?? body.get?.('moveCommit'),
      regionUrl: body.regionUrl ?? body.get?.('regionUrl'),
    });
    res.status(200).json(r);
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}