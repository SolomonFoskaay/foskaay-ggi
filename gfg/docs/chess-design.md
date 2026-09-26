# Chess on-chain design (Phase 0)

Status: DRAFT for owner review. No code is written until this is approved.
Owner-locked decisions this doc implements: the locked Chess spec in
`architecture.json` (M1 game sub-module `chess`, 23 bullets) plus the three
approved amendments (permissionless clock, single program, build phases).

## 1. Scope and constraints

- Fully on-chain for BOTH modes: the board, all legality, the history, the
  clocks, and the computer opponent live in the program. The browser only
  displays and sends intended moves.
- One program: the existing gfg program (`CH8Jep...`), instructions added
  additively. Chess code lives in its own Rust module file inside the same
  crate (`programs/programs/gfg-dice/src/chess.rs`). One deploy, one IDL.
- No new program, no crank required, no new external dependency.
- No live Ludo seed or layout changes. New seed prefix only.
- Gasless: onboarding (create + delegate) is sponsor-paid once per match;
  every move runs on the ER signed by the player's session key at 0 SOL.
- Lives gate enforced on-chain for entering (create and join), reusing
  `[gfglives, player]`.

## 2. Seeds and PDAs

- `CHESS_MATCH_SEED = b"gfgchess"` -> board PDA `[CHESS_MATCH_SEED, match_ref_le]`.
  One PDA per match, seeds never change once shipped.
- Lives PDA (existing): `[b"gfglives", player]`.
- No new per-player PDA is required for chess (the player's dice/points/lives
  already exist). If a per-player chess PDA is later added, it must ship its own
  `undelegate_*` (region-agnostic rule).
- Only the board PDA is delegated to the ER.

## 3. Account layout: `ChessBoard` (versioned, `version: u8` first)

Proposed fields and sizes (total about 2.6 KB, well under the 10 MiB max):

- `version: u8` (start at 1)
- `game: u8` (chess tag)
- `status: u8` (0 lobby, 1 in progress, 2 finished)
- `seat_count: u8` (2)
- `result: u8` (255 none, 0 white wins, 1 black wins, 2 draw)
- `end_reason: u8` (0 none, 1 checkmate, 2 resignation, 3 timeout,
  4 stalemate, 5 threefold, 6 fifty-move, 7 insufficient material, 8 agreement)
