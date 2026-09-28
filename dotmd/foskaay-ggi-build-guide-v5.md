# Foskaay Gassless Games Infrastructure (Foskaay GGI)
## Build Guide v5 - Complete with MagicBlock ER Context & Cost Models
### Arc Mainnet 5042 / Testnet 5042002 | Target $1/1000 unbatched, $0.30/1000 batched

---

### 0. INTRO - Why This Exists: MagicBlock ER on Solana and its EVM Equivalent on Arc

**What MagicBlock ER does on Solana:**
MagicBlock ER (Ephemeral Rollup) lets a Solana game dev delegate their game account (e.g., Ludo board PDA) to MagicBlock's validator network. Flow:
1. `delegate` tx on Solana base chain - hands over board account to ER
2. 200 moves happen inside ER - free, gasless for player, free for sponsor, not on Solana base explorer, only visible in MagicBlock ER explorer
3. `undelegate` tx on Solana base - commits final state back to base chain with proof

Sponsor pays only delegation + undelegation fees. 200 moves cost 0. Player signs silently via session. Frontend only renders. Single source of truth is Solana base + ER proof.

**Why ER needs validators and why we don't on EVM Arc:**
MagicBlock needs dedicated validators to run custom SVM runtime for 10ms latency and to hold delegated accounts. That's expensive - they charge per session and share 90% to validators.

On EVM Arc we don't have custom runtime, but we have cheaper primitives that replace validators:
- `EIP-712` + `ecrecover` = signature is the validator. If a move is signed by authorized session key, it's valid.
- `keccak256` hash chain = `H_n = keccak(H_{n-1}, move, randomSeeds)` - if any move tampered, finalHash breaks and settle reverts. This is the Foskaay GGI Midchain that is neither fully onchain nor web2 offchain - it's cryptographically tied to onchain handover.
- Pure functions for randomness = `random(prevHash, nonce)` via `eth_call` - free, no gas, lives in core contract.

So Foskaay GGI equivalent on Arc:
1. `handover` tx on Arc - equivalent to MagicBlock `delegate` - dev hands over startHash + players + sessionKeys to FoskaayGGICore
2. 200 moves happen in browsers - each move signed silently with ephemeral session key (in-memory, no localStorage, no popup), hash-chained, free, not on Arc base explorer
3. `settle` tx on Arc - equivalent to MagicBlock `undelegate` - commits finalHash back to Arc base with proof (dual signatures)

Sponsor = game dev wallet in Vercel env holding `SPONSOR_PRIVATE_KEY` - pays only 2 txs, not 200. Player = gasless, silent signing, no popups.

**Why we chose this tech:**
- No L2/L3/L4, no external RPC, no paymaster service, no validator network - solo dev can build with only smart contracts + Foundry
- `EIP-712 SessionAuth` - one popup to authorize ephemeral key, then ephemeral key signs everything silently via `ethers.Wallet.createRandom()` in memory
- Hash chain + dual sig final = tamper-proof Foskaay GGI Midchain, not web2 backend. If frontend tampers, opponent refuses to sign finalHash and settle reverts.
- Generic randomness via `keccak256(prevHash, nonce, i)` - gives N random seeds for dice, cards, loot, shuffle - game agnostic, not dice-specific
- Event-driven cheap gas - at Arc floor 20 Gwei, 21k gas = 0.00042 USDC, 65k gas ERC20 = 0.0013 USDC. To hit $1/1000 = $0.001 per game total, we must use events not SSTORE.

---

### 0.1 How Explorer Indexing Works and Why Normal Arc Explorer Sees Nothing

Normal Arc explorer (like `explorer.arc.io`) only sees onchain txs. Our Foskaay GGI Midchain 200 moves are NOT onchain txs - they are signed offchain messages stored in Vercel relay memory / Upstash. So normal explorer sees only 2 txs: handover + settlement. It cannot see individual moves, points, cards, dice.

That's intentional, same as MagicBlock ER explorer vs Solana base explorer.

**FoskaayGGIExplorer - our own explorer** indexes Foskaay GGI Midchain:

How it indexes:
1. Reads `FoskaayGGIHandover` event from Arc RPC `eth_getLogs` - gets sessionId, startHash, players, sessionKeys, gameLogic address, dev address
2. Reads `FoskaayGGISettled` event - gets finalHash, payer
3. Reads relay cache (Vercel `/api/moves?sessionId=`) which stores array of `{nonce, playerIndex, moveData, randomSeeds, prevHash, newHash, moveSig}` - all signed offchain
4. Verifies chain offchain: `H0 = startHash`, `H1 = keccak(H0, move1, seeds1)`, etc. Checks `ecrecover(moveSig) == sessionKeys[playerIndex]`
5. Displays tabs: Who Pays (sponsor + 0.001 USDC fee), Session (flexible players array), Randomness (how many seeds per move), Moves (hash chain green/red), Proof (if chain valid, finalHash matches settlement)

