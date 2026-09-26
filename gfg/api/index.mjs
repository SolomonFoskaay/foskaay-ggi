// api/index.mjs — SINGLE serverless function for the whole /api surface.
// Vercel Hobby allows max 12 functions; splitting each route into its own
// file broke deploys, so all handlers now live under api_handlers/ (regular
// modules, not functions) and this one function dispatches by request path.
// Local dev still uses scripts/relay-server.mjs (same routes, no change).
//
// Adding a new endpoint: put the handler module in api_handlers/ and register
// it in the route map below. Never create a new file under api/ (a second
// function would consume another Hobby slot).

import delegate from '../api_handlers/delegate.mjs';
import roll from '../api_handlers/roll.mjs';
import comp from '../api_handlers/comp.mjs';
import creditPremium from '../api_handlers/credit-premium.mjs';
import cancelPremium from '../api_handlers/cancel-premium.mjs';
import activatePremium from '../api_handlers/activate-premium.mjs';
import premiumTracker from '../api_handlers/premium-tracker.mjs';
import dynamicSearch from '../api_handlers/dynamic-search.mjs';
import dynamicList from '../api_handlers/dynamic-list.mjs';
import endpoints from '../api_handlers/endpoints.mjs';
import backfillGlobal from '../api_handlers/backfill-global.mjs';
import affiliate from '../api_handlers/affiliate.mjs';
import signup from '../api_handlers/signup.mjs';
import competitions from '../api_handlers/competitions.mjs';
import plans from '../api_handlers/plans.mjs';
import agm from '../api_handlers/agm.mjs';
import verifyAndCredit from '../api_handlers/verify-and-credit.mjs';
import payConfig from '../api_handlers/pay-config.mjs';
import communityStats from '../api_handlers/community-stats.mjs';
import multiplayer from '../api_handlers/multiplayer.mjs';
import chess from '../api_handlers/chess.mjs';
import arcRelay from '../api_handlers/arc-relay.mjs';
import ggiSponsor from '../api_handlers/foskaay-ggi-sponsor.mjs';

const routes = {
  '/api/competitions': competitions,
  '/api/plans': plans,
  '/api/pay-config': payConfig,
  '/api/community-stats': communityStats,
  '/api/multiplayer': multiplayer,
  '/api/chess': chess,
  '/api/arc': arcRelay,
  '/api/foskaay-ggi-sponsor': ggiSponsor,
  '/api/agm': agm,
  '/api/agm/balances': agm,
  '/api/verify-and-credit': verifyAndCredit,
  '/api/delegate': delegate,
  '/api/roll': roll,
  '/api/comp': comp,
  '/api/comp/claim': comp,
  '/api/credit-premium': creditPremium,
  '/api/cancel-premium': cancelPremium,
  '/api/activate-premium': activatePremium,
  '/api/premium-tracker': premiumTracker,
  '/api/dynamic-search': dynamicSearch,
  '/api/dynamic-list': dynamicList,
  '/api/endpoints': endpoints,
  '/api/backfill-global': backfillGlobal,
  '/api/affiliate': affiliate,
  '/api/signup': signup,
};

export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  const fn = routes[path];
  if (!fn) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  return fn(req, res);
}