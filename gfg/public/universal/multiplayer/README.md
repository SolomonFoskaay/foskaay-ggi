# M1 arc2m1d — Multiplayer RAIL (standalone, game-agnostic)

A free multiplayer match with friends that is the EXACT same game an earn
match uses later. AGM is a separate money/escrow plug that attaches on top;
this rail never knows about money.

## Why a whole module (not per-game)

The multiplayer plumbing is identical for every game: create + delegate a
match, commit each player's move gasless on the ER, listen for opponent moves,
enforce turn clocks + forfeit, finish and emit the seam. It never interprets a
move, so Ludo, Ayo Olopon or Truco all reuse the SAME rail. Each game only
supplies a small ADAPTER (what a move means in that game).

This is the same pattern as the result seam (50 games -> one `publishGameResult`).

## Contract (this folder is the canonical home)

- On-chain match PDA: seed `[gfgboard, game u8, match_ref u64]`, one account
  per free/earn match. Holds participants, move-hash checkpoints, turn times,
  finish order - nothing game-specific.
- Create + delegate: first use creates the board PDA (sponsor signs), then
  `delegate_board` moves it into an ER session ONCE (sponsor ~0.0003 SOL).
  After that, every write is a GASLESS ER transaction signed by the acting
  player's session key.
- Moves: `commit_move(game, match_ref, seat, move_commit[32])` records a hash
  checkpoint on the board (gasless on ER). The full move payload is the
  game's job - the rail only stores the proof hash + count.
- Listen: all players subscribe to the delegated board account on the ER (the
  same `subscribeToEphemAccountInfo`-style polling MagicBlock's own
  solana-generals game uses) and re-render when `move_count`/`last_move_commit`
  changes. Real-time, cross-player, free.
- Clocks/forfeit: `MatchClock` per match (seed `[gfgclock, game, match_ref]`)
  with per-seat turn deadlines; a seat that stalls past its window accrues
  timeouts and is FORFEITED. Same clocks in free and earn - the game enforces
  what players will later bet on.
- Finish: `finish_match` writes the winner seat + positions. The M2 seam
  (`publishGameResult`) is emitted as today with `stake=0` when free. M3/M4
  consume identically regardless of free or earn.
- Match codes: the rail returns a short code for a created match; an opponent
  joins by entering it. No lobby, no AGM required.
- API exposed:
  ```
  window.gfgMultiplayer = {
    create({ gameId, players[], seats, turnSecs, maxMatchSecs }) -> { okay, code, matchRef, pda }
    join(gameId, code) -> { okay, matchRef, pda }
    commitMove({ gameId, matchRef, seat }, moveHash[32]) -> Promise<{okay, sig}>
    subscribe(matchRef, onUpdate)  // re-renders on board change
    finish({ gameId, matchRef, winnerSeat }) -> Promise<{okay, sig}>
    state(matchRef) -> board facts (participants, moves, clock, winner)
  }
  ```
- Per-game ADAPTER (inside the game, tiny):
  ```
  window.gfgMultiplayerAdapter(gameId) = {
    encodeMove(state) -> moveHash[32],   // hash this game's move decision
    applyOpponent(moveHash) -> void,      // game rerenders after opponent move
    currentSeat() -> seatIndex,           // whose turn it is
    isFinished() -> winnerSeat|null,
  }
  ```
  The Ludo adapter is the reference; other games follow it.

- DELEGATION + WRITES ARE ER-FIRST: same proven lifecycle as dice/points/result
  (create once -> delegate once -> gasless writes on the ER region via
  `getDelegationStatus -> fqdn` targeting). NEVER base-layer per-move writes.

## Status

`in-progress` (architecture.json is the source of truth). M1 arc2m1d. The rail
is game-agnostic; ludo-lab is the first game to plug its adapter in. Solo play
is untouched (it can choose to opt out of the rail entirely).