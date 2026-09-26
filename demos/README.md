# Foskaay GGI — Demos, organised by GENRE

**Status: PLANNING ONLY. No demo is built yet.**

A game developer looking at Foskaay GGI asks one question:

> "Gasless and cheap sounds good, but does it work for MY kind of game?"

So this folder is organised **by genre**, not by demo name. A developer opens the folder that
matches their build, plays the demo, and reads exactly how little code it took to plug in.

```
demos/
  idle/        idle, clicker, farming, mining
  casual/      hyper-casual, arcade, endless runner, match/puzzle
  pvp/         PvP arena, 1v1 battles, battle card games
  mmorpg/      RPG, MMORPG, MMO strategy, persistent worlds
  metaverse/   sandbox, virtual land, building, social worlds
  board/       board, tile, traditional/folk games (GlobalFolkGames' own niche)
```

Each genre folder holds: a `README.md` (what it proves + the adapter surface) and, once built, the
playable demo itself.

---

## 1. Why genre folders (not one folder per demo)

The pitch fails if a PvP studio is shown a folk board. It lands when they open **`pvp/`**, play a
PvP demo, and see "this is my game, and it is gasless." Genre is the first thing a developer knows
about their own game, so genre is the first thing this folder should expose.

---

## 2. Genre popularity (web3, from the live DappRadar top 50, 2026-09)

| Genre folder | Real examples in the top 50 | Why Foskaay GGI fits | Build priority |
|---|---|---|---|
| `mmorpg/` | Pixels, World of Dypians, Nine Chronicles, SERAPH, Heroes of Mavia | Long sessions, thousands of actions, persistent worlds — the biggest gas saving. | HIGH |
| `idle/` | COIN by XYO, PlayMining, Sweat Economy, Lingo, Bomb Crypto | Constant actions; a per-action fee destroys the model. Foskaay GGI is the ideal fit. | **HIGHEST (cheapest to build)** |
| `pvp/` | Arena of Faith, Battle Bulls, Crypto Gladiator, Pantheon TCG, Clashub | Skill + money; needs a game verifier for fair disputes. | HIGH |
| `casual/` | Arc8 by GAMEE, FlappyMoonbird, Solscape, Bowled.io | Easiest to build, largest audience, simplest way to show the rail. | **HIGHEST (fastest to build)** |
| `metaverse/` | Upland, Wilder World, Victoria VR, Sinverse, Artyfact | Land/buildings as opaque state — the strongest proof the rail is truly generic. | HIGH (best genericness proof) |
| `board/` | Rare in web3 | GlobalFolkGames' differentiation. Served by the rail, absent from the charts. | LIVE (the real game) |

Sports / racing / management (MetaSoccer, Race Kingdom, ZTX) and trading-card games (Pantheon TCG,
Voxies) fit later; they need extra rails (assets) to be fair demos.

---

## 3. Each genre folder

### `idle/` — idle, clicker, farming
- **Planned demo:** `idle-farm` — a plot that ticks, producing coins the player collects.
- **Proves:** a player performing hundreds of actions in one session costs the sponsor nothing
  inside the session. Random events (a bonus crop) come from the committed seed.
- **Why first:** cheapest to build and the clearest possible fit for the rail.

### `casual/` — hyper-casual, arcade, runner
- **Planned demo:** `endless-runner` — a fast arcade runner.
- **The runner is a CASUAL / HYPER-CASUAL game** (the genre of Subway Surfers, Flappy Bird, Arc8).
- **Graphics are already settled:** the owner forked
  `github.com/solomonfoskaay/rork-subway-surfers-clone` (a pure web2 / iOS clone). We reuse **only
  the art and game feel**, ported to a plain web canvas; we do not inherit its architecture.
- **Proves:** a fast arcade game is fully on-rail — randomness for obstacle/coin spawns, score as
  the value rail, and it runs in any mobile browser with no install.

### `pvp/` — PvP arena, 1v1, battle cards
- **Planned demo:** `arena-1v1` — two players, turn-based battle.
- **Proves:** two real players, per-participant authority enforced, a dispute resolved by the
  game's own verifier. The pitch demo for PvP studios.

### `mmorpg/` — RPG, MMORPG, MMO strategy
- **Planned demo:** `tiny-mmo` — a shared little world where many players act at once.
- **Proves:** many participants in ONE session, shared world state, persistence across sessions.
  Also proves participant count is open (not 2).

### `metaverse/` — sandbox, virtual land, building
- **Planned demo:** `land-grid` — plots you claim and build on.
- **Proves:** plots, buildings and ownership are opaque state the rail never inspects — the
  clearest proof that the rail knows nothing about a game's world.

### `board/` — board, tile, traditional/folk
- **Planned demo:** GlobalFolkGames itself (Ludo), live.
- **Proves:** the rail serves the niche the web3 charts ignore, and GlobalFolkGames is the first
  real game on it. This is the flagship, not a throwaway demo.

---

## 4. What every demo must have

1. **Playable in a plain browser**, mobile-first, no app store, no install.
2. **Zero gas for the player**, zero wallet popups.
3. **The rail visibly in use:** open a session, act freely, settle once, show the on-chain proof.
4. **A small `adapter.js`** (roughly 50 lines) showing exactly how little it takes to plug a game in.
   The adapter is the real deliverable of every demo.
5. **A README** stating: the genre, what it proves, the adapter surface, and the measured cost.

---

## 5. Where the demos are served

**Now (solo dev, one repo):** from a **path** on the existing domain:

> **https://globalfolkgames.fun/foskaay-ggi/demos/**

That page is `ggi-demos/index.html`. It reuses the normal GlobalFolkGames header (Dynamic-powered
auth) and footer, with its own content between them. It lists every genre folder from this
catalogue, shows **Live** demos as playable links and **Coming soon** demos as non-tappable cards,
and it is mobile-first: anyone can open it on a phone and play with no download.

**How to add a demo to the page:** drop the playable build into `demos/<genre>/`, then add one
entry to the `DEMOS` array in `ggi-demos/index.html` (name, icon, short description, what it proves)
and flip its `status` to `'live'` with an `href`. Nothing else to wire.

**Later (when Foskaay GGI becomes its own repo):** its own subdomain, not before.

---

## 6. Build order (one demo at a time)

Demos are **not built all at once**. Each is small, complete and working, and each is finished
(playable + measured + documented) before the next starts. The order starts with the two cheapest
and most convincing: **`idle/`** then **`casual/`**.

Per the project rules: building a demo is a decision, not a default. The owner approves each demo
before it starts.