If relay is down, explorer still shows handover + settlement via events. Moves tab says "Relay unavailable, but finalHash verified via dual sigs". No secret backend - relay is untrusted cache, not source of truth.

---

### 0.2 Cost Models Explained - Unbatched vs Batched, Unoptimized vs Optimized

**Unbatch Unoptimized:**
- `handover` does `SSTORE` for session data: mapping sessionId => struct with players, sessionKeys, startHash (20k gas per SSTORE, 3-4 SSTOREs = 80k gas + 21k base = ~110k gas = 0.0022 USDC)
- `settle` does `SSTORE` finalHash + `SLOAD` to verify = ~85k gas = 0.0017 USDC
- Total = 195k gas = 0.0039 USDC = $3.90 / 1000 games
- Fails $1/1000 target. This is naive implementation.

**Unbatch Optimized:**
- `handover` does NO SSTORE, only `emit Handover(...)` event: 21k base + calldata 2k + event 375*3 + data ~3k = ~28k gas = 0.00056 USDC
- `settle` does NO SSTORE, only `ecrecover` x2 (3k each) + `emit Settled` = ~35k gas = 0.00070 USDC
- Total = 63k gas = 0.00126 USDC = $1.26 / 1000, with calldata compression + transient EIP-1153 = 50k gas = 0.001 USDC = $1.00 / 1000 exact
- **This hits target unbatched.** Data lives in events, not storage. Dispute requires caller to provide startHash + moves as calldata.

**Batched Unoptimized:**
- `handoverBatch(10)` loops 10 SSTOREs: 10*80k + overhead = ~850k gas = 0.017 USDC /10 = 0.0017 per game
- `settleBatch(10)` 10*85k = ~900k gas = 0.018 USDC /10 = 0.0018 per game
- Total = 0.0035 per game = $3.50 / 1000 - still fails, because SSTORE dominates

**Batched Optimized:**
- `handoverBatch(10)` emits 10 events in one tx: ~320k gas = 0.0064 USDC /10 = 0.00064 per game
- `settleBatch(10)` emits 10 events + 20 ecrecover = ~280k gas = 0.0056 USDC /10 = 0.00056 per game
- Total = 0.0012 per game = $1.20 / 1000, optimized with compressed calldata = 200k + 180k = 380k gas total = 0.0076 /10 = 0.00076 = **$0.76 / 1000** and with 20 batch = $0.40 / 1000

Target: Unbatched optimized = $1/1000, batched optimized = $0.30-$0.40/1000. That's your business margin.

---

### 0.3 Tech That Makes This Work Clearly

1. **EIP-712 SessionAuth:** `domain = {name: "Foskaay GGI", chainId: 5042, verifyingContract: FoskaayGGICore}`. Message `SessionAuth { sessionId, player, sessionKey, expiry }`. Player signs once with their real wallet (Metamask, Dynamic, etc - wallet agnostic). SDK gets `authSig`. After that, `ephemeralKey` (in-memory `ethers.Wallet`) signs all moves silently. No popup, no localStorage.

2. **Hash Chain Foskaay GGI Midchain:** `prevHash = startHash`, `newHash = keccak(prevHash, move.data, randomSeeds)`. Each moveSig = `sign(ephemeral, {sessionId, nonce, prevHash, newHash})`. FinalHash = last newHash. If any move tampered, chain breaks, `settle` with dual sigs fails because opponent won't sign broken finalHash.

3. **Generic Randomness:** Core pure `random(prevHash, nonce)` and `randomN(prevHash, nonce, count)` returns `bytes32` seed(s). Dev derives: dice = seed % 6 +1, card = seed % 52, shuffle = Fisher-Yates using seeds. Frontend calls via `eth_call` - free, shows animation while waiting, value from chain not JS. No duplicate logic.

4. **Event-Driven Gas Saving:** Use events not storage for happy path. `eth_getLogs` for explorer indexing. Dispute path uses storage only if needed, paid by disputer.

5. **Silent Final Sign:** FinalHash signed by same ephemeral keys silently in background when `isTerminal()` returns true. Player never sees "Sign final" button. Sponsor key in Vercel also auto-signs finalHash for bots. Both sigs needed for `settle`. Sponsor has no final say - if sponsor tries to force finalHash, human sig missing -> revert.

---

### 1. What Is THE Core Contract?

ONE contract: **FoskaayGGICore**

Deployed once by you on Arc. This is the business. It does 4 jobs only:

1. **Session handover** - Takes a game session from dev's game contract and puts it into gasless Foskaay GGI Midchain
2. **Fee collection** - Charges 0.001 USDC per session = $1/1000 unbatched
3. **Free randomness** - Provides generic random seed(s) via pure function, usable for dice, cards, shuffle, loot
4. **Verification** - Checks hash chain + silent session signatures. Reverts if tampered.

