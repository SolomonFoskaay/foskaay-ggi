// api_handlers/agm.mjs — Arc2 AGM lobby endpoint (single /api/agm route).
// POST actions: post, match, lock, settle, cancel, p2c-fund, p2c-settle.
// GET ?game=..&orderId=..  lists the lobby registry + live on-chain status.
// Every write is relay/sponsor signed on behalf of the authenticated maker/taker.

import { agmPost, agmList, agmMatch, agmLock, agmSettle, agmCancel, agmP2cFund, agmP2cSettle, agmBank } from '../scripts/agm-relay.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url || '', `http://localhost:${process.env.PORT || 8787}`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && url.pathname === '/api/agm/balances') {
      const wallet = url.searchParams.get('wallet');
      if (!wallet) { res.status(400).json({ error: 'wallet param required' }); return; }
      const { walletBalances } = await import('../scripts/agm-relay.mjs');
      const b = await walletBalances(wallet);
      res.status(200).json(b);
      return;
    }
    if (req.method === 'GET') {
      const game = url.searchParams.get('game');
      const orderId = url.searchParams.get('orderId');
      const ids = url.searchParams.get('ids');
      const result = await agmList({ game: game != null ? Number(game) : null, orderId: orderId != null ? Number(orderId) : null, ids });
      res.status(200).json(result);
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST or GET only' }); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const b = typeof body === 'object' ? body : JSON.parse(body || '{}');
    switch (b.action) {
      case 'post': { const r = await agmPost({ game: Number(b.game), stakeUsdCents: Number(b.stakeUsdCents), seats: Number(b.seats), maker: b.maker }); res.status(200).json(r); return; }
      case 'match': { const r = await agmMatch({ game: Number(b.game), orderId: Number(b.orderId), taker: b.taker }); res.status(200).json(r); return; }
      case 'lock': { const r = await agmLock({ game: Number(b.game), orderId: Number(b.orderId), winnerSeat: Number(b.winnerSeat) }); res.status(200).json(r); return; }
      case 'settle': { const r = await agmSettle({ game: Number(b.game), orderId: Number(b.orderId) }); res.status(200).json(r); return; }
      case 'cancel': { const r = await agmCancel({ game: Number(b.game), orderId: Number(b.orderId), maker: b.maker }); res.status(200).json(r); return; }
      case 'p2c-fund': { const r = await agmP2cFund({ game: Number(b.game), amountUsdCents: Number(b.amountUsdCents) }); res.status(200).json(r); return; }
      case 'p2c-settle': { const r = await agmP2cSettle({ game: Number(b.game), orderId: Number(b.orderId), computerSeat: Number(b.computerSeat), computerWon: !!b.computerWon }); res.status(200).json(r); return; }
      case 'bank': { const r = await agmBank({ game: Number(b.game) }); res.status(200).json(r); return; }
      case 'board-start': { const { boardStart } = await import('../scripts/agm-relay.mjs'); const r = await boardStart({ game: Number(b.game), matchRef: Number(b.matchRef), players: b.players, seats: Number(b.seats), stakeUsdCents: Number(b.stakeUsdCents) || 0, turnSecs: Number(b.turnSecs) || 60, maxMatchSecs: Number(b.maxMatchSecs) || 3600 }); res.status(200).json(r); return; }
      case 'board-commit': { const { boardCommit } = await import('../scripts/agm-relay.mjs'); const r = await boardCommit({ game: Number(b.game), matchRef: Number(b.matchRef), seat: Number(b.seat), moveCommit: b.moveCommit, regionUrl: b.regionUrl }); res.status(200).json(r); return; }
      case 'board-finish': { const { boardFinish } = await import('../scripts/agm-relay.mjs'); const r = await boardFinish({ game: Number(b.game), matchRef: Number(b.matchRef), winnerSeat: Number(b.winnerSeat), regionUrl: b.regionUrl }); res.status(200).json(r); return; }
      case 'board-state': { const { boardState } = await import('../scripts/agm-relay.mjs'); const r = await boardState({ game: Number(b.game), matchRef: Number(b.matchRef) }); res.status(200).json(r); return; }
      default: res.status(400).json({ error: 'unknown action: ' + b.action });
    }
  } catch (e) {
    console.error('[agm] error:', e.message);
    res.status(500).json({ error: e.message });
  }
}