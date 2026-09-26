# M4 — Global ledgers (site-wide, decoupled from gameplay)

Three ledgers, source-tagged, one honest cross-game set of totals.

- **M4a Global Pure:** sum of M3 local wins across all games. No multiplier,
  no purchases, no bonus. The honest "how good across the whole platform".
- **M4b Global Lifetime (unspendable):** every point ever earned from any
  source. Permanent reputation/level number.
- **M4c Global Spendable:** the spendable split of lifetime. Purchases, Active
  Tier buys, competition entries and cosmetics all flow here. Goes up and down.

## Contract (future; this folder is the canonical home)

- The 2x/3x/4x Active Tier multiplier touches M4 flow-up ONLY (lifetime +
  spendable), never M3 local or M4a pure.
- Every credit carries its source tag (`Ludo`, `Ayo Olopon`, `signup_bonus`,
  `referral`, `giveaway`).
- Consumes the seam (M2): subscribe via `window.onGameResult` for the
  cross-game totals.

## Status

`planned` (architecture.json is the source of truth). Today there is one
`global_points` + `lifetime_points` on the profile and a single
`point_transactions` ledger; the next build migrates these into the 3-ledger
model here.