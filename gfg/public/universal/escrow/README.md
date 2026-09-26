# M8 — Sponsor escrow (optional plugin, separate from M7)

Brand-funded prize pool locked on-chain BEFORE the event, 30/70 rake at
settle. A competition may use M8 or not.

- Program proof already built + verified on devnet (Competition account,
  fund/close/settle/claim, 70/30 winners bucket, one active comp per sponsor).
- Sponsor (brand) locks SOL on-chain before the event; winners claim gasless;
  platform keeps 30%.
- Kept SEPARATE from M7: a competition runs without M8 (airtime / manual
  payout). M8 is attached only when a brand wants a guaranteed escrowed prize.

## Status

`planned`, **deferred** until M7 product work begins (architecture.json is
the source of truth). The escrow program proof-of-life already exists and
stays idempotent on devnet.