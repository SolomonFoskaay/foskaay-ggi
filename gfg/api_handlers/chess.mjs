// api_handlers/chess.mjs - CHESS relay endpoint (M1A Chess, single player).
// Actions: create (relay creates + delegates the board), ai (house-signed AI
// move), state (read + decode). Soft-fail friendly.

import { dispatch } from '../scripts/chess-relay.mjs';

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
      matchRef: Number(body.matchRef ?? body.get?.('matchRef')),
      host: (body.host ?? body.get?.('host')) || null,
      timeMs: Number(body.timeMs ?? body.get?.('timeMs') ?? 0) || 0,
      incrementMs: Number(body.incrementMs ?? body.get?.('incrementMs') ?? 0) || 0,
      level: Number(body.level ?? body.get?.('level') ?? 1) || 1,
    });
    res.status(200).json(r);
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}
