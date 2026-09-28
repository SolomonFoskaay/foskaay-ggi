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
