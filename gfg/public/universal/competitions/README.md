# M7 — Competitions (standalone, game-agnostic)

Earn events (daily/weekly/monthly) with leaderboards. A competition selects
which games' points count, never tailored to one game.

- Entry = points requirement + optional custom fields (e.g. phone number for
  airtime).
- Plugs into one / multiple / all games.
- Pluggable payout: airtime (via phone field), on-chain escrow (M8), or
  manual. Runs fine with NO sponsor.
- Consumes the seam (M2): subscribe via `window.onGameResult` for verified
  finishes.
- NG test-launch plan: 1-2 week launch, daily airtime to winners via the
  phone number collected at entry.

## Status

`planned`, **deferred** until M1-M4 are stable (architecture.json is the
source of truth). Product/UI build for competitions waits; the on-chain escrow
program proof already exists.