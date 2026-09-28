# AGENT TASK: Fix `recordLive` Gas Leak + Ludo Refresh Persistence (Foskaay GGI Midchain)

## 1. Context (read this first)

Foskaay GGI has two execution environments. Do NOT confuse them:

- **Arc mainnet (the real chain):** holds the `FoskaayGGI` core. Only TWO transactions per session ever touch Arc:
  1. `handover` / `handoverWithAccounts` (opens the session, lifts dev accounts, pays fee)
  2. `FoskaayGGIGames.settle` + core `settle` (closes the session, commits results to Arc, once each)
- **The Foskaay GGI Midchain room (the free room):** a shadow EVM where the lifted contracts (`FoskaayGGIGames`, `FoskaayGGIPlayers`) actually execute during play. Every call inside the room is FREE: moves (`applyMove` via eth_call), dice (`randomN` via eth_call), point credits (`credit`), lives (`setLives`), and live board writes (`recordLive`).

Rule: **a gameplay write is free if and only if its provider/signer points at the room.** A write is expensive if and only if it points at Arc. The bug is never "we wrote" — it is always "we wrote to the wrong chain."

## 2. Root cause of the current bug

`recordLive` in `FoskaayGGIGames.sol`:

```solidity
function recordLive(bytes32 sessionId, bytes calldata board) external onlyOwner {
    liveBoards[sessionId] = board;
}
```

This function is correct. One SSTORE, overwrite, `onlyOwner`. The bug is in the RELAY wiring: the per-move code path calls `recordLive` on a contract instance attached to the **Arc provider** instead of the **room provider**. `applyMove` hid this because it is `pure` (eth_call needs no signer). `recordLive` is state-changing, needs a signer, and the agent grabbed the Arc signer.

Second symptom, same cause: after page refresh the Ludo board is lost because the frontend reads `liveBoard(sessionId)` from **Arc** (where `liveBoards` is empty) instead of from the **room** (where the live board actually lives).

## 3. Fix part A — relay: split room vs Arc contract instances

In the relay, there must be exactly two instances of the game contract. Create both at startup:

```js
const roomProvider = new ethers.JsonRpcProvider(process.env.FOSKAAY_ROOM_RPC);
const arcProvider = new ethers.JsonRpcProvider(process.env.ARC_RPC);
const roomSigner = new ethers.Wallet(RELAY_KEY, roomProvider);
const arcSigner = new ethers.Wallet(RELAY_KEY, arcProvider);

const gamesRoom = new ethers.Contract(GAMES_ADDR, GAMES_ABI, roomSigner); // LIVE path
const gamesArc = new ethers.Contract(GAMES_ADDR, GAMES_ABI, arcSigner);   // COMMIT path only
```

Change the per-move handler to:

```js
await gamesRoom.recordLive(sessionId, board);
```

Constraints:
- The move/dice/credit handler module MUST NOT import `gamesArc`. If it cannot see the Arc signer, it cannot leak.
- Only the session-close handler may use `gamesArc.settle(sessionId, list, seatPlayers, gameTag)` and the core `foskaayGGI.settle(...)`, exactly once each per session.
- Same split applies to the player contract if the relay ever calls it directly: `playersRoom` for live, `playersArc` never in the hot path (credits on Arc happen only inside `FoskaayGGIGames.settle`, which is already one transaction).

## 4. Fix part B — frontend: split providers + refresh re-attach

The frontend needs the same two providers:

```js
const roomProvider = new ethers.JsonRpcProvider(roomRpcUrl); // from session storage, see below
const arcProvider = new ethers.JsonRpcProvider(ARC_RPC_URL);
const gamesRoom = new ethers.Contract(GAMES_ADDR, GAMES_ABI, roomProvider);
```

Rules:
- During a live session, ALL reads for rendering (`liveBoard`, `decodeState`, `pointsOf`, `livesOf`) go through the room provider. `decodeState` is pure, so it can run anywhere, but feed it the board bytes fetched from the room.
- NOTHING in the gameplay UI sends transactions except the initial connect (handover, via the sponsor flow that already exists).

Refresh persistence:
1. At connect time, store `{ sessionId, roomRpcUrl }` in BOTH the URL query params (`?session=0x...&room=https://...`) and `localStorage`.
2. On page load, check for an existing live session: if `sessionId` + `roomRpcUrl` are present AND the core on Arc shows `isPaid(sessionId) == true` and `settled(sessionId) == false`, re-attach to the room:
   ```js
   const board = await gamesRoom.liveBoard(sessionId);
   const decoded = await gamesRoom.decodeState(board); // pure, free
   render(decoded);
   ```
3. If the session is settled on Arc, switch to Arc reads: `gamesOf(sessionId)`, `playerGamesOf(sessionId, player)`, `pointsOf(player, gameTag)`.

## 5. Fix part C — optional hardening: chain-ID guard on `recordLive`

So a future wiring mistake reverts loudly instead of silently burning Arc gas. Add to `FoskaayGGIGames.sol`:

