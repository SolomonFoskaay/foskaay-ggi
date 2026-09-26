# Genre: idle / clicker / farming / mining

**Status: PLANNED. No demo built yet.**

## Who this is for
Developers building idle, clicker, farming, mining or "play to earn by ticking" games.

## Why Foskaay GGI fits
Idle games ask the player to perform actions constantly. On a normal EVM chain every action is a
transaction, and the sponsor pays for all of them — which makes the model impossible. Inside a
Foskaay GGI session, actions cost nothing. This is the single best fit for the rail.

## Planned demo
`idle-farm` — a plot that ticks, producing coins the player collects, with an occasional random
bonus crop.

## What it must prove
- Hundreds of player actions in one session, still free.
- Random events derived from the committed seed (verifiable after reveal).
- The score/coin value rail delivered without any per-action cost.

## Adapter surface (what a dev writes)
Roughly 50 lines: serialise "collect plot N" into the opaque session payload, and read the settled
result to credit the player. Nothing else.
