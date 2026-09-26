# GlobalFolkGames — Architecture 2.0 (FINAL DRAFT for review — NOT built yet)

Scope: a gasless, **fully on-chain**, people-to-people native-game arena. Earn = P2P / P2C / Leverage only. No "earn competitions", no local/international split, no subsidized pools. The existing M1-M11 architecture (shipped modules, seams, universal folders, identity = GFG handle) is preserved and is the foundation; v2 rebuilds the M1 game core around multiplayer + matched play, and layers the earn rails on the same seams.

## 0. Principles (non-negotiable)
1. **Everything that is money/trust lives on-chain.** Pools, locks, boards, winners, fees, payouts, margin, stop-losses. There is no hidden off-chain state that affects value.
2. **Gasless for the player.** They never sign per action or feel fees. The embedded Dynamic wallet silently signs; the ER does the execution.
3. **About the "relay" (honest answer to your question):** a server-side *signer* is unavoidable in every system, because a private key must live somewhere and 'watching' an inbox/settling at a trigger is off-chain automation. What we guarantee: the relay **never holds or controls value**; every action it takes is a signed on-chain transaction anyone can verify (payments, credits, escrow releases, payouts). Its only authority is what the program's rules give it (admin/creator gates), and the contract's on-chain state is the single source of truth. There is no off-chain ledger, balance, or hidden rule.
4. **Base layer only where required**: funding a match/pool, withdrawing to a wallet, one-time initialize/delegate. Everything else ER (gasless).
5. No token, no resellable NFT, no VC. Early-backer contributions are escrowed on-chain with time-based profit-share claims (see §7).

## 1. M1 v2 — Game core with multiplayer
- Rebuild M1 around **multiplayer** while keeping the M2 result seam: every game emits `publishGameResult` exactly as today.
- **The GAME IS STANDALONE — AGM never changes gameplay.** All game features (multiplayer, match codes, turn clocks, timers, forfeit, replay, points seam) live INSIDE the game and work with zero money. AGM is a game-agnostic money/escrow/betting plug that DRAPS ON TOP later: same game, same logic, same features, whether you play friends for free or play with earn. A player trains on exactly what they will bet on.
- Modes (per game), all in the ONE game build:
  - **Solo** (you vs computer/human seats, free, points only) — today's ludo-lab, unchanged.
  - **Multiplayer** (abbreviated 2mp, 3mp, 4mp... = number of HUMAN wallets in the match): played via **match codes** (2 real players share a code, no lobby/AGM needed). Free to play with friends right now; the SAME match can later carry earn when AGM is plugged on. Computers may fill empty seats when P2C is allowed (player can reject).
  - **Earn fills** (later, only when AGM is attached): AGM matches orders; if not enough humans accept within the window, remaining seats get a labelled (Computer) seat when P2C-allowed.