```solidity
/// Chain ID of the Foskaay GGI Midchain room. `recordLive` only runs there.
uint64 public roomChainId;

function setRoomChainId(uint64 id) external onlyOwner {
    roomChainId = id;
}

function recordLive(bytes32 sessionId, bytes calldata board) external onlyOwner {
    require(block.chainid == roomChainId, "not room");
    liveBoards[sessionId] = board;
}
```

Notes:
- This is an append-only storage addition: declare `roomChainId` and consume ONE slot from the top of `__gap` (shrink `__gap` from 20 to 19). Do NOT reorder existing variables.
- The room MUST have a chain ID different from Arc mainnet. Set it once via `setRoomChainId` right after deploy.
- Same guard can be added to any other room-only write if one is added later.

## 6. Audit checklist (do this before declaring done)

- [ ] Grep the relay for the Arc signer/provider variable: it appears ONLY in the handover and settle code paths. Zero hits in move/dice/`recordLive`/credit paths.
- [ ] Grep the frontend for `liveBoard(`, `pointsOf(`, `livesOf(`: all resolve to room-attached instances during a live session.
- [ ] `recordLive` is called with `gamesRoom`, never `gamesArc`.
- [ ] Refresh test: start a game, make 3 moves, refresh the page → board, points, and turn reconstruct exactly from the room, with zero new Arc transactions.
- [ ] Session-close test: finish a game → exactly TWO Arc transactions exist for the session (`FoskaayGGIGames.settle` and core `settle`), regardless of move count. Verify on the Arc explorer that no per-move transactions were mined during play.
- [ ] Post-settle test: `gamesOf(sessionId)` and `playerGameIndices`/`pointsOf` on Arc show the committed history and credited points.

## 7. What NOT to do

- Do NOT make `recordLive` pure/view or delete it. It is the correct persistence mechanism; only its target chain was wrong.
- Do NOT move point crediting to per-move Arc transactions. Points stay as free room writes (`credit` on the room-attached player contract, or board-embedded points via `_recordFinish`); the single on-Arc credit happens inside `FoskaayGGIGames.settle`.
- Do NOT add any new per-move transaction on Arc for any reason. The invariant is: move count is unbounded, Arc transaction count per session is exactly 2 (open + close).

---

## 8. Section Two: the correction that was actually built (approved)

This file's original diagnosis had the right direction (a "gameplay write pointed at Arc" is the leak)
but a wrong premise: it claimed Foskaay GGI runs a shadow EVM with its own RPC (`FOSKAAY_ROOM_RPC`),
env var and chain ID. There is none. Foskaay GGI has exactly ONE chain (Arc) and NO sidechain, RPC or
dedicated environment. The "midchain" is an OFF-CHAIN signed hash chain that replicates MagicBlock ER
without any special validator: pure rules compute each move free via eth_call, each state is hashed
(`prevHash -> newHash`) and signed, and the log anchors on-chain twice and only twice (Handover,
Settle). Move counts are unbounded and Arc transaction count per session is exactly 2.

Because of that misread, Fix A (bind a `gamesRoom` instance to a room RPC) and Part C (`block.chainid`
guard) are NOT applicable: there is no second provider to target and no second chain id to check. The
part of the doc that IS correct and was adopted is its invariant: never a per-move Arc transaction.

What was built instead (owner-approved, verified on the live demo):

1. **Removed the per-move `recordLive` write in the relay move path** (`api/index.mjs`). Moves are
   again purely: eth_call + hash chain + signature. The move path has no Arc signer at all.
2. **Rejoin returns the signed move log plus its on-chain anchors** (Handover startHash, seedCommit,
   participants, sponsors); the CLIENT verifies it before drawing one token. The relay is an untrusted
   cache, never the truth.
3. **Client-side verification is now an SDK method** (`verifyMoveLog`) that checks chain continuity
   (each move.prevHash == previous move.newHash, first == startHash), every signature against the seat's
   session key or the sponsor over `midchainDigest`, and, if settled, the last hash against the on-chain
   finalHash. Free (reads only). A tampered or truncated log is rejected loudly.
4. **Cold-start rejoin tells the truth**: if the relay instance lost the log, the page reports the
   on-chain facts (paid session, committed result once settled) instead of fabricating a board or
   re-creating a per-move write.
5. **No localStorage, no web2 database.** The session URL is the only handle. This is a full on-chain
   game with a tamper-proof front end: the browser owns nothing, it displays only what the chain and the
   verified midchain say.
6. The SDK (0.2.6) dropped the `liveBoard`/`recordLive` client methods so no developer can accidentally
   reintroduce the third fee, and documents the midchain rule in its README.

Proof that this pattern already fixed moves once: see `dotmd/foskaay-ggi-agent-fix-v6.md` (v6 in the
same series), which removed the per-roll/per-move SSTORE the same way, leaving only handover + settle
as Arc transactions.
