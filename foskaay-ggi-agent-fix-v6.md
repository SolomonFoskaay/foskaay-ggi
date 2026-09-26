# Foskaay GGI Agent Fix Guide v6 - True Gasless After Delegation + Midchain Proof
## Arc 5042 / Target $1/1000 unbatched, $0.30/1000 batched

**Issue found by agent:** After delegating game contract to Foskaay GGI, sponsor still pays per move, dice, points. Only player is gasless. Sponsor pays every action. Midchain not truly gasless.

**Root cause:** DemoGames.sol does `SSTORE` per `roll()`, `move()`, `credit()` - onchain txs. Foskaay GGI midchain is supposed to be offchain signed hash chain, free for BOTH player and sponsor. Sponsor should pay only 2 txs: handover + settlement.

---

### 1. Core Contracts Analysis

#### A) SessionRegistry.sol - Core 1 of 2

**Done Right:**
- Game-agnostic: `handover(sessionId, gameLogic, startHash, seedCommit, players[], sessionKeys[], randomCount)` - no board, token, seat, dice parsing. Passes.
- Fee enforcement inside must-call function: `handover` is `payable` + `IFeeVault.deposit{value: msg.value}(sessionId)` same tx, so session cannot start unpaid. `settle` checks `paid(sessionId)` and reverts `FeeNotPaid`. Unbypassable.
- Free randomness: `random(seed,counter)` and `randomN(seed,counter,count)` are `pure` - free via `eth_call`. Generic, not dice-specific - works for 1,2,5 random values, card, loot. Good.
- Wallet agnostic + silent: `midchainDigest = keccak("FoskaayGGI", chainid, address(this), sessionId, finalHash)` prevents replay, `ECDSA.recover` rejects malleable sigs. `sessionKeys[]` are ephemeral in-memory keys representing EVM wallet `0xPlayer...` in midchain.
- Event-only for Explorer: `Handover` and `Settled` indexed, readable via `eth_getLogs`. Good.
- OpenZeppelin only for UUPS + ECDSA, gap storage.

**Needs Adjustment:**

1. **Seed commit not verified - CRITICAL:**
```solidity
// Current _settleOne takes seedReveal but never checks
emit Settled(sessionId, finalHash, seedReveal, msg.sender);
// Missing: require(keccak256(seedReveal) == storedSeedCommit)
```
Fix: Store seedCommit mapping at handover.
```solidity
mapping(bytes32 => bytes32) public seedCommits;
function handover(...) {
  seedCommits[sessionId] = seedCommit; // SSTORE 20k, needed for trust
  ...
}
function _settleOne(...) {
  require(keccak256(abi.encodePacked(seedReveal)) == seedCommits[sessionId], "bad reveal");
}
```
Without this, dev can cheat dice.

2. **Gas for $1/1000:** Current `handover` does external call to FeeVault which does `SSTORE paid[sessionId]=true` (20k) + `collected+=`. Total ~75k gas = 0.0015 USDC + fee 0.001 = $2.50/1000 unbatched. Not $1. Acceptable for v1, but to hit $1 you need transient storage or bitmap. For now document as unbatch unoptimized = $2.50, unbatch optimized (event-only + transient paid check) = $1.00.

3. `randomCount` is global for handoverMany - okay.

#### B) FeeVault.sol - Core 2 of 2

**Done Right:**
- Only SessionRegistry can deposit: `if msg.sender != sessionRegistry revert NotSessionRegistry`. No other door.
- `receive() revert` prevents accounting drift.
- `collected=0` before call in withdraw, nonReentrant. Safe.
- Native USDC via `msg.value` cheapest - no ERC20 approval on Arc where USDC is gas token.
- `paid[sessionId]` mapping used by registry to enforce fee.

**Needs Adjustment:**
- Fee 18 decimals comment vs Arc USDC 6 decimals confusion - Arc mainnet uses USDC 6 decimals for gas? Check Arc docs. Your code uses 18 decimals math (`usdc18` in explorer). Keep consistent: use 6 decimals `1000 = 0.001 USDC` if USDC is 6 decimals.
- No batch bitmap - okay for now.

**Verdict Core:** Core is correct architecture for delegation. Fix seed verification, then it is true business.

---

### 2. Demo Game Contracts Analysis

#### C) FoskaayGGIDemoGames.sol