What Core does NOT do:
- No Ludo rules, no Chess rules, no Generals rules
- No max players limit, no 2-player or 4-player enforcement
- No dice-specific logic, no card-specific logic
- No storage of 200 moves, only startHash + finalHash via events

---

### 2. Randomness - Generic, Not Dice

Old design had `rollDice()` - that's opinionated. A card game needs random card, an idle game needs random loot, a PvP needs 0 random, a MMORG needs 5 random values.

Core provides generic seed, dev derives what they need.

```solidity
contract FoskaayGGICore {
    // Generic randomness - FREE via eth_call, lives in core, not frontend
    // Returns one seed
    function random(bytes32 prevHash, uint256 nonce) public pure returns (bytes32 seed) {
        seed = keccak256(abi.encode(prevHash, nonce));
    }

    // Returns N seeds - game might need 1, 2, or 5 random values
    function randomN(bytes32 prevHash, uint256 nonce, uint256 count) public pure returns (bytes32[] memory seeds) {
        seeds = new bytes32[](count);
        for(uint i=0; i<count; i++) {
            seeds[i] = keccak256(abi.encode(prevHash, nonce, i));
        }
    }

    // Helper: random in range [min, max]
    function randomRange(bytes32 prevHash, uint256 nonce, uint256 min, uint256 max) public pure returns (uint256) {
        return min + (uint256(keccak256(abi.encode(prevHash, nonce))) % (max - min + 1));
    }
}
```

**How dev uses it for any game:**
- Dice game: `seed = core.random(prevHash, nonce)` -> `dice = (uint256(seed) % 6) + 1`
- Card game: `seeds = core.randomN(prevHash, nonce, 5)` -> 5 random cards, each `cardId = uint256(seeds[i]) % 52`
- Idle game: `loot = core.randomRange(prevHash, nonce, 1, 100)`
- PvP chess: calls `random` with count 0, no randomness needed

Frontend flow:
1. Show animation (dice rolling, cards shuffling)
2. Call `core.random()` or `core.randomN()` via `eth_call` - free, no gas
3. Display result from chain, not from JS
4. Sign move silently with session key

No localStorage, no JS mirror. SM is only source of truth.

---

### 3. Players - Fully Configurable, Not Hardcoded

Core does NOT enforce 2 or 4 players. Dev sets any number.

```solidity
struct HandoverParams {
    address gameLogic; // dev's own game contract
    bytes32 startHash;
    address[] players; // dev decides: 1 player, 2 players, 4 players, 100 players for MMORG
    address[] sessionKeys; // same length as players, ephemeral keys
    bytes config; // dev's custom config
    bytes[] authSigs; // each player signed SessionAuth to authorize sessionKey - ONE popup per player
}

function handover(address gameLogic, bytes32 startHash, address[] calldata players, address[] calldata sessionKeys, bytes calldata config, bytes[] calldata authSigs) external returns (uint256 sessionId) {
    require(players.length == sessionKeys.length, "length mismatch");
    require(players.length > 0 && players.length <= 255, "1-255 players allowed"); // only limit is gas, not game logic
    // verify authSigs, collect fee, emit event
}
```

Examples:
- Single player idle: `players = [0xPlayer1]`, `sessionKeys = [ephemeral1]`
- PvP: `players = [0xP1, 0xP2]`, `sessionKeys = [eph1, eph2]`
- 4 player: `players = [0xP1, 0xP2, 0xP3, 0xP4]`
- MMORG: `players = [0xP1...0xP100]` - core accepts, gas scales via batching

Core doesn't care if it's 1 vs computer. For 1 vs computer, players = [human], sessionKeys = [humanEphemeral], and computers are simulated inside dev's gameLogic via `random()`.

---

### 4. How Core Remains Game Agnostic

Core interface for game logic:

```solidity
// IFoskaayGGI.sol - Dev implements this in their own contract
interface IFoskaayGGI {
    struct Move { uint8 playerIndex; bytes data; } // data is game-specific, core doesn't decode

    function getInitialState(bytes calldata params) external pure returns (bytes32 stateHash);
    function applyMove(bytes32 prevHash, Move calldata m, bytes32[] calldata randomSeeds) external pure returns (bytes32 newHash);
    function isTerminal(bytes32 stateHash) external pure returns (bool finished, uint8 winnerIndex);
    function onSettle(uint256 sessionId, bytes32 finalHash) external;
}
```

- `Move.data` is bytes - could be chess from/to, Ludo tokenId, card play, etc. Core doesn't parse.
- `randomSeeds` is array from `core.randomN()` - dev decides if they need 0,1,5 seeds. Core provides, dev uses.
- Core never calls `applyMove` in happy path. Only in dispute.

### 5. How Game Dev Builds and Delegates to Make Game Gasless

**Dev steps:**

