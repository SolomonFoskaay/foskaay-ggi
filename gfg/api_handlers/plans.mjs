// api_handlers/plans.mjs — public plan-ladder config (M5, config-driven).
// Served for free to the client so the whole site reads plan attributes
// (prices, lives, daily reward, multiplier, comp boost, ad-free) from ONE
// source. No secrets. Naira fields are Nigeria-beta display values only.

import { PLAN_LADDER, AFFILIATE_RATE } from '../scripts/plans-config.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ plans: PLAN_LADDER, affiliateRate: AFFILIATE_RATE, basePointsPerUsdCent: 5 });
}