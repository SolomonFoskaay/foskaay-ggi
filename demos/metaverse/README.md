# Genre: metaverse / sandbox / virtual land / building

**Status: PLANNED. No demo built yet.**

## Who this is for
Developers building sandbox worlds, virtual land, building and social-world games (Upland, Wilder
World, Victoria VR, Sinverse, Artyfact).

## Why Foskaay GGI fits
These games are made of constant small state changes (place, move, build, decorate) and they must
persist. Paying per change is impossible; a session absorbs all of them and settles once.

## Planned demo
`land-grid` — a grid of plots a player can claim and build on.

## What it must prove
- Plots, buildings and ownership are **opaque state** the rail never inspects. This is the clearest
  demonstration of the core law: the rail knows nothing about a game's world.
- A real-estate grid, a war zone and a galaxy are all treated identically.
- Persistent ownership across sessions, settled on-chain.

## Adapter surface (what a dev writes)
Roughly 50 lines: serialise a land action (claim / build / upgrade) into the opaque session payload;
read the settled land state back.