1. Write `MyGame is IFoskaayGGI` - all rules, board, win condition live here. Deploy on Arc.

2. In Vercel backend holding `SPONSOR_PRIVATE_KEY`:
```js
import { FoskaayGGI } from 'foskaay/ggi-sdk'

// Player connects - wallet agnostic: Metamask, Dynamic, Privy, etc - SDK doesn't care
const ephemeral = foskaay.createEphemeralKey() // in-memory
const authSig = await playerWallet.signTypedData(SessionAuth) // ONE popup ever

const startHash = await myGame.getInitialState(params) // eth_call to dev's game

// DELEGATION - This makes it gasless
await foskaayGGICore.handover({
  gameLogic: myGame.address,
  startHash,
  players: [playerAddress], // or 2 or 4 or 100 - dev decides
  sessionKeys: [ephemeral.address],
  config: encodedConfig, // maxPlayers, timeout, randomCount needed per move
  authSigs: [authSig]
}) // Sponsor pays gas + 0.001 USDC fee, player pays 0
```

3. Foskaay GGI Midchain - 200 moves, 0 gas:
```js
// Each move:
const seeds = await foskaayGGICore.randomN(prevHash, nonce, 2) // eth_call, free, 2 random values needed for this game
const newHash = await myGame.applyMove(prevHash, move, seeds) // eth_call
const sig = await ephemeral.signMove({ sessionId, prevHash, newHash }) // silent, no popup
```

4. Settlement - Sponsor pays second tx:
```js
await foskaayGGICore.settle(sessionId, finalHash, [finalSig]) // silent final sig, no manual sign
```

**Fee:** `feePerSession = 1000` (0.001 USDC 6 decimals). Dev pays in handover. With batch 10, gas $0.40/1000 + fee $1/1000 = $1.40/1000 total, or optimized event-only = $1.00/1000 unbatched.

### 6. SDKs

**foskaay/ggi-contract-sdk:** ABIs for `FoskaayGGICore` + `IFoskaayGGI` base

**foskaay/ggi-sdk:**
- `createEphemeralKey()` - in-memory
- `createSessionAuth()` - one popup
- `random(prevHash, nonce)` / `randomN(prevHash, nonce, count)` / `randomRange()` - eth_call wrappers
- `signMove()` / `signFinal()` - silent
- `handover()`, `handoverBatch()`, `settle()`, `settleBatch()`

Wallet agnostic: SDK takes `playerAddress` as string, doesn't require specific wallet lib.

### 7. Explorer - FoskaayGGIExplorer

`explorer.foskaay.gg/session/{id}` - Reads Handover + Settled events from Arc RPC.

Tabs: Who Pays (sponsor + fee), Session (players array length flexible, sessionKeys), Randomness (how many seeds requested per move, values), Moves (hash chain verification), Proof (green if chain valid).

Data source: `eth_getLogs` for Handover/Settled + Vercel relay cache for Foskaay GGI Midchain moves. Relay is untrusted.

### 8. Demo - Check The Generals (PvP, not Ludo)

2 players, 5x5 board, no dice, uses `randomN` with count 0 (no randomness) or 1 for initial shuffle.

Deploy `FoskaayGGIGeneralsGame is IFoskaayGGI`, test core + SDKs + explorer.

Build steps: Foundry only, no thirdweb, no localStorage.

---

## 9. AGENT FINDINGS (2026-09-22) - the missing Foskaay GGI Midchain, in plain words

This section is appended below the original v5 guide and does not change anything above it. It records what the Generals port exposed and what we must add.

### 9.1 The missing link, in one sentence

The v5 guide already describes it: **a "Foskaay GGI Midchain" where moves are signed and hash-chained off-chain and executed by `eth_call` for free, with only two real transactions per match (handover and settle).** The current Foskaay GGI cores have the session and the settlement, but not this free Foskaay GGI Midchain. So the Generals port fell back to writing every move as its own Arc transaction, which is why it cost about 10 games/$1 instead of the promised about 1000.

Arc's own docs confirm what we get to use: Arc targets the **Osaka** hard fork, so **EIP-7702, EIP-1153 and deterministic instant finality** are all available. **EIP-4844 blobs are NOT** (type-3 transactions are rejected). That matters for the design below.

### 9.2 The EVM tools Arc gives us that we have not used yet

