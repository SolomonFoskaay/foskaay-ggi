# Genre: RPG / MMORPG / MMO strategy

**Status: PLANNED. No demo built yet.**

## Who this is for
Developers building RPGs, MMORPGs, MMO strategy or any persistent world with many players acting at
once — the largest genre in the web3 charts (Pixels, World of Dypians, Nine Chronicles, SERAPH).

## Why Foskaay GGI fits
This is where a normal EVM chain fails hardest: thousands of actions per player, per hour, forever.
Paying per action is impossible. Inside a session everything is free, and the world state can span
many sessions while still settling on-chain.

## Planned demo
`tiny-mmo` — a shared little world where several players act at the same time.

## What it must prove
- Many participants in ONE session (proves participant count is open, not 2).
- Shared world state that all participants act on.
- Persistence across sessions: the world survives settle, and reopens.
- The rail never inspects the world — it is opaque state.

## Adapter surface (what a dev writes)
Roughly 50 lines: serialise a world action into the opaque session payload; read the settled world
state back. The world's own logic stays in the game.