- **On-chain board/move state runs GASLESS on the ER** (MagicBlock ER, same proven pattern as MagicBlock's own multiplayer game solana-generals): create the match PDA on chain once → delegate it to the ER once (sponsor ~0.0003 SOL) → every player's move is a GASLESS ER transaction signed by their session key → all players listen to the delegated board on the ER for updates → finish commits the result → later undelegate when settling. Move-hashes committed per turn; earn/checkpoint full snapshots ER-permitting. NO per-move base-layer writes.
- Turn clocks + match time caps are part of the GAME (enforced in the game + program/service). §3 shows the current caps.
- Identity = GFG handle (never name/email/wallet).

## 2. Earn engines (2-in-1, CEX bank + DEX community)
- **P2C (platform computer, CEX-like "bank"):** the platform funds a pool of computer seats so matches always have a counterpart. Opponents are always labelled `(Computer)` vs `(Human)` with skill band; players accept/reject. Platform publishes the reward formula and takes its fee from the finished pool.
- **P2P (player vs player):** the **Automated Game Matcher (AGM, invented by Solomon Foskaay)** matches open orders. Player posts an order ($1..$1,000 stake), AGM matches a counterpart (2-way; N-way up to 20 for tournaments), both approve (profile/rating visible, reject allowed), escrow locks both stakes, game runs, the published split pays winners. AGM matches only; money is player-to-player.
- **Leverage (prop-style):** player posts collateral; the bank extends X multiples on a declared **stop-loss floor**; auto stop is executed on-chain. Player can only lose their collateral; the platform's exposure is capped by the risk floor and a per-round fee. Phase-2 (needs banker accounting + on-chain stop execution).
- **P2C break-even - CORRECTED, honest answer (owner 2026-08-25):** flat 10% fee on the POT. Two sides stake S each -> pot 2S -> winner gets 1.8S, loser 0. If the platform is the computer side: computer WIN -> +0.8S; computer LOSE -> -S (it loses its full stake). EV per match = S x (1.8w - 1). Break-even when w = 1/1.8 = **55.6%** (a computer must win MORE than half its matches for the bank to break even). If players study and beat a mid computer, the house DOES bleed - exactly the owner's fear, and it is CORRECT.
- **Mitigations that make P2C survivable WITHOUT rigging:**
  1. **P2C is the availability filler, never the profit center.**

  > On-chain (arc2m7c, built): `P2cBank` ONE shared cross-game pool (`[gfgp2cbank]`): capital pool, GMT day bucket, signed day-net, day-loss cap (default $20) that pauses the bank for the day, win/loss/trades counters. `p2c_fund` top-up, `p2c_settle` applies one computer-seat result from a locked settlement exactly once (`AgmSettlement.status` 0->1, additive trailing field on the v1 layout) with the $1-$10 small-stake band enforced on-chain. Net math = computer win `+(payout - stake)`, computer loss `-stake` (2-seat $5: win +$4, loss -$5, EV as spec). Real revenue = P2P fees (zero house exposure - players pay each other, platform takes 10% of the pot). P2C exists so matches always fill.
  2. **Computers only fill seats when no human counterpart is ready**, capped at SMALL stakes ($1-$10) so even a bad day costs little.
  3. **Strong-but-fair computer (~65-70% win band)** for new/small-stake seats - skill, not rigging (no per-hand switching); clearly labelled '(Computer · Strong)'.
  4. **Anti-farm:** a wallet that clearly beats the computer gets steered to P2P/unranked + a rematch cap per wallet/week; the bank pauses for the day on a net-loss cap.
  5. Community liquidity is PHASE-2, only after live data proves bank EV, with the loss-protection floor + caps (§1).
- Fees: FLAT 10% of each finished pot for every earn match, all modes, all games (one number everywhere, printed up front). Premium plans stay as the separate comfort/gas subscription (lives, points, ad-free, booster, bigger daily).

## 3. Match rules / anti-abuse (all earn modes)
- Max match time: **60 min (2p)** / 90 min (3p) / 120 min (4p+), per-game override. (2p raised from 30 min to 60 min so players are never rushed; boards use `max_match_secs` per game.)
- Max turn time per game (e.g., Ludo 60s): idle → the turn passes / auto-moves per game logic; stalling impossible.
- No cancel on loss: once stakes lock, only a rules draw or platform-infra refund ends it.
- Reputation/rating per game, visible to match parties; computers carry a fixed band label.

## 4. Payments & payouts (crypto-first, honest)
- **Solana-first (beta):** pay with the user's embedded Dynamic SOL wallet or any external wallet; **Solana Pay / SPL transfer (USDC/USDT/SOL)** to the sponsor key, with a memo order id. Instant on-chain credit of premium points/upgrade to the **same embedded wallet** the site reads (existing Upgrade flow completes it). Low/near-zero fees, global, no business-registration gate. EVM stablecoins (USDC) later via Dynamic embedded EVM wallet.
- Payouts: on-chain (to the player's embedded/wallet), or escrow release to winners; small amounts batched/credited as points when on-chain transfer economics would eat the value.

## 5. Platform money model (sustainability — earn is NOT subsidized)
- Revenue: match fees (5–20%), Premium plans, competitive entry (S point or S-credit), affiliate 20%, later merch/ads/escrow.
- Earn pools come from players (P2P escrow) or the platform P2C bank's own capital; no grants to keep competitions going.
- Devnet launch: everyone plays free (devnet SOL is free) to prove the pipeline; mainnet funding via early-backer escrow or grants (Solana Foundation / MagicBlock) with fully on-chain accounting.

## 6. On-chain inventory needed (build list, all additive)
- Escrow match vault per game/players (`[gfgms, …]`), order book / AGM state, settlement + fee split.
- P2C bank + risk caps account.
- Turn-clock + match-time commit.
- Leverage margin + on-chain stop (Phase-2).
- Winners → player points/ledger + optional direct USDC payout.
- No changes to existing M3-M11 seeds/layouts.

## 7. Early backer (no token, no resellable NFT)
- $100–$500 contributions toward the ~100 SOL mainnet runway via on-chain escrow; backers get 1–3 years of highest membership + a percentage share of platform revenue over that band, claimable (daily/weekly/monthly) on-chain; distribution ends at the term. Uses the same on-chain accounting/escrow so every income stream is traceable.

## 8. What does NOT change in v2
M1-M11 seams & universal folders, GFG-handle identity, ER-gassless-first, base-layer rules, homepage anti-copy wording, Beta badge, tooling/run-sheet, brand colors, no-token stance; the old earn competition module (M7 launch) is **retired from v2** (superseded by the AGM engines).

## 9. Research to confirm before/while building
- MagicBlock ER: limits on arbitrary read/simple state per tx; whether on-chain board snapshots per turn are affordable vs commit-hash+checkpoint.
- Solana Pay + SPL transfer for payments; memo binding; balances on-chain.
- Token-2022 for USDC/USDT; base-layer settlement for escrow/payoffs.
- AMM/impermanent-loss literature for the P2C bank (already summarized in §2) and on-chain stop mechanics for leverage.

## 10. Open decisions before we build (want your picks)
1. Fee table (default: \$1-\$10=10%, \$10-\$100=7%, \$100+\$1000=5% — confirm or set your own).
2. P2C computer difficulty bands & whether the bank must net-break-even per month.
3. Keep Premium plans separate from match fees (recommendation: yes).
4. Competitive entry: keep S-credit entry or drop to reduce P2P friction.
5. Funding: early-backer escrow vs grants-first vs both.
6. Multiplayer real-time latency target (e.g., cross-turn ≤ 5s) and whether any game ships P2P at launch or solo+P2C first.

Finalize these six and the doc becomes the build guide; we start the M1 v2 rebuild (multiplayer + AGM seams) from there.
---

## M1 v2 MODULE SPEC (APPROVED BY OWNER 2026-08-25 - the build contract)
> Build order locked in this turn: (1) on-chain board + move commit [ITEM D] -> (2) AGM lobby + P2P match lock -> (3) clocks/timeouts -> (4) P2C bank binding -> (5) settle/fee. Flat 10% pot fee. Modes = Solo (free, unchanged) vs Multiplayer (N human wallets, earn-capable); one game build serves both; per-game seat capacity dynamic. Solo/non-earn play must never regress.

### Summary
M1 v2 = the multiplayer native-game core. Every game keeps the existing M2 result seam, but the game core now also supports 3 play modes: **Solo** (vs computer, free, points only), **Multiplayer** (AGM-matched real players; match-code for private games), **P2C** (AGM-matched computer, earn). Deterministic moves are committed on-chain (board snapshot checkpoints + move hashes; full board replay on chain for earn games where affordable, ER permitting). Turn-clock + match-time are enforced. Identity = GFG handle (never name/email/wallet).

### GAME-AGNOSTIC CONTRACT (hard - all games must satisfy this, none may violate)
1. **One board, any game.** The on-chain `MatchBoard` (seed `gfgboard`, `[game u8][match_ref u64]`) is game-agnostic: it stores seats/players/stake/window/checkpoints/finish order, NOT game rules. A new game simply passes its own `game` source_code + registry ruleset; the board never changes.
2. **Reward-neutral by construction.** M1 (game + board + clocks) NEVER computes or credits points/money/fees. It only records FACTS: participants, move-hash checkpoints, turn times, finish order, winner seat. M3/M4/M7/AGM consume those facts via the M2 seam + board reads. No scoring table, no pot math, no fee logic in M1 code. (Current ludo-lab already follows this: seam emit + result-PDA only - keep it.)
3. **Deterministic + hashed moves.** The game commits a 32-byte `move_commit` hash per turn checkpoint (cheap, gasless on ER). For earn games, an affordable full board snapshot is also committed at checkpoints, ER permitting. Gaming the hash is prevented by the game's own determinism rules (same input = same state).
4. **Clocks are per-seat and part of the GAME.** `MatchClock` (seed `gfgclock`, `[game][match_ref]`) runs for SOLO AND MULTIPLAYER alike (anti-stall, so free play already enforces turn time; earn adds nothing new to the game). Solo can skip the clock only if the game chooses not to - the rules are in the game, not tied to money. A player training free sees the same turn timer they'll bet against.
5. **Identity = GFG handle.** The board stores wallets (needed for escrow later), but all player-facing identity and display uses the GFG handle. Never leak name/email/wallet as an identity label to other players.
6. **Hands off to pluggable modules.** When a match ends, M1 publishes the seam envelope (with additive fields below) AND makes the board readable via `matchState(matchRef)`. It does NOT know or care which downstream module consumes: M3 points, M4 ledgers, AGM settle, M7 competition tally - they all read the same facts. AGM simply plugs into the SAME free match (add money/escrow) - it never changes the game.

### expectedInput (what M1 v2 receives)
- FROM M2 SEAM: the normalized `gfg:game-result@1` envelope (seat/actor/position, proof sig, finishedAt) - unchanged, games keep emitting it.
- FROM THE GAME ITSELF (standalone, no AGM needed): match config from the CREATOR player `{ mode, players:[{wallet,handle}], ruleset, clocks: {turnSecs, maxMatchSecs} }` and a **match code** the opponent enters to join. Multiplayer works with the game alone.
- FROM AGM (LATER, optional - only when earn is plugged on): the SAME config plus `poolUsdCents/stake`, `escrowRef`. Earn only starts when escrow (AGM) confirms funds are locked. The game does not notice the difference.
- FROM M5 (plans): allowed-tier gate for earn modes (mirror of competition tier gating) - only in earn matches.
- FROM GAME RUNTIME: per-turn state checkpoints `{ matchRef, turn, hash }` the game posts to the on-chain board (gasless on the ER).

### expectedOutput (what M1 v2 exposes)
- `publishGameResult` completes as today PLUS additive fields: `mode`, `players[]` (handle + wallet), `stake/PoolUsdCents` (0 when free), `escrowRef` (null when free) so M3 (local points), M4 (global), and the earn engines can consume without reading game internals. Free multiplayer emits the same envelope with stake 0.
- On-chain board records per match: participants, committed move checkpoints, turn times, final result → readable by M3/M4/AGM/escrow for rewards, fees and dispute checks. Written gasless on the ER; all players listen to the delegated board for updates.
- A `matchState(matchRef)` API (relay) returning participants/rules/timers so the AGM + escrow lock and settle deterministically (later).

### CURRENT STATE vs BUILD LIST (verified 2026-08-28)
**What already exists (live, working, deployed):**
- `MatchBoard` account + instructions `start_match` / `begin_match` / `commit_move` / `finish_match` (seeds `gfgboard`, MAX_MP=8). Smoke-tested on devnet (arc2m1a). **NOT yet wired into any game.**
- `MatchClock` account + instructions `start_match_clocks` / `touch_seat_clock` / `timeout_seat` / `finish_forfeit` (seed `gfgclock`). Smoke-tested (arc2m1b). **NOT yet wired into any game.**
- ludo-lab gameplay is LOCAL and complete: **ER VRF** dice (gasless), move/movement/capture/AI, persistence, win ceremony, M2 seam emit (`publishGameResult`), Scope C result-PDA commit. Plays Solo today (You vs computers).
- `source_code` map: 1=ludo, 2=ayo_olopon (registry.json is the games catalog; rulesets per game live there or in a config module, config-first).

**Remaining M1 slices (strict build order). The board + clock INSTRUCTIONS stay M1 (arc2m1a/arc2m1b/arc2m1c/arc2m1e/arc2m1g/arc2m1h below). The STANDALONE MULTIPLAYER RAIL they feed is its OWN module M12 (slices arc2m12a..) - NEVER call it M1/G0/G1.**
- [x] **arc2m1c. Board ER onboarding:** `delegate_board` + `undelegate_board` instructions (the board PDA had NO delegation) + relay `ensureBoardDelegated(game, matchRef)` (idempotent, sponsor) + region-agnostic `boardRegionUrl` (`getDelegationStatus -> fqdn`). DONE: program + IDL compile, relay parses. Feeds M12.
- [ ] **arc2m1e. `matchState(matchRef)` relay API:** returns participants/rules/timers/finish order for any match from chain. Needed by M12 (listen) and AGM/escrow later.
- [ ] **arc2m1f. Clock wiring (part of the GAME, all modes):** multiplayer starts clocks; forfeit path closes stalled matches; turn timer visible to players. Verify against a stalling seat. Feeds M12.
- [ ] **arc2m1g. Seam additive fields:** game emits `mode`, `players[].handle+wallet`, `poolUsdCents/stake` (0 when free), `escrowRef` (null when free) when present (additive; old consumers unaffected). Verify M3/M4 still fire.
- [ ] **arc2m1h. Rulesets registry (config-first):** per-game `{ gameId, source_code, seatsCap, defaultTurnSecs, defaultMaxMatchSecs, earnAllowed, p2cAllowed }` in a config module (like plans-config). Board reads turn/match caps from here, not from hardcoded game code.

---

## M12 — Standalone MULTIPLAYER (game-agnostic rail; FREE, no AGM)

Turn a single-player game into 2-human multiplayer that works with ZERO money
and NO AGM. Players train on exactly what they will bet on later: AGM is a
separate money/escrow plug that attaches the SAME match later, the game never
changes. This is its OWN module (not inside M1) so every future game reuses it.

**Module home:** `public/universal/multiplayer/` (README + multiplayer.js rail).

**Slices (M12 own alphabet a,b,c...):**
- [x] **arc2m12a. Rail core (built, live-verified 2026-08-29 + AGM-decouple 2026-08-31):** `public/universal/multiplayer/multiplayer.js` - match create (→ on-chain MatchBoard PDA via the AGM-FREE `/api/multiplayer` relay, stake 0 free), opponent join (match code), host `begin` (locks the match, no more joins), per-player gasless move-commit on the ER, `subscribe(matchRef, onUpdate)` LISTEN loop (poll board on ER like solana-generals `subscribeToEphemAccountInfo`), `finish`, `state`. Soft-fail; never breaks the game. Server: `scripts/multiplayer-relay.mjs` + `api_handlers/multiplayer.mjs` (`create/begin/join/commit/state/finish`). NOT built on the removed AGM.
- [x] **arc2m12b. Ludo adapter (reference, built):** `games/ludo-lab/mechanics/state/multiplayer-adapter.js` - `encodeMove`/`applyOpponent`/`currentSeat`/`isFinished`/`begin` (host-only) on top of the rail; hooks the game's existing turn + finish seams. Other games copy this shape.
- [x] **arc2m12c. Match codes + join UX (partially wired):** ludo-lab gained the **SinglePlayer | MultiPlayer** tab: SinglePlayer = existing 2P/4P + seat picker unchanged; MultiPlayer = create (shares a code) / join (enter code), same seat display; host starting the match calls `begin` → the game's existing `setupConfigurationLocked` locks the tab/panel/seats and the rail refuses new joins mid-match. Remaining: per-seat sitewide handle display in the lobby (GFG-XXXXXX, never email/wallet) and a ready/start gate.
- [ ] **arc2m12d. Earn-ready seam:** the finish emits `publishGameResult` as today with stake 0 / escrowRef null when free (additive) and `players[]` carrying each live human's wallet (`identity`) + public handle, so M3/M4 consume identically. Seam already accepts per-seat identity/handle (additive), M3 banks each device's own user seat. Remaining: confirm multi-device finish emits the envelope with all live players.
- Verify (arc2m12a+b+c): two devices play a full FREE match with a match code; board updates in real time on the ER; every move committed gasless; Solo unchanged. AGM later just adds stake/escrow.

**Hard constraints while building (do not regress):**
- Every board/clock write is gasless on the ER (delegate the PDA once, then write via ER RPC). Never `sendMagicTx` on base for feature writes.
- Program upgrades are additive + upgrade-safe (new seeds/instructions, never mutate live layouts; preserve data). Same program id `CH8Jep…`.
- Keep account payloads small (SVM 4KB stack-frame cap - the `[u64; 512]` lesson).
- Solo/free play and existing M3/M4/Scope-C result wiring must keep working with zero changes.
- When in doubt about an on-chain capability (deposit/withdraw/VRF/commit), check MagicBlock ER docs first, then confirm the plan - never assume base-layer works for it.

### Dependencies/order
Build M1 v2 in this order: (1) on-chain board + move commit instruction; (2) AGM lobby + P2P match lock; (3) clocks/timeouts; (4) P2C bank binding; (5) settle/fee. Solo/non-earn play keeps working with zero changes (existing seams). Remaining M1 work now: arc2m1c (done) → arc2m1d → arc2m1e → arc2m1f → arc2m1g → arc2m1h → arc2m1i.

---

## M6 v2 AFFILIATE (automated instant payout — owner 2026-08-25)
- Replace the manual monthly settle with an **atomic on-chain split at payment time**: when a paying upgrade/subscription/booster purchase finalizes, the program credits **80% to the platform wallet** and **20% to the referrer's embedded wallet instantly** (premium points/ledger), all in one transaction. No manual worker, no monthly batch, no admin payout step.
- Referral pairs are already recorded on-chain at signup (affiliate module present, M6). Only the payment seat for the referred first-paid purchase triggers the split; subsequent paying months keep splitting the same way (they are still "this purchase pays the referrer").
- If no referrer: 100% to the platform wallet. Non-refundable policy stays and is shown.
- Fees journey: pay → split (80 platform / 20 referrer) → buyer's premium points credited (existing 5,000/10,000/500P flow) → Upgrade page completes activation.

---

## Arc 2.0 MODULE MAP & SLICE NAMING (LOCKED — owner 2026-08-25)
> RULE: each module numbers its OWN slices starting at 'a' (arc2m1a, arc2m1b, ...; arc2m7a, arc2m7b, ...). A module never continues another module's letters. Builds can hop modules in any order that fits (arc2m1a -> arc2m7a -> arc2m7b -> arc2m1b) but the per-module alphabet is always clear.
Slice labels are always `arc2m<N><slice>` so it is ALWAYS obvious which module a build belongs to.

| Slice | Module (v2) | Owns |
|---|---|---|
| arc2m1a ✅ | M1 Game core | multiplayer Solo/Multiplayer, on-chain board + move commit, per-game rules profiles (registry) |
| arc2m1b ✅ | M1 Game core | per-game timeouts: per-seat clocks, timeout->forfeit, finish_forfeit |
| arc2m1c ✅ | M1 Game core | board ER onboarding: delegate_board/undelegate_board (gasless board writes) + region-agnostic relay |
| arc2m7a ✅ | M7 AGM (Matchmaker & Escrow) | standalone game-agnostic order book: post/cancel/match |
| arc2m7b ✅ | M7 AGM | escrow lock + settle (flat 10% pot fee: winner 90%, house 10%) |
| arc2m7c ✅ | M7 AGM | P2C computer bank + anti-farm caps |
| arc2m12a ⏳ | M12 Multiplayer (STANDALONE) | game-agnostic multiplayer rail: match codes, gasless ER moves, listen loop, finish |
| arc2m12b ⏳ | M12 Multiplayer | Ludo adapter (reference for all games) |
| arc2m12c ⏳ | M12 Multiplayer | match code + join UX |
| arc2m12d ⏳ | M12 Multiplayer | earn-ready seam (stake 0 free / escrowRef null; AGM plugs on later) |
| arc2m1b ✅ | M1 Game core | per-game timeouts: per-seat clocks, timeout->forfeit, finish_forfeit |

> **arc2m7c (built, deployed, smoke PASS):** `P2cBank` account per game ([gfgp2c, game]): capital pool, GMT day bucket, signed day-net, day-loss cap (default $20) pauses the bank for the day, win/loss/trades counters. `p2c_fund` top-up (init_fresh seeds real defaults on a zeroed bank), `p2c_settle` applies one computer-seat result from a locked settlement exactly once (AgmSettlement.status 0->1) with the $1-$10 small-stake band enforced on-chain. Net math = computer win `+(payout - stake)`, computer loss `-stake` (2-seat $5: win +$4, loss -$5, EV as spec). Smoke: fund $1000, lose $5, win $4 -> dayNet -$1, trades 2, bank open.

> **arc2m1b (built, deployed, smoke PASS):** `MatchClock` account per match ([gfgclock, game, match_ref]) keeps the board game-agnostic: per-seat deadlines snapshotted from the board's turn_secs. `start_match_clocks` inits (only this may create - an empty clock cannot forfeit), `touch_seat_clock` resets a seat's deadline after a legal move, `timeout_seat` is permissionless anti-stall (records a stall, resets the window, at timeout_cap=3 marks the seat FORFEITED), `finish_forfeit` lets a healthy seat finalize the board when another seat forfeited (the forfeited seat can never claim the win). Solo boards never create a clock, so the free path is untouched.

M7 keeps the existing v1 modules untouched: M2 seam, M3/M4 points, M5 plans, M6 affiliate (now auto 20/80), M10 lives/daily, M11 community. Good the old earn-competition M7 is RETIRED; the slot reopens as the AGM module.

### M7 (AGM) expectedInput / expectedOutput
- **expectedInput:** gameId chosen by the maker (from the games registry), order stake, seats; a matched `taker` signer; a board (M1) `match_ref` when locked; `registry rules[gameId]` for seats/turn/match caps; M2 result envelope at finish.
- **expectedOutput:** on-chain order lifecycle (open/matched/locked/cancelled); escrow lock; settle outputs `potUsdCents`, `feeUsdCents` (10%), `winnerSeat`, `payoutUsdCents` (90%); game-agnostic - any game plugs in by picking a gameId from the registry.

> **Arc 2.0 AGM live state (2026-08-28):** posting is verified live end-to-end again (order id = unix-ms timestamp, so no cross-instance collisions; server-side USDC guard blocks posting beyond the wallet balance; settle writes status 4 = SETTLED so the Orders UI shows Open/Locked/Settled as three honest states). Order DISCOVERY on the live site is a light relay id-index + the device's own posted ids (browser localStorage) merged, and every listed order is re-read on-chain via readOrder (status/maker/stake/seats/taker are never cached). The on-chain `AgmOrderIndex` ring account idea was TRIED and ROLLED BACK because an `[u64; 512]` field exceeded Solana's 4KB stack frame (compiler: "Stack offset of 4104 exceeded max offset of 4096"), which crashed the program at runtime ("Overlapping copy"). A future cross-user order book must use a space-safe design (e.g. a compact `[u64; N]` with N<=~400, or a per-game index, or an append log) - never a large stack array.
> **Deploy path (LOCKED):** program upgrades go through the MagicBlock region/router RPC, NOT base Solana devnet. Alchemy (`GFG_DEVNET_RPC`) is only the fast public devnet RPC for embedded-wallet SPL balance reads and as the public-RPC fallback - never a deploy target, never a game-state RPC. See AGENTS.md "Where the program & data live".

Build policy: any capability that is shared across games (matchmaking, escrow, fees, identity, payments) lives in a UNIVERSAL module (M7 AGM here), never inside a game. If a slice doesn't fit its module's inputs/outputs, the ARCHITECTURE changes first, then the build follows (never the reverse).

### HOW IT WORKS IN PLAIN WORDS (read this first, then the technical deltas above)

Think of the earn arena like a small bank with a betting window. This is the whole arc in one story, using the REAL numbers our devnet tests produced.

**1. Posting an order (arc2m7a).** You "write a ticket": your game (Ludo), your stake ($5), and how many seats. The ticket is stored on Solana, not on our server. Test result: a ticket gets an owner line, a stake line, a seat count, and a status line that starts at "open".

**2. Matching (arc2m7a).** Another player (or the computer bank) says "I take this ticket". Now both sides are locked in at $5 each. Test result: the same wallet CANNOT take its own ticket, the taker must be a different wallet.

**3. Lock + settle (arc2m7b).** When the match finishes, the pot is split:
- Pot = stake x seats. Two humans at $5 each = a $10 pot.
- House fee = 10% of the pot = $1.
- Winner gets the rest = $9 (90% of the pot).
Real test numbers on-chain: pot $10, fee $1, payout $9, winner seat 0. One number for every game, everywhere, so players always see the same math.

**4. The computer bank (arc2m7c).** To make sure matches always fill, the platform keeps a computer ("the bank") that takes empty seats, but only on small stakes ($1-$10) and with guard rails. Real test on devnet: we put $1000 in the bank, the computer lost a $5 seat (-$5) then won a $5 seat (+$4, because the winning computer gets its $9 payout minus the $5 it staked). Net for the day: a $1 loss on 2 trades. If the bank ever loses $20 or more in one GMT day it stops taking seats until the day turns over. That is the anti-meltdown switch.

**5. Turn clocks (arc2m1b).** Every seat gets a timer so nobody can stall a match forever. Real test: a seat with a 2-second turn stopped moving, got 3 timeout strikes, and was FORFEITED. Its attempt to claim the win was rejected, and the healthy seat finished and won. Solo play never uses these clocks, so free casual games stay exactly as they are today.

**6. The board (arc2m1a).** Moves are committed on-chain as hashes, so the whole match can be replayed and proven. The board knows money and seats; the game decides the rules. This is why a future game (Truco, Ayo Olopon) plugs in by picking a gameId, not by being rewritten.

In short: tickets (orders) -> match -> play on a provable board with timers -> lock the pot -> cut the 10% fee -> pay the 90% winner. Every step is on Solana, gasless for the player, and testable on devnet before any real money is involved.
