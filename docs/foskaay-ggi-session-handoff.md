# FOSKAAY GGI — SESSION HANDOFF (copy this whole file into a new session)

> **SUPERSEDED IN PART (2026-09-26).** This handoff describes the earlier 4-contract core. The built
> reality is ONE core `FoskaayGGI` plus the game `FoskaayGGIGames` and the player account
> `FoskaayGGIPlayers` (all UUPS on Arc testnet), wired and deployed. Names are locked. For current
> addresses and the authoritative spec read `public/changelog/architecture.json` module `arcv2m18`
> and `AGENTS.md`; treat the address list and contract split below as historical.

You are continuing work on **Foskaay GGI** inside the `globalfolkgames` repo.
Read this file first, then `AGENTS.md`, then `public/changelog/architecture.json`
module `arcv2m18`. Do not assume; verify with `git status` and
`git fetch origin && git log --oneline -5 origin/main`.

Repo: `/home/foskaay/globalfolkgames`
Branch you work on: **`osv1Arc` ONLY**. Never commit or push to `main`.
The owner creates the PR from `osv1Arc` to `main` and approves it. Vercel then
deploys main to production. **Previews deploy automatically on push; never build
FOR preview and never make preview part of the workflow.**

Always `git fetch origin` before comparing to main (local main is stale).

---

## 0. HARD RULES (non-negotiable, from AGENTS.md and .opencode/rules/)

1. **Module-First gate** before ANY feature code: read
   `public/changelog/architecture.json`, state the module
   (`Module: arcv2m18 — Foskaay GGI (status: planned)`), slot-check, confirm
   input/output contracts. Never build an unmodular feature.
2. **Surgical edits only.** Read the whole file first; edit exact lines; never
   rewrite, never "clean up" unrelated code, never remove existing behavior.
   Ask the owner before removing anything.
3. **architecture.json / changelog.json / todo.json are protected.** Read, assert
   top-level keys survive, edit exact lines, never rewrite wholesale. Never change
   architecture.json without the owner's explicit approval for THAT change.
4. **Never ask to push; the workflow is: commit, then push to `osv1Arc`.** The
   owner handles PR + approval. (Owner confirmed 2026-09-22.)
5. **Run the preflight before push:** `npm run build` green, `node --check` on
   changed JS, `git ls-files | grep programs/target` empty, only ONE serverless
   function (`api/index.mjs`), no secrets, and the leak scan
   (`.opencode/rules/security-leak-scan.md`). Any secret hit = HARD STOP.
6. **No secrets in commits, logs, chat, or repo.** The Arc sponsor key lives at
   `~/.config/gfg/arc-sponsor.json`; the npm token at `~/.config/gfg/npm-token`
   (mode 600, outside the repo). Never read `.env` or those files without the
   owner's explicit approval in that turn.
7. **No player-pay, ever.** This rail exists to make on-chain games GASLESS. The
   SPONSOR (the game operator) pays all gas and the per-session fee. The player
   never pays and never sees a wallet popup during play. There is NO player-pay
   mode anywhere in core, optional, or the SDK. Do not add one.
8. **On-chain is the only truth.** A game's state lives in its OWN contract on
   Arc. The frontend only READS it and sends actions. **No localStorage, no
   frontend-owned state, no "offchain demo".** If you build a game demo whose
   truth is not on-chain, you are building the wrong thing.
9. **No cron, no scheduler, no external automation.** Anything periodic is
   permissionless (anyone may call it) or batched, never a server or cron.
10. **Content style:** no em dashes (—) or double dashes (--) in user-facing copy
    (`.opencode/rules/content-style-guide.md`).
11. **Explain like a beginner** when reporting to the owner.

---

## 1. WHAT FOSKAAY GGI IS (and how it differs from GlobalFolkGames)

- **GlobalFolkGames (GFG)** = the game platform (native games, points, tiers,
  competitions, the site). Separate product.
- **Foskaay GGI** = a STANDALONE gasless rail that ANY game plugs into. It is the
  Arc (Circle EVM) equivalent of MagicBlock's Ephemeral Rollup. GFG is its FIRST
  user, not its purpose. It will become its own repo.
