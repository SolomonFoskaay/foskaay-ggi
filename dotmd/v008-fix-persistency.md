# v008 — Multiplayer persistency: the free room must remember (Foskaay GGI Midchain)

## A. The problem (found on live testnet, 2026-09-29)

1. A live multiplayer match vanishes when the relay forgets it. Moves lived
   only in relay server memory, so a restart (or a second server copy that
   never saw the lobby) loses mid-game boards, and joining across phones fails
   with "lobby not found" even with the host page open.
2. Joining needed hand-copying wallets and keys, settling needed every seat's
   hand-pasted signature (a losing player simply walks away), the timer lived
   only on the page, and buttons gave no feedback.
3. The owner corrected the direction twice: there IS a free room (the Foskaay
   GGI midchain, the MagicBlock ER equivalent), game state must live in it and
   be called through the session (never by direct contract calls, which are
   paid Arc transactions), and no web2 store may become the source of truth.

## B. The analysis (how GFG multiplayer does it, in code)

GFG persists because its free room is a real place: every `commit_move`
writes the full board snapshot (`last_move_commit`), `move_count`,
`current_turn` and the turn deadline onto the delegated board PDA, gasless on
the ER (`gfg/programs/programs/gfg-dice/src/lib.rs`, `commit_move`,
`expire_turn`, `finish_match`). Every phone polls that same board
(`public/universal/multiplayer/multiplayer.js`, `subscribe`), derives the turn
from the same committed bytes (the ludo-lab adapter replays the snapshot, and
`resume` finds the caller seat from the on-chain players list). Joining is one
signed tap that lands the wallet in a free seat; finishing needs any one seat
holder, and the finish propagates so no device waits on a loser. The clock is
program-owned (`turn_secs` enforced on-chain, never client-decided).

The Arc mirror, per `dotmd/foskaay-ggi-recordlive-room-fix-agent.md`
(Section Two): Foskaay GGI has exactly ONE chain and NO sidechain, so the free
room memory is the signed move log, one entry per move
(`prevHash -> newHash` plus the 36 board bytes the contract itself produced,
seat, kind, timestamp, signature), namespaced by sessionId and anchored by the
Handover (start hash, seed commitment, participants) and the Settle (final
hash). Reads via `eth_call` are always free; only state-changing transactions
cost. Calling the game proxy directly with a state change is a paid Arc
transaction (the removed `recordLive` mistake); the audit stays permanent: the
Arc signer appears only in handover plus settle paths, move count is
unbounded, transactions per session stay two (open plus close).

What was already fixed before this file: lobby plus one-tap join, host begins
(manual, never automatic), winner-alone auto-settle, contract-owned timer
(`turnSecs`/`maxMatchSecs`, `isTurnExpired`, settle verifies timestamps),
seat-gated moves, permissionless but contract-gated timeout-advance, human
error messages, short callable codes plus copy link plus URL sync, solo
computer seats that earn nothing, compact screen with one message line.

## C. Persistency fix (built on approval, confirm here after live test)

1. Session log as room memory: entries
   `{sessionId, idx, prevHash, newHash, board, seat, kind, ts, sig}`.
2. Each phone keeps the verified entries it has seen, on its own device, and
   re-verifies them on load before drawing. The copy is a cache, never truth:
   truth stays signatures plus chain.
3. Relay merge endpoint (`mpResync`): after a restart any device re-submits
   the witnessed log plus the public session envelope; the relay verifies
   chain continuity from the recomputed start hash, every signature against
   the committed keys (or the sponsor for house seats), the seed commitment,
   and for begun sessions the core commitment hash itself, then rebuilds and
   continues. The relay stays an untrusted carrier.
4. No database, no new vendor, no new transaction, single-player untouched.

### Confirmation (owner fills after testing)

- [ ] Mid-game refresh on one phone reconstructs the exact board, turn and
      countdown with zero new transactions.
- [ ] Second phone joins by link tap and plays, no copying by hand.
- [ ] Relay-side loss recovers through device re-submit plus merge.
- [ ] Winner finishes alone; loser phone shows the sealed result.
- [ ] Stalled seat times out by the contract clock on both phones.