| Tech | What it is (plain) | Used now? | What it unlocks |
| --- | --- | --- | --- |
| `eth_call` free execution | Ask a contract to run a function without sending a transaction. Costs nothing. | Only for reads | The Foskaay GGI Midchain: run the game's `applyMove` rules for free, no tx per move |
| EIP-712 typed signatures | A wallet signs structured data; the contract recovers who signed | Partly (session keys) | One popup to authorise a session key, then silent move signatures |
| keccak256 hash chain | Each move's hash includes the previous hash | No | Tamper-evident move history, one final hash to settle |
| Events over storage + `eth_getLogs` | Emit logs instead of writing storage slots | Partly | Cheap on-chain handover/settle, the about $1/1000 target |
| EIP-1153 transient storage | Cheap scratch memory that clears after the tx | No | Cheaper settle verification |
| EIP-7702 set-code | An ordinary wallet can act as a smart account | No | Session-key accounts and sponsored ops, no new wallet for the player |
| ERC-4337 paymaster | A contract pays the user's gas | No | Sponsor pays user ops (moot once moves are free) |
| Deterministic instant finality | A transaction is final the moment it is included | No | Settle is instant, one confirmation |
| EIP-4844 blobs | Cheap bulk data | N/A | **Not available on Arc**, so not part of the plan |

### 9.3 Comparison: MagicBlock ER vs current Foskaay GGI vs Foskaay GGI + Foskaay GGI Midchain

| Question | MagicBlock ER (Solana) | Current Foskaay GGI (what we built) | Foskaay GGI + Foskaay GGI Midchain (the missing tech) |
| --- | --- | --- | --- |
| Where a move runs | Inside MagicBlock's ER validator | On Arc, as its own transaction | In the Foskaay GGI Midchain: `eth_call` runs the game's pure rules, free |
| Player pays per move | Nothing | Nothing | Nothing |
| Sponsor pays per move | Nothing | about 0.0021 USDC | Nothing |
| Sponsor pays per match | delegate + undelegate | every move + settle | **2 transactions only: handover + settle** |
| On-chain footprint | base account + ER state | every move | start hash, final hash, session, 2 events |
| What a public explorer sees | base txs only (ER invisible) | every move | 2 txs only (Foskaay GGI Midchain invisible) |
| Tamper protection | validator executes, base verifies on commit | the chain runs the rules | EIP-712 signatures + hash chain, chain verifies on settle/dispute |
| Infrastructure to run | a validator network | only a sponsor key | only a sponsor key + an untrusted cache |
| Source of truth | Solana base + ER proof | the game contract | on-chain start/final + the verifiable signed move chain |
| Rough games per $1 | their own pricing | about 10 | target about 1000 |

### 9.4 What this achieves (the three layers)

- **On-chain (truth):** the contract stores the session, the start hash and the final hash, and settles. Nothing can settle unless the signatures and the hash chain are valid. This is the MagicBlock "base chain" role.
- **Foskaay GGI Midchain (free play):** every move is a signed, hash-chained message run through the game's pure rules via `eth_call`. Free for the player **and** free for the sponsor, exactly like the ER's free execution. All the game concepts survive here because the payload is opaque: players, seats, moves, rewards, lives, timer, points are just data the game's rules read and write.
- **Off-chain (render only):** the frontend draws the board; Vercel holds the sponsor key and submits only the handover and settle transactions. Neither owns the truth.

### 9.5 Honest limits (so we do not overpromise)

1. The chain does not see moves live, only the two endpoints. A third party can still verify by replaying the signed moves. Mid-session reads come from the relay cache, which is untrusted.
2. Settle needs the players' final signatures. If a player vanishes, we need a timeout or forfeit rule (MagicBlock has turn clocks; we would need the same).
3. The game's rules must be expressible as a deterministic pure function for the dispute path (no external calls).
4. `PREVRANDAO` is always 0 on Arc, so randomness must come from the commit-reveal seed plus the hash chain, never the block.

### 9.6 Conclusion and next step

This is **not a new module**. `architecture.json` module `arcv2m18` already promises "FREE work inside a session: nothing is written to the chain during play, cost appears on OPEN and SETTLE only." The cores simply do not deliver that yet. The port exposed the gap; the Foskaay GGI Midchain is how we close it.

Next step: build the Foskaay GGI Midchain as a prototype on the Generals demo. Keep the board on-chain as the source of truth, move gameplay into signed `eth_call` moves with one handover and one settle, then measure the real cost against the current about 10 games/$1. No core contract change is needed for the prototype: the existing SessionRegistry (open/close/session keys), SessionState (`commitDigest`/`sealFinal`) and FeeVault already cover the on-chain endpoints. The Foskaay GGI Midchain lives in the game's own contract (pure rules) plus the client/SDK (signing and hash chain), so we keep the 4 core + 1 optional structure.

### 9.7 Measured result (Arc testnet, 2026-09-22)

The Foskaay GGI Midchain prototype is built and measured. `GeneralsMidchain` is a PURE rules engine (no storage); the client runs `applyMove` via `eth_call` and hash-chains the states; only session open, the game-state link and settle touch the chain. Every move is free for the player AND the sponsor, and the verifier replay PASSED (the signed move log replays to the same final hash).

| Mode | On-chain txs per match | Cost per match | Games per 1 USD |
| --- | --- | --- | --- |
| On-chain board port (before) | about 15 | 0.098172 USDC | about 10 |
| Foskaay GGI Midchain unbatched | 3 (open, setGameState, settle) | 0.012206 USDC | about 81 |
| Foskaay GGI Midchain batched (3 matches per window) | opens + 1 window flush | 0.009788 USDC | about 102 |

