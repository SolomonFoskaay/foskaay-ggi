# Foskaay Gasless Games Infrastructure (Foskaay GGI) (standalone project)

**Status: CORE IN PROGRESS. Three of four core contracts built and tested**
(`SessionRegistry`, `SessionState`, `Randomness`). Nothing is deployed, and
nothing in the GlobalFolkGames app uses it yet.

The full design is in [`../docs/globalfolkgames-bs-spec.md`](../docs/globalfolkgames-bs-spec.md). Read that first.
The authoritative spec is `public/changelog/architecture.json` module `arcv2m18`.

---

## What this is (one paragraph)

Foskaay Gasless Games Infrastructure (Foskaay GGI) is a **room** you open on-chain, do everything inside for
free, and settle back to the chain once. It is the Arc (Circle EVM) equivalent of MagicBlock's
Ephemeral Rollup: free execution inside a session, one small on-chain cost to open and one to settle.
It is a **standalone project** on purpose: any game can plug into it, and GlobalFolkGames is only its
first user. Players never pay gas and never see a wallet popup.

It is **not** a board-game system. Ludo, chess, an idle game and an MMORPG are all the same thing to
this rail: a set of participants, an opaque state model the game defines, signed events, and one
settlement. If this repo ever contains the words board, token, position, seat count, turn or dice,
it has already gone wrong.

---

## The four calls (the entire API)

1. **OPEN** — start a session (participants, rules blob, lifetime, optional committed seed, fee
   profile, attached value rails). Returns a session id.
2. **ACT** — record a signed session event (session id, signer, opaque payload, sequence number).
   Zero chain cost. The rail never parses the payload.
3. **DISPUTE** — optionally challenge the state; the game's own verifier decides the truth. Free.
4. **SETTLE** — close the session (final signed summary + revealed seed). One on-chain record, then
   batched into a Merkle root with many other sessions.

---

## Naming

The full brand name is used everywhere a stranger can see it: **Foskaay Gasless Games
Infrastructure**. The short form **Foskaay GGI** is used only in internal docs after the full name has
appeared. Packages are `@foskaay/ggi-sdk` and `@foskaay/ggi-contracts-sdk`.

Never call this an "ER": MagicBlock's ER is an SVM runtime, this is a session/channel layer on EVM.

---

## Layout (planned)

```
globalfolkgames-bs/
  src/                       CORE — the 4 unopinionated contracts (nothing else is core)
    SessionRegistry.sol      open / close sessions; participant authorities; session keys (scope + expiry)
    SessionState.sol         accept signed session events; sequence numbers; digest
    Randomness.sol           commit-reveal seed(s); derive hash(seed, counter)
    FeeVault.sol             per-session fee collection; configurable destination
    verifiers/               OPTIONAL per-game verifiers (a verifier is a pattern, not core)
  demos/                     playable demos organised BY GENRE (see demos/README.md)
    idle/                    idle / clicker / farming
    casual/                  hyper-casual / arcade / runner
    pvp/                     PvP arena / 1v1 / battle cards
    mmorpg/                  RPG / MMORPG / MMO strategy
    metaverse/               sandbox / virtual land / building
    board/                   board / tile / traditional (GlobalFolkGames' own, live)
  test/                      Foundry tests
  packages/
    sdk/                     @foskaay/ggi-sdk — the one-line integration
    contracts/               @foskaay/ggi-contracts-sdk — interfaces + deployed addresses
```

`BatchWindow.sol` and `ParticipantAccount.sol` are **NOT** core and are **not** part of this
contract set: they are OPTIONAL patterns a game may adopt, offered as examples, never enforced
(see CORE vs OPTIONAL below). Core files are built one at a time, each ending with a live Arc
testnet proof before the next step starts.

---

## CORE vs OPTIONAL (the most important rule — never blur this line)

This rail is deliberately **unopinionated**, exactly like MagicBlock's: it hands a developer
primitives and lets them decide their own account layout, commit cadence and cost profile.

### CORE — the 4 unopinionated primitives (what we build)
These make **no decision for the game**. Any game type, any account layout, any cadence.

| # | Contract | Responsibility |
|---|---|---|
| 1 | **SessionRegistry** | open/close a session; participant authorities; session-key registration (scope + expiry) |
| 2 | **SessionState** | accept signed session events (opaque payload + sequence number + digest) |
| 3 | **Randomness** | commit-reveal seed(s); derive `hash(seed, counter)`. Used only by games that ask for it |
| 4 | **FeeVault** | per-session fee collection; configurable destination |

**Core = 4 contracts.** Nothing else is required to ship a gasless game.

### OPTIONAL — GFG's own opinions, offered as patterns (never enforced)
A developer may use these, or ignore them, or build their own. They are examples, not requirements.

| Pattern | What it is | Why it is optional |
|---|---|---|
| **Batched Settlement** | fold many session settlements into one Merkle root per window | A dev may want an immediate commit per session. Cadence is theirs. |
| **Managed Accounts** (PlayerCore-style) | ONE account per player with slots for every game/feature | A cost optimisation. A dev may prefer one account per game, per match, or ephemeral accounts. |
| **Verifiers** | a per-game referee that replays a dispute | Only games that carry money truly need one. Free games need none. |
| **House / relayer as a participant** | the AI or house seat is a participant whose authority is the relayer key | Only games with an AI or house opponent need it. |

### Law 1 — the rail never learns a game concept
No board, token, position, seat count, turn or dice in the rail. The game's state is an opaque
payload. A real-estate grid, a war zone and a galaxy are all the same to the rail.

### Law 2 — account layout is the developer's choice, but upgrades must be safe
The rail does NOT mandate one account per player. It supports a dev who wants one account per
feature, per match, or per game, unchanged. Where GFG offers its own optimisation (Managed Accounts),
it does so as an OPTIONAL pattern: `version` byte first, new fields last, a permissionless idempotent
`migrate_*` in the SAME deploy, never `init_if_needed` onto a changed seed, so an upgrade never
touches or orphans a player's data. That is an offered example, never a rule the rail enforces.

---

## Economics (why this sustains itself)

Modelled on MagicBlock, who charge for **sessions and commits**, not usage:

- A small **fixed fee per session**, charged on open and on settle. Never per action, never per
  feature. So Ludo, chess, an idle session and an MMORPG session all carry the same tiny fee.
- The fee applies on **devnet too**, and goes to the owner's wallet. This is deliberate: MagicBlock's
  devnet looks free, so developers cannot tell what mainnet will cost them. Here a developer tests
  against the true economics before committing.
- GlobalFolkGames **pays like any other game** — it is the proof of concept and the battle test.
- The owner takes 100% at first; a protocol/node split can come later if dedicated infrastructure
  is added.
- Players always pay nothing.

---

## Build order

CORE first, and only the core:

1. **Skeleton + README.** DONE.
2. SessionRegistry + SessionState + session keys. DONE (`35/35` + `28/28` tests).
3. Randomness (commit-reveal, N streams). DONE (`17/17` tests).
4. FeeVault (per-session fee, configurable destination). This step.
5. Plug Ludo in as the first game (single-player first, then multiplayer).

OPTIONAL patterns come later, as separate opt-in work, only when a game asks:
Batched Settlement (Merkle), Managed Accounts (PlayerCore-style), Verifiers (Ludo first).

Each step ends with a **live Arc testnet proof** before the next step starts.