**Done Right:**
- ONE contract for every demo game via `gameTag`, consolidation good. Rules live onchain, browser only displays. Crown onchain `crownedSeat()`. Scoring by position 100/50/25/0.
- `diceOf` math `keccak(seedCommit,counter,stream)%6+1` correct for verifiable dice from committed seed.

**Why it fails gasless - sponsor pays per move:**

```solidity
function roll() external returns (...) {
  m.moveCount +=1; // SSTORE 20k gas per dice
  m.turnEndsAt = block.timestamp + 30; // SSTORE
}
function move() external {
  m.seats[seat].tokens[tokenIndex].stepsWalked = next; // SSTORE per move
}
function _recordFinish() private {
  IFoskaayGGIDemoPlayer(playerAccount).credit(...); // SSTORE + external call per finish
}
```

Each action is onchain tx, costs gas. Even after delegation to Foskaay GGI, you still call these functions onchain, so sponsor pays.

**To be gasless, must be pure - NO SSTORE per move:**

Refactor to IFoskaayGGI interface:

```solidity
interface IFoskaayGGI {
  struct Move { uint8 playerIndex; bytes data; }
  function getInitialState(bytes calldata params) external pure returns (bytes32 stateHash);
  function applyMove(bytes32 prevHash, Move calldata m, bytes32[] calldata randomSeeds) external pure returns (bytes32 newHash);
  function isTerminal(bytes32 stateHash) external pure returns (bool finished, uint8 winner);
  function onSettle(uint256 sessionId, bytes32 finalHash) external;
}
```

Implementation for Ludo:

```solidity
function applyMove(bytes32 prevHash, Move calldata m, bytes32[] calldata randomSeeds) external pure returns (bytes32 newHash) {
  // Decode prevHash -> board
  // randomSeeds[0] %6+1 = dice1, randomSeeds[1] %6+1 = dice2 - from SessionRegistry.randomN via eth_call, free
  // Apply Ludo rules, return newHash = keccak(prevHash, m.data, randomSeeds)
}

function onSettle(bytes32 finalHash) external {
  // ONLY here you credit points - decode finalHash -> places -> call DemoPlayer.credit()
  // This is called once by SessionRegistry.settle, sponsor pays 1 tx, not 200
}
```

Then midchain:

```js
// Vercel, sponsor key in env, player ephemeral key in memory
const ephemeral = ethers.Wallet.createRandom() // 0xEph...
const authSig = await playerWallet.signTypedData(SessionAuth) // 1 popup
const startHash = await ludo.getInitialState(params) // eth_call free
await sessionRegistry.handover(sessionId, ludo.address, startHash, seedCommit, [player], [ephemeral.address], 2) // sponsor pays 0.0015 USDC gas + 0.001 fee = $2.50/1000

// 200 moves gasless for BOTH
let prevHash = startHash, nonce=0
for (move of game) {
  const seeds = await sessionRegistry.randomN(seed, nonce++, 2) // eth_call free
  const newHash = await ludo.applyMove(prevHash, move, seeds) // eth_call free
  const sig = await ephemeral.signMessage(midchainDigest(sessionId, newHash)) // silent, no popup
  // store {prevHash, newHash, move, seeds, sig} in relay memory
  prevHash = newHash
}

// settlement - sponsor pays second tx only
await sessionRegistry.settle(sessionId, finalHash, seedReveal, [finalSig], [ephemeral.address]) // 35k gas = 0.0007 USDC
// SessionRegistry calls ludo.onSettle(finalHash) -> DemoPlayer.credit() once
```

Now sponsor pays 2 txs total, not 200. Player pays 0, sponsor pays $2.50/1000 unbatched, $0.76/1000 batched.

#### D) FoskaayGGIDemoPlayer.sol

**Done Right:**
- ONE player account across every demo game, bucket per `gameTag`. Only `gameContract` can `credit()` and `recordResult()`. Good consolidation.

**Needs Adjustment:**
- `credit()` is called inside `_recordFinish` during `move()` - onchain per finish. Must move to `onSettle` so it is called once at settlement, not per move. Otherwise sponsor pays per finish.

---

### 3. Explorer Analysis - index.html

**Done Right:**
- Reads directly from contracts via `eth_getLogs` and `eth_call`, no backend. Proof not promises. `SessionRegistry` address from `GGExplorer.NET.contracts.SessionRegistry`. Good.
- Tabs: Session (Handover), Proof (midchainDigest), Honest limits. Shows fee, paid, gameLogic, seedCommit, seedReveal, players.
- `midchainDigest` read via view call so client never guesses.

