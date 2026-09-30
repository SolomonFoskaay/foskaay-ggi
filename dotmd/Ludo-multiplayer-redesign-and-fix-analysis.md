# Ludo Multiplayer Redesign & Fix Analysis

**When:** 2026-09-30
**Branch:** osv1Arc
**Purpose:** The build spec for the NEW standalone multiplayer Ludo at
`gfgnew/board/ludo/`, replacing the abandoned `gfgnew/board/ludo-mp/` (left in
place, never deleted). Any future agent should read THIS file first, then the
Foskaay GGI docs (`docs/index.html#designing`), then build against it.

---

## 1. What the owner wants (verbatim intent)

- A fresh folder `/gfgnew/board/ludo` that works multiplayer (2P and 4P) on
  **Arc testnet** ONLY, powered by **Solidity contracts** (game + player) on the
  **Foskaay GGI** rail (the replica of MagicBlock ER that we built on Arc).
- The **battle-tested ludo-lab multiplayer** (`gfg/public/games/ludo-lab` +
  `gfg/games/ludo-lab/index.html`) is the DESIGN template: single shared board,
  real-time opponent moves (polling, not WebSockets), contract-owned turn timer,
  resume after reload / sign-out / other device, dedicated session page per match.
- Keep the ludo-lab board skin: **dark grid lines** and **big dice in the homebox
  (yard) shrinking to fit when on the path** (physics.js). Redesign nothing else
  visually; replicate the ludo-lab MP flow.
- The ludo-mp build was built by another AI agent and is buggy. **Discard it as a
  design, copy over ONLY what is sound and do not move or delete it.**
- Use the **Foskaay GGI SDK standalone** EXACTLY like the single-player demo
  `demos/board/ludo/` does (Dynamic auth, embedded EVM wallet, silent session-key
  signing, no popups, sponsor pays).
- **Only connect to the already-deployed Foskaay GGI CORE contract via the SDK**
  (testnet `0x793785CE66992211B7c60dFCf0318869678D33a4`). Do NOT connect this to
  the existing demo or to ludo-mp; it must stand alone.
- **The on-chain contracts are the single source of truth.** All rules and game
  mechanics stay on-chain; moves are saved as **bytes**, never graphics. The
  frontend only displays.
- **Gasless:** the game + player contracts ARE delegated/lifted into the Foskaay
  GGI midchain session FIRST (one connect/delegation tx), then every move runs
  free inside the session. Only the **connect/delegation start fee and the settle
  fee** are ever paid. No third fee (never write the board per move).
- **NO web2 infra, period.** No Supabase, no Vercel KV, no database. Vercel holds
  the sponsor signer key env and signs; nothing more. Persistence of a live
  mid-game session is PENDED (see section 5) unless a solution is found purely in
  the Foskaay GGI midchain / on-chain.
- Deploy/test on Vercel live mobile. Later this will gain stake/carn (earn), so
  it must be bug-free.

---

## 2. Why ludo-mp does not work (the finding, from code analysis)

Root cause is ONE fundamental defect plus several fixable bugs.

