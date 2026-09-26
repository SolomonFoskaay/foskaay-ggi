// api_handlers/competitions.mjs — M7 competition admin routes (Vercel).
// GET ?creator=...&list=1   -> list instances
// GET ?creator=...&seq=..   -> one instance
// GET ?creator=...&seq=..&winners=1 -> winner records for the instance
// POST {action:'create'|'close'|'cancel'|'settle'|'recordWinner'|'markPaid', ...}
// All writes are sponsor/creator-signed on-chain (authority-gated by the
// contract). Operator token optional (staff-gated page), matching the other
// admin endpoints.

import { ensureTally,
  createCompetition, closeCompetition, cancelCompetition, settleCompetition,
  recordCompetitionWinner, markWinnerPaid, getCompetition, listCompetitions, getWinners, getBoard, recordWin,
} from '../scripts/competitions-relay.mjs';
import { addWin, addEntry, hasEntry } from '../scripts/competitions-wins.mjs';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const creator = (url.searchParams.get('creator') || '').trim();
      const seq = url.searchParams.get('seq');
      const winners = url.searchParams.get('winners') === '1';
      if (seq) {
        const comp = await getCompetition({ creator, seq: Number(seq) });
        if (!comp) { res.status(404).json({ error: 'competition not found' }); return; }
        if (url.searchParams.get('board') === '1') {
          const board = await getBoard({ creator, seq: Number(seq) });
          res.status(200).json(board);
          return;
        }
        const w = winners ? await getWinners({ creator, seq: Number(seq) }) : undefined;
        res.status(200).json({ competition: w ? { ...comp, winners: w } : comp });
        return;
      }
      const list = await listCompetitions({ creator: creator || undefined });
      res.status(200).json({ count: list.length, competitions: list });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }
    const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
    const expected = process.env.GFG_OPERATOR_TOKEN;
    if (expected && expected.length >= 16 && body.token && body.token !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    const base = { token: body.token, creator: body.creator || null };
    switch (body.action) {
      case 'ensure':
        return res.status(200).json(await ensureTally({ creator: base.creator, seq: Number(body.seq), wallet: body.wallet }));
      case 'record':
        return res.status(200).json(await recordWin({ creator: base.creator, seq: Number(body.seq), ts: Number(body.ts), game: Number(body.game), wallet: body.wallet }));
      case 'win':
        return res.status(200).json({ recorded: addWin({ compCreator: base.creator, seq: Number(body.seq), wallet: body.wallet, ts: Number(body.ts), proofSig: body.proofSig, game: body.game }) });
      case 'enter':
        if (hasEntry({ compCreator: base.creator, seq: Number(body.seq), wallet: body.wallet })) return res.status(200).json({ entered: false, already: true });
        addEntry({ compCreator: base.creator, seq: Number(body.seq), wallet: body.wallet });
        return res.status(200).json({ entered: true });
      case 'create':
        return res.status(200).json(await createCompetition({ ...base, seq: Number(body.seq), name: body.name, games: body.games, tierBits: Number(body.tierBits), requireAll: body.requireAll != null ? Number(body.requireAll) : 0, entryCost: Number(body.entryCost), entryFamilies: Number(body.entryFamilies), startsAt: Number(body.startsAt), endsAt: Number(body.endsAt), poolUsdCents: Number(body.poolUsdCents), poolPoints: Number(body.poolPoints), winnerCount: Number(body.winnerCount), prizeShares: (body.prizeShares || []).map(Number), redemption: body.redemption != null ? Number(body.redemption) : 0, payoutMode: body.payoutMode != null ? Number(body.payoutMode) : 0, desc: body.desc || '', redLabel: body.redLabel || '', redAmount: Number(body.redAmount) || 0, pool: Number(body.pool) || 0 }));
      case 'close':
        return res.status(200).json(await closeCompetition({ ...base, seq: Number(body.seq) }));
      case 'cancel':
        return res.status(200).json(await cancelCompetition({ ...base, seq: Number(body.seq) }));
      case 'settle':
        return res.status(200).json(await settleCompetition({ ...base, seq: Number(body.seq) }));
      case 'recordWinner':
        return res.status(200).json(await recordCompetitionWinner({ ...base, seq: Number(body.seq), rank: Number(body.rank), player: body.player }));
      case 'markPaid':
        return res.status(200).json(await markWinnerPaid({ ...base, seq: Number(body.seq), rank: Number(body.rank) }));
      default:
        return res.status(400).json({ error: 'unknown action: ' + body.action });
    }
  } catch (e) {
    console.error('competitions error:', e.message);
    res.status(500).json({ error: e.message });
  }
}