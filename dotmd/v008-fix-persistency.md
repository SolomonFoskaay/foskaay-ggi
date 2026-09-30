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

## B. The full unedited analysis (as written before the fix, preserved word for word)

You are right, and I was wrong about the room. Let me correct myself plainly
before the outline.

### Where I went wrong

I said the moves have nowhere free to rest except phones passing notes. That
forgets what the midchain actually is: the signed move log IS the free room
memory, the same way the board PDA is the memory on MagicBlock ER. GFG writes
each move into the delegated board account for free. We write each move into
the session log for free: board bytes produced by the contract itself,
hash-chained, signed, addressed by sessionId. Same shape, different shelf. And
you are right about reads too: reading Arc never charges. Only transactions
charge. eth_call and view reads are free on Arc exactly like everywhere else;
the fee appears only when a state-changing call is sent as a transaction. That
is the whole game of the design below.

### How GFG multiplayer does it, in code (what I restudied)

- Writes go to the room, never the base chain. commit_move in
  gfg-dice/src/lib.rs writes last_move_commit (32 bytes), move_count + 1,
  current_turn, and the turn deadline directly on the delegated board PDA.
  Gasless because the PDA lives on the ER. Our mirror: each relay-executed
  move appends one signed log entry under the sessionId: previous hash, new
  hash plus the 36 board bytes the contract itself produced, seat, kind,
  timestamp, sponsor signature. Same fields, same job.
- The board is one snapshot, not a move list. The ludo-lab adapter commits the
  WHOLE board (16 token positions plus dice plus turn in 32 bytes) every time,
  and the receiver reconstructs the entire board from the latest snapshot
  without replaying history. Our mirror: every log entry carries full board
  bytes, so any phone draws the current board from the latest verified entry
  alone.
- Everyone reads the same truth. subscribe polls the board PDA; every phone
  derives the turn from the same committed bytes. Our mirror: phones poll the
  session log and verify hash continuity plus signatures plus the on-chain
  Handover anchors before drawing anything.
- Rejoin finds your seat from the record. Resume reads the on-chain players
  list, matches the logged-in wallet, replays the latest snapshot. Our mirror,
  identical: seat from the committed players list, board from the latest
  verified entry.
- The clock lives in the game core. commit_move re-stamps the deadline from
  chain time, expire_turn force-passes permissionlessly with the program
  verifying expiry. Our mirror, already built in v4: contract constants plus
  isTurnExpired, timestamps in the log, settle re-verifies.
- Finish needs one seat, not all. finish_match accepts any seat holder. Our
  mirror, already built: winner-alone auto-settle.

### The session-call design (your key sentence, adopted as law)

Every gameplay read or write is identified by sessionId first: the log is
namespaced per session, the contract is touched only through free eth_call
(rules, dice, timer views, hash, decode) or through the single settle, and the
Handover plus Settle anchors tie that sessionId to the chain. Calling the game
proxy with a state-changing call directly is an Arc transaction and full gas:
that was exactly the recordLive mistake the dotmd fix removed, and the audit
stays permanent: the Arc signer appears only in handover plus settle paths,
zero hits in move paths, and the two-transaction count per session never grows.

### C v2 as first proposed (mapped one to one onto GFG, approved before build)

1. Session log as room memory. Entries {sessionId, idx, prevHash, newHash,
   board, seat, kind, ts, sig}. This is our board PDA.
2. Each phone keeps the verified entries it has seen on its own device and
   re-verifies them on load before drawing. Not a web2 service, not truth:
   truth stays signatures plus chain, the copy only saves re-fetching. Refresh
   and same-wallet second device recover from it.
3. Relay merge endpoint. After a restart, phones re-submit witnessed entries;
   the relay verifies continuity plus signatures plus anchors before merging,
   then serves the reunited log. Relay stays an untrusted carrier, like today.
4. Settle reads the merged log (timestamps included) exactly as now.

Nothing new to buy, no database, no new vendor, no new transaction, contracts
stay the only truth, tampered entries rejected on sight.

## C. Correction: what the owner actually wanted, and what I misread (2026-09-29)

The owner rejected point 2 above as built: persistence must live IN THE GAME
CONTRACT as bytes (the same contract, the way the GFG board PDA holds the
match), called through the session and read back via subscribe with NO
transaction, dependable during AND after the session ends. The device-kept
copy was in the approved words but never the intent, and the agent should have
asked instead of building it. The pushed device-cache plus merge code stands
unapproved in intent even where it matches the approved words; it stays or
goes on the owner word only.

The record both sides must share (quoted, not paraphrased):

- `dotmd/foskaay-ggi-recordlive-room-fix-agent.md`: "Foskaay GGI has exactly
  ONE chain (Arc) and NO sidechain, RPC or dedicated environment. The
  midchain is an OFF-CHAIN signed hash chain that replicates MagicBlock ER
  without any special validator."
- `dotmd/foskaay-ggi-build-guide-v5.md`: moves are "signed and hash-chained
  off-chain and executed by eth_call for free, with only two real transactions
  per match (handover and settle)."

The honest physics both sides now share:

- eth_call (compute) and eth_getLogs/view reads are ALWAYS free, on Arc and
  every EVM chain. Looking never costs.
- SAVING is a state-changing transaction and ALWAYS costs, on Arc and every
  EVM chain. There is no free-write room on any EVM chain the way the
  MagicBlock ER gives Solana free writes on delegated accounts.
- So "saved in the contract as bytes, persistent during and after the
  session" is buildable exactly one way: extra on-chain checkpoint
  transactions written by the sponsor. Reads of those checkpoints (subscribe
  polling, rejoin replay) are free forever.
- The two-transaction economics and contract persistence cannot both hold on
  Arc. One of them gives way by owner decision, never silently.

## D. Options on the table (no build until one is approved)

1. Contract checkpoints: sponsor-signed snapshot writes to GFGGames per turn
   (or per few moves). True contract persistence, free reads, survives
   everything, but each checkpoint is a paid transaction and the per-match
   cost grows with move count. Exact cost measured on testnet before mainnet
   is even discussed.
2. Device plus merge (already pushed, intent-unapproved): free and
   transaction-free, but depends on phones holding copies. Keep or remove on
   owner word.
3. Accept relay-memory limits: lobbies plus short matches only, refresh loses
   mid-game. No change needed.

## E. Confirmation (owner fills after testing)

- [ ] Mid-game refresh on one phone reconstructs the exact board, turn and
      countdown with zero new transactions.
- [ ] Second phone joins by link tap and plays, no copying by hand.
- [ ] Relay-side loss recovers through device re-submit plus merge.
- [ ] Winner finishes alone; loser phone shows the sealed result.
- [ ] Stalled seat times out by the contract clock on both phones.