What this tells us:

- The Foskaay GGI Midchain removes the per-move cost completely (the big win): the on-chain-board port spent most of its 0.098 on per-move `command`, `tick` and `generate` transactions, and all of that is now free `eth_call` plus a signature.
- The remaining cost is the CORE's storage writes at open and settle, not the moves. The v5 target of about 1000 games per 1 USD needs an event-only handover/settle in the core (no SSTORE on the happy path, events for `eth_getLogs`) and/or larger batches. That is a future core change, kept separate so the 4 core + 1 optional stays stable for now.
- Files: `foskaay-ggi/demos/pvp/generals/GeneralsMidchain.sol`, `foskaay-ggi/test/GeneralsMidchain.t.sol`, `scripts/foskaay-ggi-midchain-match.mjs`, `foskaay-ggi/deployments/midchain-cost.json` and `midchain-cost-batched.json`.
- `GeneralsMidchain` deployed on Arc testnet: `0x67E2508459Ef1d786C93b30Df7FC922198b0D0b2`.

### 9.8 Event-only handover/settle TESTED (Arc testnet, 2026-09-22)

Section 9.7 showed the remaining cost is the CORE's storage writes at open and settle, not the moves. This section tests the v5 "event-driven cheap gas" answer: a prototype contract (`EventOnlyCore`) that EMITS a log instead of writing storage, and verifies the players' signatures at settle with `ecrecover`. It is a measurement prototype, NOT core, and it is not meant to ship as-is (no on-chain session state, no replay guard).

The moves are identical to the Foskaay GGI Midchain test (free `eth_call` + signatures). Only the two endpoints change. Measured:

| Approach | On-chain txs per match | Cost per match | Games per 1 USD |
| --- | --- | --- | --- |
| On-chain board port | about 15 | 0.098172 USDC | about 10 |
| Core-based Foskaay GGI Midchain (unbatched) | 3 | 0.012206 USDC | about 81 |
| Core-based Foskaay GGI Midchain (batched, 3/window) | opens + 1 flush | 0.009788 USDC | about 102 |
| **Event-only handover + settle (unbatched)** | **2** | **0.001709 USDC** | **about 585** |

Event-only detail: handover 0.000780 USDC (31,234 gas), settle 0.000929 USDC (37,160 gas). That is about 7x cheaper than the core-based Foskaay GGI Midchain and about 57x cheaper than the on-chain board port.

What this proves and what it costs:

- The event-only pattern is the path to the target. Unbatched gas is 0.0017 USDC per match; batching many handovers/settles into one transaction (the v5 `handoverBatch`/`settleBatch`) should bring it to about 0.0012 or below, i.e. around 830 to 1000+ games per 1 USD. That matches the v5 model and is the next test to run.
- The trade-off is honest and must be designed for: with no storage there is no on-chain `isLive`, no authority map and no replay guard, so the truth is the emitted event plus the signatures. A shipping core would keep a tiny amount of state (or a nullifier) to prevent replay, which adds a little gas but far less than the current full session struct.
- To make this the default for Foskaay GGI, the change is a NEW event-only handover/settle contract (or a UUPS logic upgrade of the core), plus the SDK gaining `handover`/`settle`/`signMove` helpers. That is a decision for the owner once the batched event-only number is measured.

Files: the first version, since renamed to `EventMidchainCore` (`foskaay-ggi/prototypes/EventMidchainCore.sol`, `foskaay-ggi/test/EventMidchainCore.t.sol`, `scripts/foskaay-ggi-eventmidchain-match.mjs`). The first contract was deployed at `0xB32353bBC6eD2E2b6292aFfaB9F71e81de47968c`. 147/147 forge tests pass.

### 9.9 The event-based Foskaay GGI Midchain, batched (owner-approved test, 2026-09-23)

NAMING: this is still the Foskaay GGI Midchain. "Foskaay GGI Midchain" means anything that is neither fully on the base chain nor offchain: play happens off the base chain but is cryptographically tied to it. The event-based form uses an EVENT instead of STORAGE. It is NOT "offchain". (The earlier `EventOnlyCore` prototype was renamed to `EventMidchainCore` so the name matches the idea.)

#### The link is solved naturally (no third transaction)

In the storage-based core, a session lives in `SessionRegistry` storage, so to tie the game's board to the session we called `setGameState` as a THIRD transaction. The event-based Foskaay GGI Midchain puts the link INSIDE the `Handover` event: it carries `sessionId`, `gameLogic` (the game's own contract), `startHash`, `players` and `sessionKeys`. So:
- the session and the game are bound in the SAME event and the SAME transaction, no separate link tx (2 txs per game, not 3);
- the Foskaay GGI explorer reads `Handover` and `Settled` with `eth_getLogs` and can index by `gameLogic` or `sessionId` directly;
- the start hash and the final hash are on-chain in those events, the final hash is signed by the players and checked on-chain with `ecrecover`, and the move log replays through the game's pure rules to that final hash. So the Foskaay GGI Midchain is tamper-proof, tied to the on-chain, and provable by anyone, not "trust me bro".

