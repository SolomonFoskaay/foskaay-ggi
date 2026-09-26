# M5 — Monthly subscription (Active Tier, powers the multiplier)

The consistent-money module. A monthly Active Tier bought from spendable
points powers the 2x/3x/4x win multiplier applied at M4 flow-up.

## Contract (future; this folder is the canonical home)

- Ladder (econ-003 settled): Tier 2 = 1,000 spendable/month -> 2x,
  Tier 3 = 2,500 -> 3x, Tier 4 = 5,000 -> 4x. Multiplier on base match win
  points only, per-day +1,000 boosted cap.
- Applied ONLY at M4 flow-up (lifetime + spendable), never on M3 local or
  M4a pure, so a player's pure local wins stay honest.
- Future: real-money subscription once payment rails mature (econ-006
  stream 3). Gates M7 competition entry.

## Status

`in-progress` S1 (architecture.json is the source of truth). The existing
tier/entry UI lives in `public/tiers.js` today; the S1 build homes its
business logic here.