# Genre: board / tile / traditional / folk

**Status: LIVE via GlobalFolkGames itself. No separate demo needed.**

## Who this is for
Developers building board games, tile games and traditional/folk games. This genre is almost absent
from the web3 charts, which is exactly why it is **GlobalFolkGames' differentiation**: the niche is
unserved, and the rail serves it.

## Why Foskaay GGI fits
Board games are turn-based with rules that must be enforced. The rail gives each participant their
own authority, keeps play free inside the session, and lets the game's own verifier settle any
disagreement.

## The demo is the real game
Unlike the other genre folders, this one does not need a throwaway demo: **GlobalFolkGames Ludo** is
the live proof. It runs on the same rail, in the main app.

## What it proves
- A rules-heavy, turn-based game works on the rail.
- The Ludo verifier (the referee) ships first, proving the tamper-proof claim end to end.
- GlobalFolkGames is the first real user of its own rail — the strongest possible proof.

## Adapter surface (what a dev writes)
The Ludo adapter is the reference implementation other games copy. Roughly 50 lines serialising a
move into the opaque session payload, plus the game's verifier.
