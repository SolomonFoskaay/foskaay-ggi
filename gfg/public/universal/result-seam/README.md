# M2 — Universal result seam (the plug-and-play contract bus)

The one integration contract between every game and every reward module.
Homed here so future games and universal modules point at a single,
findable, updateable place.

## Files

- `game-result.js` — the bus. Canonical envelope `gfg:game-result@1`.

## Game side (M1, the ONLY thing a game ships)

End the match with exactly one call:

```js
window.publishGameResult({ gameId, players, proof });
```

- `players[]`: `{ seat, actor: user|house|local, position|score }`
- `proof`: optional `{ method, chain, signature }` (on-chain verification)

Moves (as the dice) are NOT part of the envelope: a game never ships its own
reward or competition logic.

## Universal-module side (M3+)

Subscribe once, forever game-agnostic:

```js
const off = window.onGameResult(handler); // handler(result); off() unsubscribes
```

The bus also dispatches a `gfg:game-result` DOM event with `detail` = the
validated envelope for declarative listeners.

## Behavior

- Validates/normalizes the raw call into the canonical envelope.
- Attaches wallet identity to `user` actor seats.
- Fans out to every subscriber in subscription order.
- Current status: **in-progress** (built + emitted by Ludo ludo-lab; the
  M3/M4/M7 subscribers land with those modules, each homed in its own
  universal folder).