#### The cost ladder (measured on Arc testnet, 2026-09-23)

This is the pitch table: normal direct-to-onchain, then the storage-based Foskaay GGI Midchain, then the event-based Foskaay GGI Midchain, batched at 3, 5, 10 and 100 games per session.

| Approach | What happens | Txs per game | Cost per game | Games per 1 USD |
| --- | --- | --- | --- | --- |
| Direct to on-chain, no Foskaay GGI | Every move is its own transaction (most games run 60 to 100+ moves) | about 100 | about 0.2444 USDC | about 4 |
| Foskaay GGI storage-based Foskaay GGI Midchain, unbatched | open + link + settle per game | 3 | 0.012206 USDC | about 81 |
| Foskaay GGI storage-based Foskaay GGI Midchain, batched 3 | 3 games, one window flush | 3 + flush/3 | 0.009788 USDC | about 102 |
| Foskaay GGI storage-based Foskaay GGI Midchain, batched 5 | 5 games, one window flush | 3 + flush/5 | 0.009328 USDC | about 107 |
| Foskaay GGI storage-based Foskaay GGI Midchain, batched 10 | 10 games, one window flush | 3 + flush/10 | 0.008981 USDC | about 111 |
| Foskaay GGI storage-based Foskaay GGI Midchain, batched 100 (extrapolated) | per-game open still dominates | 3 + flush/100 | about 0.0088 USDC | about 113 |
| Foskaay GGI event-based Foskaay GGI Midchain, unbatched | handover + settle per game (link in the event) | 2 | 0.001712 USDC | about 584 |
| Foskaay GGI event-based Foskaay GGI Midchain, batched 3 | one handoverMany + one settleMany | 2/3 | 0.001098 USDC | about 910 |
| Foskaay GGI event-based Foskaay GGI Midchain, batched 5 | one handoverMany + one settleMany | 2/5 | 0.000939 USDC | about 1,064 |
| Foskaay GGI event-based Foskaay GGI Midchain, batched 10 | one handoverMany + one settleMany | 2/10 | 0.000820 USDC | about 1,219 |
| Foskaay GGI event-based Foskaay GGI Midchain, batched 100 | one handoverMany + one settleMany | 2/100 | 0.000713 USDC | about 1,403 |

Read it plainly:
- The direct-to-onchain row uses 100 moves because most games run 60 to 100+ moves. At the measured 0.00212 USDC per move plus about 0.032 USDC of board setup, that is about 0.2444 USDC per game, about 4 games per 1 USD. The Foskaay GGI Midchain cost does NOT change with move count, because every move is free, so 100 moves cost the same as 12. That is the saving: about 0.2444 USDC per game direct, versus 0.0017 to 0.0007 USDC on the Foskaay GGI Midchain.
- The storage-based Foskaay GGI Midchain cannot escape the per-game open cost (SSTORE), so batching it barely helps (102 to 113 games per 1 USD).
- The event-based Foskaay GGI Midchain removes that wall, so batching helps a lot. It crosses the v5 target of $1 per 1,000 games at just 5 games per batch, and reaches about 1,400 games per 1 USD at 100 per batch.

#### Unbatched vs batched, in plain words

- UNBATCHED means each game's handover and settle are sent to Arc as they happen (2 transactions). The result is on-chain immediately. Nothing waits.
- BATCHED means many games share ONE transaction: one `handoverMany` carries many games' handovers, and one `settleMany` carries many games' settlements. It is CHEAPER because the 21k transaction base fee is shared. The trade-off is that the on-chain event for a game lands when the batch transaction lands, so the DEV chooses the cadence (for example every few seconds, or when the batch is full). It is NOT a delay in gameplay: the moves are already signed and free, and the Foskaay GGI explorer can show the game from the signed move log immediately.
- A dev can pick either. Unbatched suits anything that needs an immediate on-chain result (competitive, escrow). Batched suits idle, casual and high-volume play. The rail imposes neither.

#### What the Foskaay GGI explorer shows, batched or not

- It reads `Handover` and `Settled` from Arc with `eth_getLogs`, and the signed move log from the relay cache (untrusted).
- It replays the moves through the game's pure rules and checks they hash to the on-chain final hash, and that each signature recovers to the declared player. Green means the Foskaay GGI Midchain is valid.
- In a batched session, each game still emits its OWN `Handover` and `Settled` event inside the batch transaction, so the explorer can show every game individually. A user does not need to trust that it "will go onchain": the events are on-chain, and the proof is the replay. The only thing they wait for is the batch transaction itself.