- **Naming:** full name "Foskaay Gasless Games Infrastructure"; short form
  "Foskaay GGI" ("Foskaay" is NEVER shortened). Never call it an "ER". npm scope
  `@foskaay/ggi-sdk` and `@foskaay/ggi-contracts-sdk`.
- **arcv2m17 is a DIFFERENT, discarded design (GFG-BS).** Never merge it with
  arcv2m18. Never rename arcv2m17's `GFG-BS` references.
- Folder: `foskaay-ggi/` (its own Foundry project). Docs page: `/foskaay-ggi/docs/`.
  Explorer: `/foskaay-ggi/explorer/`. Demos homepage: `/foskaay-ggi/demos/`.

### Why it exists / the EVM vs SVM truth

- MagicBlock (SVM) delegates an account into an ER and mutates it FOR FREE.
- **Arc has no ER and no free execution layer.** But EVM gives the next best thing:
  a PURE function runs for free via `eth_call`. That is the **Foskaay GGI Midchain** (see
  section 3): moves are signed and hash-chained off-chain and executed for free;
  only the session endpoints touch the chain. So "gasless" here means (a) the
  PLAYER never pays, and (b) the SPONSOR pays only for a couple of transactions per
  match, not per move. Never claim "free like the ER" on Arc, and never add a
  player-pay path.

---

## 2. THE ARCHITECTURE (what exists, deployed, and proven)

### CORE = exactly 4 unopinionated contracts (`foskaay-ggi/src/`)
1. `SessionRegistry` — open/close a session, per-seat authorities, session keys
   (scope + expiry), and the **session-to-game-state link** (`setGameState` /
   `gameStateOf`).
2. `SessionState` — signed events (opaque payload + sequence + digest), seal final.
3. `Randomness` — commit-reveal seeds, N streams, `derive(seed, counter)`.
4. `FeeVault` — ONE per-session fee, charged at settle, in USDC, to a configurable
   destination.

### OPTIONAL = separate contract, NEVER core
5. `BatchedSettlement` — submit a session digest into a window; PERMISSIONLESS
   flush (full or past deadline) into one Merkle root; Merkle-proof verify. The
   DEV sets its own window rules via `setWindowConfig(maxSize, windowSecs)`.

### The model the rail implements (decided with owner)
- The rail is a ROOM: session, participants, authorities, randomness, fee,
  settlement. It NEVER learns a game concept (no board/position/seat/turn/dice).
- The GAME owns its world in its OWN contract: the **board is the game's and is
  SHARED by all players** (one account), and a **player has at most ONE player
  account** holding everything about that player. Neither is rail core.
- Authorisation: the game contract checks
  `SessionRegistry.canSign(sessionId, seat, msg.sender)` before every action.
  This is the EVM equivalent of MagicBlock's delegation authority.
- **UPGRADEABLE (UUPS proxies).** Proxy addresses are PERMANENT. Storage is
  APPEND-ONLY: new variables consume from `__gap` (shrink it by the same count),
  never reorder/rename/remove. `initialize()` not a stateful constructor;
  implementations are `_disableInitializers()`. ALWAYS run
  `foskaay-ggi/test/UpgradeSafety.t.sol`. AFTER any upgrade, REPORT to the owner:
  proxy address unchanged, data verified intact, the tx, the new logic summary.
  Upgrade authority is the owner now; move to timelock/multisig BEFORE mainnet.

### Deployed on Arc testnet (chain 5042002), UUPS proxies, PERMANENT
- SessionRegistry `0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5`
- SessionState   `0x34945e897Ec9a5CC4ab41d78c8ABe3B5034C5c8e`
- Randomness     `0x6DD15cf4d4E2D29dd4AA871d6fd012221212B38b`
- FeeVault       `0x4cf542791faeb683f878bd3d119683e0C02F9905`
- BatchedSettlement `0x5831E31789cAD85Dd263Ec78D73D8289FDc523c4`
- Demo/game contracts (NOT core): the Ludo demo pair (see `arc-testnet.json`).
  The early Generals demo and the event-only/event-midchain prototype contracts
  were removed from the project on the owner's instruction.
- RPC `https://rpc.testnet.arc.io`; USDC (ERC-20 view, 6dp)
  `0x3600000000000000000000000000000000000000`. Addresses live in
  `foskaay-ggi/deployments/arc-testnet.json` and
  `foskaay-ggi/packages/contracts/deployments/addresses.{json,js}` (keep in sync).