### FUNDAMENTAL: no durable shared server session state
- `api/index.mjs:592` `const mpSessions = new Map()` is **per-serverless-instance
  memory**. Vercel round-robins and cold-starts instances, so:
  - a lobby created on instance A is invisible to instance B ("Lobby not found on
    this server", `api/index.mjs:646`);
  - the host's own later calls can land on B ("unknown session");
  - the client retries (`bridge-mp.js:84-113`) are a lottery, not a fix.
- The ONE designed recovery (`doMpResync`, `api/index.mjs:946`) is **dead code**:
  `relay()` (`bridge-mp.js:74`) throws `!j.ok` BEFORE the rebuild branch at
  `bridge-mp.js:890` runs. So "relay lost session, rebuilding from verified
  copies" NEVER executes.

### Fixable bugs (all present)
1. **Reset deadlock at settle** — the user seat's signing key is in-memory only
   (`bridge-mp.js:949-956`), never persisted; after any reload the winner signs
   with a brand-new key and the relay rejects it ("bad signature for seat x",
   `api/index.mjs:1066`). A sealed match can never settle after a reload.
2. **No client-side verification** — the page loads CDN `@foskaay/ggi-sdk@0.2.4`
   which has no `verifyMoveLog`; the guard at `bridge-mp.js:916` silently no-ops.
   The repo-local SDK 0.2.6 DOES have `verifyMoveLog`
   (`packages/sdk/src/index.js:298`). Verify BEFORE drawing or render nothing.
3. **Slow matches can never settle** — `GFGGames.sol:378` reverts if any
   inter-move gap exceeds 60s (`turnSecs 45 + TURN_GRACE 15`). Any phone closed
   >60s with no device to fire a timeout advances → `BadTiming` forever.
4. **Chosen color seat ignored** — `bridge-mp.js:655` drops the tapped quadrant;
   `api/index.mjs:757` assigns FIFO in arrival order. 4P taps seat the player
   wrongly.
5. **Roll move dropped from cache** — `doMpRoll` never returns `move`, so
   `cacheAppend(r.move)` (bridge-mp.js:303) drops every roll → resync holes.
6. Contract-side: `GFGGames.settle` is **not idempotent** (double-call duplicates
   games); strict `_verifyTiming` (see #3); no replayed-session durability.

### What is SOUND in ludo-mp (copy it, don't rewrite)
- **GFGGames + GFGPlayers UUPS contracts** (36-byte board, `version`+`__gap`,
  `onlyGame` credit, contract-owned turn timer via `turnSecs`/`isTurnExpired`,
  `moveTss` verified at settle). All correctly deployed on testnet
  (`GFGGames 0x1016B2...`, `GFGPlayers 0xE85fC6...`, core `0x7937...`).
- The core `FoskaayGGI` `handoverWithAccounts` + `settle` cargo path in the relay.

---

## 3. The battle-tested ludo-lab MP design to replicate

From `gfg/public/games/ludo-lab/` (Solana+MagicBlock ER, verified live):

1. **One delegated board account is the room.** A single account holds
   `status, players[], handles[], current_turn, turn_secs, last_turn_ts[],
   move_count, last_move_commit[32], winner_seat`. ANY device reads it; the chain
   is the source of truth.
2. **Every move = a full board snapshot as bytes** (32 bytes: seat + die1 + die2
   + 16 token positions + next-turn byte). Encode in `multiplayer-adapter.js:98-
   122`; decode + rebuild token state in `positionToken` (`:143-174`). No move
   replay; the receiver reconstructs the ENTIRE board. Yard=80, home-lane=64..69,
   track=0..51. Marker seat 255 = timeout-advance.
3. **Real-time = polling every 1200 ms** (`multiplayer.js:142-165`), never
   WebSockets. Monotonic `move_count` guard so a late in-flight OWN move never
   reverts the turn (`multiplayer-adapter.js:347`).
4. **Contract-owned turn timer**, default 45s, permissionless `expire_turn` once
   the deadline passes (`multiplayer.js:197-212`).
5. **Resume by match code**: `?mp=CODE` (base36 of matchRef) on the dedicated
   session page; on reload/other device the adapter re-subscribes and replays the
   latest committed snapshot (`adapter.resume`, `:420-469`). Brand-new seats are
   rejected after status=1 (must use normal join while open).
6. **Host begins** (status 0→1, host-only authority), **winner-suffices settle**
   (loser does nothing; `win-detection.js` on-finish → rail.finish).
7. **Serialized commit chain** (`commitSnapshot`, `:610-649`): gasless board
   writes are sent ONE AT A TIME so the turn-pass is always the last write of a
   turn (kills the double-turn flash bug).

---

## 4. What must be adjusted going Solana → Arc/Foskaay GGI + the FIXES

| Battle-tested ludo-lab (Solana/ER) | New build (Arc/Foskaay GGI) |
| --- | --- |
| Board account on the ER; moves committed gaslessly to it | No per-move Arc write by design. The signed, hash-chained **move log in the relay IS the midchain** (`docs/index.html#designing`, `api/index.mjs:204-218`). The board is reproduced from the log by any device. |
| Program owns turn timer | **Contract** owns `turnSecs`/`isTurnExpired` in GFGGames; every phone reads the same value. |
| Any device reads board on-chain | Any device fetches the signed log from the relay and VERIFIES it client-side via SDK `verifyMoveLog` against on-chain anchors (Handover startHash/participants, settle finalHash) before drawing. |
| `?mp=CODE` session page | Same: `?game=<sessionId>` dedicated page; resume = rejoin by code. |
| 2P/4P toggle + seat colors | Same; **FIX seat choice** (honor the tap; see §2.4). |
| Gasless moves, pay at delegate only | Exactly two txs per match: connect/delegate + settle. **Never write the board per move.** |

### The concrete fixes to build in (deltas versus ludo-mp)
1. **Session-key persistence (per-device).** The seat's committed session key must
   survive reload. Store the FULL keypair for the CURRENT match seat in
   `localStorage` (public? NO: the key is a private key). See §5 for the no-web2
   rule: the private key CAN live in the player's own browser localStorage (it
   never leaves the device and never reaches the relay); that is exactly what the
   demo SDK expects (`window.ggiCreateSessionKey`, web/main.js:116-126). Persist
   `{sessionId, seat, privateKey}` keyed per user so reload re-signs with the SAME
   key. Other-device resume under the same wallet: pending (see §5), because the
   committed key was generated on the first device.
2. **Use the LOCAL SDK build (0.2.6)** with `verifyMoveLog` (vendor
   `packages/sdk/dist/ggi-sdk.browser.js`) instead of CDN 0.2.4. Run
   `verifyMoveLog(sessionId, {startHash, moves, sessionKeys, sponsorAddress,
   finalHash, settled})` BEFORE painting the board; tampered/cold logs are never
   drawn.
3. **Relax settle timing** without weakening the rules: keep monotonic + not-in-
   future + total-match-cap checks, but set a per-gap ceiling that does not strand
   a slow-but-real match (e.g. per-gap allowed up to several turnSecs, or drop the
   strict per-gap bound and rely on the timeout mark in the log + a generous
   maxMatchSecs). A forged clock still fails (monotonic + chain-anchored times).
4. **Honor the tapped seat** in join: pass `quad`/seat index through `mpJoin` and
   seat the wallet at that index (the lobby renders seats; joiners choose a free
   color).
5. **Return `move` from roll** so the device cache captures rolls too.
6. **Make `mpResync` reachable + correct**: `relay()` should return `{ok:false}`
   objects for "session not found" so the client can run the rebuild path; the
   relay's `doMpResync` then verifies envelope + chain-continuity + signatures and
   serves the reunited log.
7. **Unbreak the account count/fee:** lift exactly `[GFGGames, GFGPlayers]` at
   connect (`handoverWithAccounts`), games=1, fee = base + perAccount*2 + perGame*1,
   read live from the core.

---

## 5. Persistence of a live mid-game session (RESEARCH + DECISION)

Owner rule: NO web2 infra, the chain is the truth. Research done 2026-09-30 on
MagicBlock ER economics and the Arc/EVM equivalent.

### 5a. Is a PDA write on MagicBlock ER gasless? (owner's question answered)
From the official docs (`fees-and-commit-economics.md`, checked 2026-08-20):

- **Normal ER transaction: 0 lamports** in the current release. So a per-move
  write to a delegated PDA inside the ER is genuinely fee-free at the point of
  execution — the same as Foskaay GGI midchain moves (free `eth_call`).
- **Permanence is NOT free and IS batched.** The base-layer price is charged from
  a Solana deposit at **undelegation**:
  - one delegation session = 300,000 lamports (0.0003 SOL);
  - commits after the FIRST = 100,000 lamports each (0.0001 SOL), taken at
    undelegation, up to the deposit balance;
  - commits 1-10 are free even without a fee payer; commit 11+ needs the
    delegated-fee-payer path (commits 1-25 still no "live" fee, commit 26+ charges
    100,000/account immediately).
- So the owner's memory is EXACTLY right: **the per-move write is gasless; making
  it permanent is paid at commit/undelegation, batched in one settle.** There is
  no third per-move base cost on Solana+ER either.

### 5b. What is the EVM/Arc equivalent of a PDA?
- A Solana PDA = a program-derived address holding arbitrary bytes, owned by a
  program. On EVM/Arc, the equivalent is **contract storage**: the game contract
  IS the "account". There is no rent, no program-derived native account model, and
  **every storage write (SSTORE) costs gas** on Arc. There is no free per-move
  storage primitive on an EVM L1.
- The EVM analogue of "delegated, gasless PDA writes that settle once" is exactly
  what **Foskaay GGI already implements** as its **midchain**: the signed,
  hash-chained move log (computed free via `eth_call`, verified client-side), with
  connect + settle as the only two on-chain transactions. That is the ER "per-move
  gasless, settled-at-undelegation" model, already built.
- **Intermediate "live board" writes are the forbidden third fee** on both rails:
  on ER committing the board every move costs 0.0001 SOL each; on Arc writing the
  board every move is the SSTORE fee regression the Foskaay GGI docs forbid
  ("never write the board per move", docs/index.html).

### 5c. Why MagicBlock keeps the SPL token core contract separate
- Tokens are a distinct primitive: real SPL tokens live in per-mint **Global
  Vault** PDAs and per-owner lightweight **eATA** balance records (`ephemeral-spl-
  token/overview`). Token state cannot be a normal delegated account because value
  custody + deposit/withdraw on the base layer must be handled by a dedicated
  program (`SPLxh1LVZ...`). Same principle applies on Arc if USDC/USDT balances
  are ever needed in-game: keep value in ONE dedicated contract (the player
  account), never scatter it; the midchain credits it for free at settle.

### 5d. The decision for the new build (PENDING, no web2 infra)
- A live mid-game session is **midchain state held by the relay**; Vercel server-
  less restarts lose it. On-chain, only the Handover anchor (participants, start
  hash, seed commit) and the settled games persist forever.
- Therefore, **resume across a cold relay or a brand-new device is impossible for
  a live game without a durable store**, and the owner forbids web2 stores.
- **Scope for THIS build:** ship the game working flawlessly within a warm session
  (the same honest contract the single-player demo has: reload works on the same
  device via persisted seat key + local log cache; other devices can also fetch
  the log from the RELAY cache while the instance is warm). The relay remains the
  untrusted cache; the page NEVER fabricates a board when the log is gone
  (says "session lost, start a new match" like the demo's `handleLost`).
- **Future option (no web2):** store the full signed move log + envelope in each
  participating player's `localStorage` and let any player device call a
  permissionless `resync` that RE-CREATES the relay session from a verified copy.
  That is on-chain-anchored (verify against the Handover commitment) and needs no
  server store, only "at least one seated device alive". Decide later, outside
  this build.

---

## 6. Gasless rules (from .opencode/rules/env-access.md + docs)

- All writes go through the **Foskaay GGI midchain**: after the ONE
  `handoverWithAccounts` (delegation/connect + fee, sponsor pays ~0.0014 USDC for
  base + perAccount*2 + perGame*1, read fees live from the core), every roll/move/
  pass is a **free `eth_call`** + a staged signed hash. No `sendMagicTx`, no
  direct base writes for game actions.
- Soak: **exactly two transactions per match**: connect (delegation start) and
  settle (game commit + credit + core close). Measure with the cost probe and
  report honestly.
- The board is compact bytes (36-byte state: turn, finishCount, userSeat,
  seatCount, dieA, dieB, rollCounter, extraRoll, 16 stepsWalked, finishOrder[4],
  points[4]). The frontend only renders these bytes.

---

## 7. The build plan (approved by owner 2026-09-30)

1. Create `/gfgnew/board/ludo/` (index.html + bridge + contracts + tests), leave
   `ludo-mp/` untouched. Add vite input `gfgnew-board-ludo` and a header link
   (keep the ludo-mp link too).
2. Contracts in the new folder (UUPS, `version`+`__gap`, upgrade-safety tests):
   copy the ludo-mp GFGGames/GFGPlayers shape, apply §4 fixes: idempotent settle,
   timing relaxed per §4-3, seat gate by committed player. Deploy fresh permanent
   proxies on **Arc testnet** behind the existing core `0x7937...`; record in
   `deployments/addresses.mjs` + SDK; NEVER deploy fresh on mainnet.
3. Relay: additive `ludo2*` actions (create/join/begin/roll/move/pass/timeout/
   digest/sign/settle/board/moves/session/game/points) with the §4 fixes
   (honor seat, return move on roll, idempotent settle-with-credit, resync).
   Keep single Vercel function (`api/index.mjs` dispatcher pattern).
4. Frontend: `index.html` + `bridge.js` based on `demos/board/ludo` (Dynamic auth
   via `web/main.js`, session key `window.ggiCreateSessionKey`, silent signing,
   relay calls) + the ludo-lab board skin (board.js/physics.js/paths.js: dark grid
   lines, big yard dice, small on-path). MP flow mirrors ludo-lab adapter: full
   board snapshot commit, 1200ms poll, monotonic guard, serialized commit chain,
   45s contract timer + permissionless timeout, host begin, winner-suffices
   settle, `?game=` resume, verify-before-draw with local SDK 0.2.6.
5. Solo-test parity: solo mode plays house/computer seats signed by the relay
   sponsor (earn nothing), same as ludo-mp; MP is real seats only.
6. Deploy: forge test → deploy on testnet → `npm run build` green → live 2-device
   test on Vercel preview + cost probe.
7. Commit/push to osv1Arc ONLY after owner-reconfirm + leak scan.

---

## 8. Guards (rules that must be respected)

- `.opencode/rules/foskaay-ggi-game-design.md`: one game account + one player
  account lifted; board = bytes; credit points at game end inside the room;
  nothing runs outside the session window; report (a) accounts lifted, (b) board
  bytes size, (c) where/when points credited, (d) nothing outside the session.
- `.opencode/rules/env-access.md`: never read `.env`/`id.json`/keypair silently;
  ask the owner before any deploy that needs the sponsor key; use Alchemy-style
  RPC only for reads, never feature writes.
- `.opencode/rules/upgradeable-contracts.md` + `foskaay-ggi-contracts.md`: UUPS
  only, append-only storage, permanent proxy addresses, don't rename contracts.
- `.opencode/rules/security-leak-scan.md`: run before ANY commit/push.
- `.opencode/rules/content-style-guide.md`: no em/en dashes in user-facing copy.
- `.opencode/rules/todo-status.md` + `todo-admin.md`: keep `gfg/public/changelog/
  todo.json` in sync; full todo list re-output on every report/commit/push.

---

## 9. Reference file inventory

| Path | Role |
| --- | --- |
| `gfgnew/board/ludo-mp/` | ABANDONED buggy build; READ ONLY, never modified/deleted |
| `gfgnew/board/ludo-mp/GFGGames.sol`, `GFGPlayers.sol` | Sound UUPS contracts to copy shape from (with §4 fixes) |
| `gfgnew/board/ludo-mp/bridge-mp.js` | Bug source; the fixes in §2/§4 |
| `api/index.mjs` | Relay; `mp*` actions are the base to fix/copy as `ludo2*` |
| `demos/board/ludo/index.html` + `public/foskaay-ggi-assets/ludo-lab/bridge.js` | THE frontend + SDK pattern to follow (Dynamic auth + silent key + relay) |
| `public/foskaay-ggi-assets/ludo-lab/{board,physics,paths}.js` | Board skin (dark lines, big yard dice) |
| `packages/sdk/src/index.js` + `dist/ggi-sdk.browser.js` | Local SDK 0.2.6 WITH `verifyMoveLog` (use this, not CDN 0.2.4) |
| `src/FoskaayGGI.sol`, `docs/index.html` | Core contract + the rail contract (connect/settle only) |
| `deployments/addresses.mjs` | Addresses source of truth |
| `gfg/public/games/ludo-lab/mechanics/state/multiplayer-adapter.js`, `gfg/public/universal/multiplayer/multiplayer.js` | THE MP design to replicate (snapshot commit, poll, timer, resume) |
| `gfg/games/ludo-lab/index.html` | Page MP lobby/timer/resume inline logic reference |

---

## 10. Done/accepted scope

- Build `/gfgnew/board/ludo` standalone on Arc testnet, fully on-chain rules in
  the contracts, exactly 2 tx/match, board-as-bytes, real-time shared board for
  2P/4P, contract turn timer, resume by `?game=` within a warm relay session
  (cold-relay resume PENDING, no web2 infra).
- Move NO existing files; delete nothing; leave ludo-mp intact.

---

## 11. LIVE MEASUREMENT (2026-09-30, Arc testnet, `testproof/ludo2-midchain-measure.mjs`)

Deployed on testnet 2026-09-30:
- `LudoGames` proxy `0xd3e1d2b29c6832d30510e55d2a95d53316a239df`
- `LudoPlayers` proxy `0xac8867c904c6f26789fbbe6d3f9872d96c2368cf`
- Core (unchanged) `0x793785CE66992211B7c60dFCf0318869678D33a4`
- Sponsor `0xAd0A4348C7202E44e96c3FAE1cBB0B645dD86EB4` (54.4 USDC testnet)

### Fees measured (both tests: exactly TWO transactions per match)
| Item | costUsdc6 | notes |
| --- | --- | --- |
| Connect (handover, sponsor pays) | 5748 + fee 0.0014 USDC | same in both tests (lifts [LudoGames, LudoPlayers], games=1) |
| Every roll / move / pass | 0 | free `eth_call` + signed midchain entry (6-12 moves per test, all 0) |
| Settle TEST A (no winner, no points) | 6299 | LudoGames.settle + core.settle |
| Settle TEST B (seat 0 wins + 100 pts) | 8322 | +2023 (the credit + bigger committed board) |
| Sponsor spent whole harness | 0.0262 USDC | 2 connects + 2 settles |

### Persistence answer (the exact question the owner asked)
**While the Foskaay GGI session is STILL OPEN, NOTHING is written to the game or
player contracts.** Direct Arc reads during the session show:
- core: `isPaid=true`, commitment stored, `liftedAccounts=[LudoGames,
  LudoPlayers]`, `sessionGames=1` — these exist since connect (the only on-chain
  writes during a session).
- LudoGames: `gameCount=0`, no `gamesOf`, `liveBoard` slot EMPTY
  (`0x`), `playerGameIndex=[]`.
- LudoPlayers: `pointsOf(user)=0` — **even after the logged-in user WON on the
  midchain** (crown + points are in the signed log, not on the contracts).

**After settle**, the same direct reads show:
- LudoGames: `gameCount=1`, committed board with the crown (`finishOrder[0]=0`,
  points bytes `[100,0,0,0]`), `playerGameIndex=["0"]`.
- LudoPlayers: `pointsOf(user)=100` — credited to the logged-in user's wallet.

**Conclusion (real-time limitation of Foskaay GGI):** the midchain does NOT do
persistent per-move writes. Board/crown/points live only in the signed hash-chain
until `settle`; the player account is credited and the board committed ON EARTH
at settle. This matches the design contract ("connect and settle are the only
two transactions") and the ER parallel (gasless per-move writes, permanence paid
+ batched at commit/undelegation). Value transfer mid-session follows the same
rule: an in-ER balance is credits at settle, never a live contract write.