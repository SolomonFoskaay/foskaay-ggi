# M3 — Local points (per game, PURE + SPENDABLE)

Verified gameplay + win only. No multiplier, no purchase, no bonus, no
referral. Never diluted. The bragging-rights source of truth per game, plus a
per-game spendable split drawn only by that game's own in-game spends.

## Contract (this folder is the canonical home — module built)

- On-chain per-game points PDA: seed `[gfgpoints, game_tag, player]`, one
  ledger per game (`ludo`, `ayo_olopon`, ...) so 50+ games each stay isolated.
  One PDA holds BOTH tracks:
  - `local_pure_lifetime` (unspendable lifetime wins in that game)
  - `local_spendable_balance` (the spendable split, credited alongside pure on
    every verified win, decremented ONLY by that game's own spends)
- `record_points(game_tag, points, reason, match_ref)` writes the pure base win
  (per-game scoring table, NOT a multiplied total). `spend_local` decrements
  spendable only.
- Proof-of-play gated: a valid on-chain proof signature must exist for the win
  to bank; `match_ref` = first 8 bytes of that signature (idempotent).
- Consumes the seam (M2): `local-points.js` subscribes `window.onGameResult`
  ONCE and banks verified finishes (`actor === 'user'` only, at its own
  position) via `window.magicblockDice.recordPoints(gameTag, ...)`.
- Exposes `window.localPoints = { get(gameTag), fetch(gameTag), spend(gameTag,
  amount, reason, ref), subscribe(cb), clearTransient(), lastAward,
  lastSeenAward, lastError }` and fills any DOM slots marked
  `data-local-points-pure` / `data-local-points-spendable` on any game page.
- Banking is resilient + observable: the write retries up to 3x (the on-chain
  `DuplicateMatchRef` guard keeps retries idempotent), a confirm-timeout false
  failure is recovered by re-reading the ledger (if the match_ref landed the
  award is treated as banked), and any final failure publishes a
  `status:'failed'` notification with `lastError` so ceremonies can explain a
  pending state instead of showing nothing. Games call `clearTransient()` when
  a new match starts so one finish's line can never leak into the next
  ceremony.
- Ludo scoring (owner-locked): 4P 1st=100/2nd=50/3rd=10/4th=0, 2P 1st=100
  only. The table lives HERE (module config), never in the game.

## Status

`in-progress` (architecture.json is the source of truth). Ludo game (ludo-lab)
emits the seam; this module banks the owner-locked awards gasless on the ER.
Migration of pre-module untagged `[gfgpoints, player]` ledgers shipped
(`migrate_points`, permissionless/idempotent/base-layer).