- Deploy: `forge script script/DeployGI.s.sol:DeployGI --rpc-url <arc>
  --private-key <key> --broadcast`. Forge leaves the key in `broadcast/`+`cache/`
  (gitignored); SCRUB them locally after deploy (defense in depth).

### npm packages (published)
- `@foskaay/ggi-contracts-sdk` **0.1.4** — `IGgi.sol` interfaces + addresses.
- `@foskaay/ggi-sdk` **0.1.4** — `GgiClient` (open/act/settle/dispute,
  `createSessionKey`/`signAction`/`actSigned`/`verifyAction`, read helpers,
  `setGameState`/`gameStateOf`, `fees()` reads the fee at runtime), plus a ready
  browser bundle at `dist/ggi-sdk.browser.js` (`window.GgiSdk`).
- Publish flow (beginner guide: `docs/foskaay-ggi-npm-publishing-guide.md`): bump both,
  regenerate the browser bundle, `npm pack`, publish contracts FIRST then sdk,
  poll the registry for propagation, then CLEAN INSTALL in a temp folder to prove
  a stranger can install. `@foskaay/ggi-sdk` must depend on the matching
  `@foskaay/ggi-contracts-sdk` version.

### Sponsor relay (serverless, sponsor pays, players never do)
- `api_handlers/foskaay-ggi-sponsor.mjs`, route `/api/foskaay-ggi-sponsor` registered in
  `api/index.mjs` (single serverless function rule) and mirrored in
  `scripts/relay-server.mjs` for local dev.
- Env: `GFG_Arc_Gasless_Sponsor_Key` + `GFG_Arc_RPC`.
- Actions: open / setAuthority / setGameState / game / gameBoard / settle /
  batchSubmit / batchFlush / sponsorAddress. `game` is a FIXED switch (createBoard /
  generate / join / setReady / start / command / tick / finish), never arbitrary
  calldata. Every action returns the REAL cost (`gasUsed × effectiveGasPrice`
  from the receipt) so the UI can show true spend. **Never hardcode cost estimates.**
- Found by the outsider test: a session opened WITHOUT `setAuthority` can never
  settle (`sealFinal` needs a seat authority). The relay sets authorities at open.
- Game contract addresses live in `api_handlers/foskaay-ggi-sponsor.mjs` `ADDR` (data, no
  build dependency) and in `foskaay-ggi/deployments/arc-testnet.json`.