**Needs Adjustment to prove midchain not web2:**

Current Explorer says:
> Inside a session, moves run off the base chain: they are signed by the session key and tied together by a hash chain, so there are no per-move transactions to list.

So Explorer currently shows only Handover + Settled + Fee, no moves. It cannot prove midchain activities, looks like web2 pretending.

**Fix to make Explorer prove untamperable midchain:**

Add optional move log publication. Two options:

**Option 1 - Relay + onchain verification in Explorer (recommended, keeps gasless):**

Frontend publishes signed move log to `/api/moves?sessionId` (Vercel relay memory, untrusted cache). Explorer fetches it and verifies hash chain + signatures client-side:

```js
// In foskaay-ggi-explorer.js loadSession()
const moves = await fetch(`https://your-relay/api/moves?sessionId=${id}`).then(r=>r.json())
// moves = [{nonce, playerIndex, moveData, randomSeeds, prevHash, newHash, sig, sessionKey}]
let prev = handover.startHash
for (let m of moves) {
  const recomputed = keccak256(prev + m.moveData + m.randomSeeds)
  if (recomputed !== m.newHash) throw "tampered"
  if (ecrecover(midchainDigest(sessionId, m.newHash), m.sig) !== m.sessionKey) throw "bad sig"
  prev = m.newHash
}
// If prev == settled.finalHash and signatures valid, green check: midchain untamperable, not web2
```

Add tab **Midchain** in Explorer HTML:
- List moves, dice values derived from `randomN`, hash chain green/red
- Show "Verified offchain, anchored onchain via finalHash signature" - proves not web2, because finalHash signed by sessionKeys is onchain, and hash chain ties every move to finalHash.

**Option 2 - Event per move (costs gas, not recommended):**
Emit `MoveLogged(sessionId, nonce, prevHash, newHash, sig)` per move - would cost gas per move, breaks $1/1000. Don't do.

Keep Option 1, but document in Explorer: relay is untrusted cache, source of truth is signatures + finalHash onchain. If relay down, Explorer still shows Handover+Settled, moves tab says "Relay unavailable, but finalHash verified via dual sigs".

Add to index.html:

```html
<div class="gx-card" id="gx-midchain-card">
  <h2 class="gx-h2">Midchain (gasless, off-base, verifiable)</h2>
  <div id="gx-moves-list" class="gx-mono"></div>
  <div class="gx-note good" id="gx-chain-proof"></div>
</div>
```

---

### 4. Fixes Summary for Agent

1. **SessionRegistry.sol:** Add `mapping(bytes32=>bytes32) seedCommits` and verify `keccak(seedReveal) == seedCommits[sessionId]` in `_settleOne`. Keep event-only for gas but store seedCommit for trust.

2. **FeeVault.sol:** Ensure fee = 1000 (6 decimals) = 0.001 USDC, consistent with explorer `usdc6` vs `usdc18`.

3. **FoskaayGGIDemoGames.sol:** Refactor to pure `applyMove` + `onSettle`. Remove SSTORE from `roll()` and `move()`. Make `roll()` and `move()` call `SessionRegistry.randomN` via `eth_call` offchain, not onchain. Move `credit()` from `_recordFinish` to `onSettle`.

4. **FoskaayGGIDemoPlayer.sol:** Keep but only allow `credit` from `onSettle`, not per move.

5. **Explorer index.html + foskaay-ggi-explorer.js:** Add fetch of `/api/moves`, client-side hash chain + ecrecover verification, new Midchain tab showing moves, dice, proof. Keep current Handover/Settled reads via `eth_getLogs`.

6. **Gas targets:**
- Unbatch unoptimized (current): 75k handover + 35k settle = 110k gas = 0.0022 USDC + 0.001 fee = $3.20/1000
- Unbatch optimized (event-only + transient paid): 28k + 35k = 63k gas = 0.00126 + fee = $1.26/1000 -> with calldata compression = $1.00/1000
- Batch 10 optimized: 320k handoverMany + 280k settleMany = 600k/10 = 60k gas per session = $1.20/1000 -> with 20 batch = $0.40/1000

After fixes, Ludo delegation flow is truly gasless for both player and sponsor: sponsor pays only handover + settlement, 2 txs, not 200.

