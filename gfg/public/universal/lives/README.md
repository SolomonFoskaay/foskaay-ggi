# M10 — Lives + Daily Rewards (universal module)

The free-play meter and the recurring daily earn, both boosted by an active
Level-2 subscription. Lives here physically per the architecture spec
(`public/changelog/architecture.json`, M10).

## What the module owns

- `lives.js` -> `window.gfgLives`
  - `get()` -> `{ livesLeft, totalForLevel, resetsInMs }` (pure localStorage
    read, wallet + UTC-day scoped). `totalForLevel` follows the LIVE
    subscription view (`window.activeTier.get()`): free = 5/day, Level-2 = 10.
  - `consume()` manual consume (idempotent per UTC day by the used counter).
  - `subscribe(cb)` for meter UI updates.
  - Auto-consumes **one life per COMPLETED match** by subscribing to the M2
    result seam (`window.onGameResult` + `gfg:game-result`). Abandon, reset,
    and mid-game network disconnect never emit a completed result, so they
    never cost a life. Only matches where the signed-in user's seat (`actor:
    'user'`) played consume a life.
  - Slots: `[data-lives-left]`, `[data-lives-total]`, `[data-lives-resets-ms]`.
- `daily-reward.js` -> `window.gfgDaily`
  - `get()` -> `{ claimedToday, amount, tierLevel }` (pure read).
  - `claim()` -> banks **kind=1, source_code 14 (daily_reward)** into the M4
    global ledger via `window.globalLedger.credit()`. Free = 25P/day,
    Level-2 = 200P/day. Requires sign-in; the write is confirmed before the
    local claim marker is set (sig OR `lastMatchRef` read-back), so a
    transient failure never silently loses the day's reward.
  - Slots: `[data-daily-amount]`, `[data-daily-claimed]`.

## Contract

- Upstream M2 (seam): match-completion signals -> consume a life.
- Upstream M5 (`window.activeTier.get()`): boosted pool + reward size.
- Upstream M4 (`window.globalLedger.credit()`): the daily reward bank.
- Downstream games (any M1): gate match start against `gfgLives.get().
  livesLeft`, and never ship their own lives/reward code.

## Load order

Both files must load after `premium-ledger.js` (needs `window.activeTier`) and
`global-ledger.js` (needs `window.globalLedger`). `public/header.js`
(`initGlobalHeader`) ensures all universal modules on every page.

## Notes

- No RPC of their own: lives are pure local bookkeeping; daily shows
  `claimedToday` from local state. The on-chain truth lives in the M4 ledger.
- Wallet-keyed caches (`gfg_lives_cache_v2`, `gfg_daily_cache_v1`) so a shared
  browser never shows one user's lives/daily claim to another.