- `side_to_move: u8` (0 white, 1 black)
- `castling: u8` (bitmask KQkq)
- `ep_square: u8` (0..63 or 255 none)
- `check_flag: u8` (1 if the side to move is in check, for display)
- `seats: [Pubkey; 2]` (white, black)
- `position: [u8; 64]` (0 empty; 1..6 white P N B R Q K; 7..12 black)
- `clock_ms: [u64; 2]` (remaining time per seat)
- `increment_ms: u64`
- `turn_started_at: i64` (when the current seat's clock started)
- `started_at: i64`, `finished_at: i64`
- `halfmove_clock: u16` (for the fifty-move rule)
- `fullmove_number: u16`
- `move_count: u32`
- `history_hashes: [u64; 256]` (position hashes for threefold), `hist_len: u16`
- `draw_offer: u8` (seat that offered, 255 none)
- `last_request_ref: u64` (idempotency for create/join/finish)
- `bump: u8`

Notes:
- The board is 64 bytes; the history of 256 u64 hashes is 2 KB, enough for the
  longest practical game for threefold detection. If a game exceeds 256 plies we
  can switch to a "fivefold counter" approach; flagged as a design detail.
- `clock_ms` and `turn_started_at` implement the clock. Remaining time is
  computed as `clock_ms[seat] - (now - turn_started_at)` for the seat to move.

## 4. Instruction set (all additive on gfg)

Lifecycle (relay + players):
- `create_chess_match(match_ref, time_control, max_match_secs)`: sponsor pays,
  creates the board on base, seat 0 = host, seat 1 = open. Requires the host's
  lives ledger (gate check only, no consume yet).
- `join_chess_match(match_ref)`: joiner fills seat 1 (open seat only, status 0).
  Requires the joiner's lives ledger.
- `delegate_chess_board(match_ref)`: relay moves the board into the ER session.
- `start_chess_match(match_ref)`: host signs, status 0 -> 1, sets the clock from
  the selected time control and starts white's clock. Requires lives.
- `undelegate_chess_board(match_ref)`: returns the board to base (relay).

Gameplay (gasless on the ER, player session key):
- `make_chess_move(match_ref, from: u8, to: u8, promotion: u8)`: the ONLY writer
  of position. Validates seat authority, turn, and full legality; applies the
  move; updates clocks, castling, en passant, halfmove and fullmove counters;
  appends the position hash; detects and records end conditions. Reverts on any
  illegal move.
- `ai_chess_move(match_ref)`: house-signed, computes and applies the on-chain
  AI reply for the AI seat in single player. Same validation path as a human
  move, so the AI can never make an illegal move.
- `resign_chess(match_ref)`: the signing seat resigns, game finishes.
- `offer_draw_chess(match_ref)` and `accept_draw_chess(match_ref)`: mutual draw.
- `claim_timeout(match_ref)`: PERMISSIONLESS. Anyone may call it; the program
  verifies that `now - turn_started_at` exceeds the seat-to-move's remaining
  clock and, if so, finishes the game as a win for the opponent. No crank, no
  trusted caller, deterministic from on-chain timestamps.
- `expire_chess_idle(match_ref)` (optional): permissionless abandon/finish for a
  match with no moves for the max window; finishes as a draw or abandon with no
  reward. Kept identical in spirit to Ludo's abandonment handling.

On completion the winning seat is recorded on-chain, one life is consumed for
each seat present, and the client publishes the M2 seam with the outcome.

## 5. State machine

- 0 lobby -> 1 in progress (host `start_chess_match` with both seats filled)
- 1 in progress -> 2 finished (checkmate, resignation, timeout, any draw rule,
  or agreement)
- Any invalid transition reverts. Abandon is not a completion and never rewards.

## 6. Moves and rules mapping (implemented on-chain)

- Movement: king, queen, rook, bishop, knight, pawn, including the first double
  step.
- Special moves: castling (all conditions), en passant (only the immediate
  reply), promotion (Q/R/B/N).
- Legality: a move is legal only if it does not leave the mover's king in check.
  Moves are fully validated from the board state, never from client input.
- End conditions: checkmate, stalemate, threefold repetition (via the position
  hash history), fifty-move rule (halfmove clock), insufficient material, and
  agreement. Check is a display flag, not a terminal state.

## 7. Clock and permissionless timeout

- Each seat has `clock_ms`; every move spends elapsed time and adds the
  increment.
- The seat to move is the only one burning time (stored in `turn_started_at`).
- When the clock lapses, any caller may run `claim_timeout`; the program
  computes the result from timestamps and finishes the game.
- If both players are offline, the match simply stays unresolved until someone
  (either player, a keeper, or a future optional crank) calls it. The RESULT is
  still deterministic.

## 8. Computer opponent (single player, on-chain)

- Deterministic light engine in `chess.rs`: generate legal moves, evaluate with
  material plus simple piece-square tables, search one to two plies, and use a
  small opening book for the first moves.
- Must fit the compute budget: default 200k CU for a move; request up to 1.4M CU
  per transaction for the AI reply. No recursion deep enough to blow the 4 KB
  stack frame (iterative generation, small fixed-size move buffers).
- House-signed: the relay holds the house key and submits `ai_chess_move`, so a
  player can never retry the AI until it blunders.

## 9. ER lifecycle

1. `create_chess_match` on base (sponsor pays rent).
2. `delegate_chess_board` to the ER (sponsor pays once).
3. All moves, clock, resign, draw, and claim_timeout run gasless on the ER.
4. On completion, commit and `undelegate_chess_board` so the final record is on
   base and readable by the seam and the profile.

Region-agnostic: resolve the board's hosting region from the Magic Router
(`getDelegationStatus` -> fqdn) and submit/poll there, with the existing 3-region
registry and failover.

## 10. Lives gate

- `create_chess_match`, `join_chess_match`, and `start_chess_match` require the
  signer's lives ledger and pass the same gate as Ludo (NoLives rejection).
- One life is CHARGED AT GAME START per seat and is NON-REFUNDABLE (owner
  2026-09-19): win, lose, draw or abandon all spend it. Nothing refunds it, which
  ends the abandon exploit.
- Enforced in the program, so any frontend, including a third-party one, is
  bound by it. A third party cannot use this program to bypass lives.

## 11. Result seam and points

- On completion the client publishes the `gfg:game-result@1` envelope with
  seat-to-wallet identity (same as Ludo multiplayer), so each logged-in seat is
  credited at its own wallet.
- M1 stays reward-blind. M3 maps a win to 1st place; a draw shares the pool; a
  loss earns nothing. Exact point numbers are locked in M3 before the build.

## 12. Compute budget plan

- Move generation and legality: iterative, fixed-size buffers, no recursion.
- End-condition scan (check/checkmate/stalemate): bounded, single pass.
- AI reply: request up to 1.4M CU via `SetComputeUnitLimit`.
- Watch the 4 KB stack frame limit that the repo already hit; keep large arrays
  out of the stack frame (use account data, not locals).

## 13. Test plan (FIDE-style, on-chain)

- Perft: node counts for the standard opening positions must match known values.
- Each special move: castling both sides with all conditions, en passant,
  promotion to each piece.
- End conditions: checkmate, stalemate, threefold, fifty-move, insufficient
  material, resignation, timeout.
- Illegal move rejection: moving into check, wrong seat, out of turn, illegal
  piece movement.
- Clock: claim_timeout finishes a lapsed game with no client online.
- Lives: gate pass and fail; exactly one life per completed match.
- Seam: emission and wallet-correct crediting.
- Gasless: 0-SOL session-key writes succeed on the ER.

## 14. Locked decisions (popular-standard defaults)

1. Time controls: presets 1+0 bullet, 3+2 blitz, 5+0 blitz, 10+0 rapid as the
   DEFAULT, and 30+0 classical.
2. Draw offers: agreed draws allowed (mutual offer then accept), matching
   standard chess.
3. Solo AI: two difficulty levels, light and standard.
4. Game length: a 300-ply safety cap finishes as an automatic draw, to bound the
   history array and compute. This is a safety bound, not a rule change.

This doc is final. Phase 1 (the on-chain core with perft tests) begins.