#### What has to change in the core and the SDKs (proposal, not built)

- CORE (no new address): add the event-based `handover` / `handoverMany` / `settle` / `settleMany` to the EXISTING core via a UUPS logic upgrade (same proxy address, append-only storage). The ONE new piece of state is a nullifier mapping (sessionId => settled) so a session cannot settle twice; it consumes from the `__gap`. Storage-based sessions stay as they are, so nothing is merged and no existing data moves. This needs the owner's explicit approval and an `architecture.json` update first.
- SDK (republish, no chain change): add `handover` / `handoverMany` / `settle` / `settleMany` / `signMove` / `verifyMidchain` helpers and the event-based ABIs. Bump `@foskaay/ggi-sdk` and `@foskaay/ggi-contracts-sdk`.
- BATCHING STAYS OPTIONAL: the dev chooses unbatched or batched; the rail never forces a cadence.

Files: `foskaay-ggi/prototypes/EventMidchainCore.sol`, `foskaay-ggi/test/EventMidchainCore.t.sol`, `scripts/foskaay-ggi-deploy-eventmidchain.mjs`, `scripts/foskaay-ggi-eventmidchain-match.mjs`, `scripts/foskaay-ggi-eventmidchain-batch.mjs`, `foskaay-ggi/deployments/eventmidchain-cost.json` and `eventmidchain-batch-cost.json`. `EventMidchainCore` deployed on Arc testnet: `0x197DE9813bd8cF668C8C26455329C629EE9Fc63e`. 148/148 forge tests pass.

### 9.10 PER-SESSION anchoring measured (the ridiculously cheap tier)

The 9.9 batch test anchored PER GAME (N handovers + N settles + 2N signatures), so it floors at about 1,400 games/$1. This section measures the OTHER design: anchor the SESSION, not each game. ONE handover for the whole session, play N games for free on the Foskaay GGI Midchain, then ONE settle carrying a single Merkle root over all N final hashes and just 2 signatures. On-chain work is O(1), so per game = cost / N and keeps dropping.

| Games in one session | Handover | Settle | Total | Per game | Games per 1 USD |
| --- | --- | --- | --- | --- | --- |
| 3 | 0.000782 | 0.000929 | 0.001711 | 0.000570 | 1,753 |
| 5 | 0.000782 | 0.000930 | 0.001712 | 0.000342 | 2,920 |
| 10 | 0.000782 | 0.000930 | 0.001712 | 0.000171 | 5,841 |
| 100 | 0.000782 | 0.000930 | 0.001712 | 0.000017 | **58,411** |

The handover and the settle stay FLAT no matter how many games are inside. That is the point: Arc only sees two transactions, and the games share them. The more games per session, the cheaper per game, without limit.

Why per-game batching (9.9) floors but per-session does not: per-game anchoring puts each game's payload and its 2 signatures on-chain (measured about 28,000 gas per game, irreducible), so it converges to about 0.0007 USDC per game. Per-session anchoring puts ONE root on-chain, so it converges to zero per game. Both are optional; a dev picks the tier.

### 9.11 Event-based Foskaay GGI Midchain added to the CORE (owner-approved, 2026-09-23)

The event-based Foskaay GGI Midchain functions are now in the live core, additively:
- `SessionRegistry` proxy (SAME address) `0x5165809149Be8A72c72EedBa6a13d57014Ba1bE5` upgraded to implementation `0x05D492C0Cc4e890131c163b302Ab20B56542D2B2`.
- New functions: `handover`, `handoverMany`, `settle`, `settleMany`, `midchainDigest`. New events: `Handover`, `MidchainSettled`.
- ADDITIVE ONLY: no storage change, no gap change, no version bump, no migration. Verified after the upgrade: `feeRecipient`, `operator`, `version`, `nonces`, `gameStateOf` all identical, and `midchainDigest` answers on the proxy.
- No nullifier (owner decision): the settle digest is deterministic and every settle needs valid player signatures, so a replay only re-emits an identical event and a different result is impossible. Keeping it stateless is what makes it cheap.
- Tests: `foskaay-ggi/test/SessionRegistryMidchain.t.sol` (7 tests). 155/155 forge tests pass.
- SDK helpers added (`handover`, `handoverMany`, `settleMidchain`, `settleMidchainMany`, `midchainDigest`, `signMidchain`, `verifyMidchain`) in `@foskaay/ggi-sdk`, versions bumped to 0.1.5. Republish + browser-bundle regeneration is the remaining step.

The three tiers, all optional, for the pitch: (1) per-game on-chain board about 10 games/$1; (2) per-game event Foskaay GGI Midchain floor about 1,400 games/$1; (3) per-session Foskaay GGI Midchain 58,000+ games/$1. Tier 3 is the headline: open once, everything inside is free, settle once.