### Cost (MEASURED, never claimed)
- Direct to on-chain, no Foskaay GGI (100 moves + setup): about 0.2444 USDC/game,
  about 4 games/$1. Derived from the measured 0.00212 USDC per move plus about
  0.032 USDC setup (the board port's short-match total was 0.098172). Most games
  run 60 to 100+ moves, so this is the realistic direct cost.
- Storage Foskaay GGI Midchain unbatched: 0.012206 USDC/match, about 81 games/$1.
- Storage Foskaay GGI Midchain batched: about 0.0090 to 0.0098 USDC/match, about 102 to 113
  games/$1 (flat under batching because each game still pays a per-game SSTORE open).
- Event-based Foskaay GGI Midchain unbatched: 0.001712 USDC/match, about 584 games/$1.
- Event-based Foskaay GGI Midchain batched (PER GAME, 3/5/10/100): 0.001098/0.000939/0.000820/0.000713
  USDC per game, about 910/1064/1219/1403 games/$1. This anchors EACH game (N handovers
  + N settles + 2N signatures), so it FLOORS at about 1,400 games/$1.
- Event-based Foskaay GGI Midchain PER SESSION (Tier 3, one handover + one settle carrying a Merkle
  root over N games + 2 signatures): both txs stay FLAT (handover 0.000782, settle
  0.000930) no matter how many games, so per game = 0.001712/N: N=3 = 1,753, N=5 = 2,920,
  N=10 = 5,841, N=100 = **58,411 games/$1**. This is the headline tier. Why per-game
  floors but per-session does not: per-game puts each game's payload + 2 signatures
  on-chain (about 28,000 gas/game irreducible); per-session puts ONE root on-chain.
- Early prototype cost runs (Generals, storage/event-only/event-midchain) were
  removed from `foskaay-ggi/deployments/` on the owner's instruction. Their
  scripts were removed too. The only game cost we track now is the Ludo demo.

---

## 3. CURRENT STATE (updated 2026-09-22)

The owner wants a REAL on-chain game (not a frontend toy) that uses Foskaay GGI,
with real graphics, as the first demo. We are porting MagicBlock's open-source
`solana-generals` game (`github.com/magicblock-labs/solana-generals`).

### The authoritative build spec is IN THE DOCS
`foskaay-ggi-docs/index.html`, section `#demos`, subsections:
- "The model (get this right or everything drifts)"
- "The port, name for name" (MagicBlock concept -> Foskaay GGI equivalent table)
- "The ported game, a-z (this is the build spec)" (step table + copied rules)
**The build follows this spec. If the build must differ, UPDATE THE DOCS FIRST.**

### Key facts from the port study (verified by reading their code)
- Their `Game` component IS the shared board: `status`, `size_x` 16, `size_y` 8,
  `players[2]`, `cells[128]`, `tick_next_slot`, `GameStatus{Generate,Lobby,Playing,
  Finished}`, `GamePlayer{ready,authority,last_action_slot}`, `GameCell{kind,owner,
  strength}`, `GameCellKind{Field,City,Capital,Mountain,Forest}`, `GameCellOwner
  {Player(u8),Nobody}`.
- Their systems: `generate, join, start, command, tick, finish`.
- Their rules (copy exactly): cells must be adjacent; source owned by mover;
  Mountain not walkable; source strength > 1; moved strength is a percent; if the
  target is yours, add strength; else damage it, **Forest halves damage**, conquered
  when damage exceeds strength; tick growth **Capital +1/5s, City +1/10s,
  Field +1/60s**, `TICKS_PER_SECOND = 20`.
- Their client: `@magicblock-labs/bolt-sdk` (contract side) +
  `ephemeral-rollups-sdk` (client). Ours: `@foskaay/ggi-contracts-sdk` + `@foskaay/ggi-sdk`.
- Their frontend assets are open-source and COPYABLE (their graphics: PNGs like
  `GameGridCellCity.png`, `GameGridCellField.png`, `GameGridCellMountain.png`,
  `GameGridCellCapital.png` under `frontend/src/components/game/grid/`). Use them
  so the demo looks like a real game, not dots.

### What is DONE and committed
- Rail: 4 core + 1 optional upgradeable, deployed, proven. Session-to-game link
  (`setGameState`) live on the proxy (`0x5165...1bE5`), data preserved.
- Packages 0.1.4 published with `setGameState`/`gameStateOf`.
- **Docs port spec** (commit `1f0183d`).
- **`GeneralsGame.sol`**: faithful Solidity port of MagicBlock's game as the GAME's
  own contract (NOT core): board storage, `createBoard/generate/join/setReady/
  start/command/tick/finish`, every action gated by `canSign`, `tick` permissionless,
  `boardView` one-call read. Rules copied exactly. Deployed to Arc testnet.
- **PvP demo page** `ggi-demos/pvp/generals/index.html`: MagicBlock's own graphics
  (`public/foskaay-ggi-assets/generals/`), reads the board from chain via the relay
  `gameBoard`, sends moves via the relay `game` action, no localStorage, no player
  gas. Linked from the PvP card on `/foskaay-ggi/demos/`. Vite input added.
- **The Foskaay GGI Midchain finding** recorded in `foskaay-ggi/foskaay-ggi-build-guide-v5.md`
  section 9, the Research library entry `ggi-Foskaay GGI Midchain`, and `arcv2m18`.
- **`GeneralsMidchain.sol`** (pure rules engine, no storage) + `GeneralsMidchain.t.sol`
  (5 tests). Moves run free via `eth_call`, signed with EIP-712 and hash-chained;
  only session open + settle touch the chain. Verifier replay PASS. Measured:
  0.012206 USDC/match unbatched (about 81 games/$1), 0.009788 batched (about 102).
- **`EventMidchainCore.sol`** (the EVENT-BASED Foskaay GGI Midchain, no storage) +
  `EventMidchainCore.t.sol` (5 tests). It is still the Foskaay GGI Midchain (neither fully on
  base nor offchain; event-based, not offchain). The game link is INSIDE the
  `Handover` event, so no separate `setGameState` tx (2 txs per game, not 3), and
  the Foskaay GGI explorer indexes it from `eth_getLogs`. It adds `handoverMany`/
  `settleMany` so MANY games share ONE transaction. Measured per game: unbatched
  0.001712 USDC (about 584 games/$1); batched 3 = 0.001098 (about 910); batched 5 =
  0.000939 (about 1,064); batched 10 = 0.000820 (about 1,219); batched 100 =
  0.000713 (about 1,403). Deployed `0x197DE9813bd8cF668C8C26455329C629EE9Fc63e`.
  (The earlier `EventOnlyCore` at `0xB323...` was the first version, renamed.)
- **148/148 forge tests pass.** Commits: `7c6b967`, `5513e92`, `888faa8`, `b015d15`,
  `44796dc`, `8802b85`, `36d5095` (plus this handoff update).

### The Foskaay GGI Midchain (the key idea, do not lose it)
- On-chain (truth): the session, the start hash and the final hash. Only 2 or 3 txs.
- Foskaay GGI Midchain (free play): every move is a signed, hash-chained message run through the
  game's PURE rules with `eth_call`. Free for the player AND the sponsor.
- Off-chain (render only): the frontend draws; Vercel holds the sponsor key to send
  the open and settle. Neither owns the truth.
- EVM tech Arc gives us (Osaka baseline): `eth_call` free execution, EIP-712,
  keccak hash chain, events over storage (`eth_getLogs`), EIP-1153, EIP-7702,
  deterministic finality. EIP-4844 blobs are NOT supported on Arc.

### WHERE THE FILES ARE NOW (verified on disk)
- Game (on-chain board): `foskaay-ggi/demos/pvp/generals/GeneralsGame.sol`
- Game (Foskaay GGI Midchain pure rules): `foskaay-ggi/demos/pvp/generals/GeneralsMidchain.sol`
- Event-based Foskaay GGI Midchain prototype: `foskaay-ggi/prototypes/EventMidchainCore.sol`
- Tests (Foundry has ONE test path, so tests live in `test/`):
  `test/GeneralsGame.t.sol`, `test/GeneralsMidchain.t.sol`, `test/EventMidchainCore.t.sol`
- Demo page: `ggi-demos/pvp/generals/index.html`; graphics in
  `public/foskaay-ggi-assets/generals/`; Vite input `foskaay-ggi-demos-pvp-generals`.
- Scripts: `scripts/foskaay-ggi-deploy-generals.mjs`, `foskaay-ggi-generals-match.mjs`,
  `foskaay-ggi-deploy-Foskaay GGI Midchain.mjs`, `foskaay-ggi-midchain-match.mjs`, `foskaay-ggi-deploy-eventmidchain.mjs`,
  `foskaay-ggi-eventmidchain-match.mjs`, `foskaay-ggi-eventmidchain-batch.mjs`.
- Owner rule: **no `examples/` folder.** Games live under their genre
  (`demos/<genre>/`); rail prototypes live in `foskaay-ggi/prototypes/`.

### IMMEDIATE NEXT STEPS (in order)
1. **DONE (owner-approved 2026-09-23):** event-based Foskaay GGI Midchain added to the CORE by a
   UUPS logic upgrade (SessionRegistry proxy SAME address `0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5`,
   new implementation `0x05D492C0Cc4e890131c163b302Ab20B56542D2B2`). Additive only (no
   storage change, no migration); data verified identical. No nullifier. SDK helpers
   added, versions bumped to 0.1.5. 155/155 forge tests pass.
2. **REMAINING:** regenerate the SDK browser bundle (`packages/sdk/dist/ggi-sdk.browser.js`)
   and republish `@foskaay/ggi-contracts-sdk` then `@foskaay/ggi-sdk` 0.1.5 (needs the npm
   token; ask the owner first). Then update the docs page.
3. **Wire the Foskaay GGI Midchain into the SDK + frontend** so the demo page plays the free
   Foskaay GGI Midchain (Tier 2 or Tier 3) instead of the per-move board. Frontend reads only.
4. **Put the three-tier pitch** in the Foskaay GGI folder and the docs page (owner will
   approve placement after the clarity). Tier 3 (per-session, 58,000+ games/$1) leads.
5. Keep `architecture.json` `arcv2m18`, the Research entry, and this handoff in sync.

### THE LINK / EXPLORER ANSWER (why the event-based Foskaay GGI Midchain is fully provable)
- Storage-based core: the session lives in `SessionRegistry` storage, so tying the
  game to the session needed a separate `setGameState` tx (3 txs per game).
- Event-based Foskaay GGI Midchain: the `Handover` event carries `sessionId`, `gameLogic`,
  `startHash`, `players`, `sessionKeys`. The link is IN the event, same tx (2 txs).
  The Foskaay GGI explorer reads `Handover` + `Settled` via `eth_getLogs`, replays the
  signed move log through the game's pure rules, checks it hashes to the on-chain
  final hash and that each signature recovers to the declared player. So the
  Foskaay GGI Midchain is tamper-proof, tied to the on-chain, and provable by anyone. In a
  batch, each game still emits its OWN events inside the batch tx, so the explorer
  shows every game individually.

### OUTSTANDING / UNTRACKED
- `foskaay-ggi/foskaay-ggi-build-guide-v5.md` (now committed per owner 2026-09-22).
- `docs/foskaay-ggi-session-handoff.md` (this file).

---

## 4. THE OUTSIDER TEST METHOD (how we find real bugs)

Build each demo as an EXTERNAL dev would: from the published SDK docs alone, no
knowledge of the contracts. Every time this found real blind spots:
- missing `setAuthority` -> sessions could never settle (fixed in the relay);
- no browser bundle -> the SDK had no way to run in a browser (fixed: shipped);
- demo scripts not in `public/` -> 404 on the built site (fixed by serving from
  `public/` or declaring Vite inputs).

Keep doing this. Fix the blind spot in the SDK or docs, do not paper over it in
the demo.

---

## 5. GOTCHAS LEARNED (do not repeat)

- **Vite only serves files in `public/` or declared inputs.** A `<script src>` to
  a source folder 404s on the built site.
- **No git submodules.** Vercel clones them and it silently broke production.
  OpenZeppelin is VENDORED at `foskaay-ggi/lib/vendored-openzeppelin/`
  (exact 12-file closure), remapping in `foundry.toml`.
- **`test = [...]` array form may not be supported by the Foundry version here.**
  Verify with `forge test` before relying on it.
- **Forge script writes the private key into `broadcast/`+`cache/`.** Gitignored,
  but scrub locally.
- **npm propagation delay:** a fresh publish can 404 for minutes. Poll the
  registry before concluding failure; do not re-publish blindly.
- **Always `git fetch origin` before comparing to main.**

---

## 6. QUICK COMMANDS

```bash
export PATH="$HOME/.foundry/bin:$PATH"        # foundry not on PATH
cd /home/foskaay/globalfolkgames/foskaay-ggi && forge test   # 148 passing expected
cd /home/foskaay/globalfolkgames && npm run build            # must be green
node scripts/foskaay-ggi-midchain-match.mjs unbatched                # storage Foskaay GGI Midchain, needs local relay
node scripts/foskaay-ggi-eventmidchain-match.mjs                     # event-based Foskaay GGI Midchain, uses local key
node scripts/foskaay-ggi-eventmidchain-batch.mjs                     # event-based Foskaay GGI Midchain batched 3/5/10/100
node scripts/foskaay-ggi-cost-measure.mjs            # re-measure Arc cost
node scripts/gi-deploy-arc.mjs               # deploy core proxies (uses local key)
```

## 7. ON START OF A NEW SESSION
1. `git fetch origin && git log --oneline -5 origin/main && git status`.
2. Read this file, `AGENTS.md`, and `architecture.json` module `arcv2m18`.
3. Output the FULL nested todo list (`.opencode/rules/todo-status.md`) before work.
4. Never touch `main`; commit + push to `osv1Arc`; the owner PRs.

## 8. WHEN THE OWNER ASKS TO START A NEW SESSION (HARD RULE)
Before the session ends, the agent MUST **update this file to match the current
state**: what is done and committed, where the files are now, the current task, the
immediate next steps, the measured numbers, and any pending owner decision. Then
commit + push it to `osv1Arc`. A new session must be able to read only this file
plus `AGENTS.md` and know exactly where the project stands and what to do next.
