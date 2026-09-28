# @foskaay/ggi-sdk

Add **gasless play** to any on-chain game on Arc. Connect a session (one
transaction), play everything inside for free, settle once. Players never pay gas
and never see a wallet popup.

This package is the **Foskaay Gasless Games Infrastructure (Foskaay GGI)** client:
the one-line integration. Installing it is the whole setup; there is no fork and no
contract to copy.

- Overview: **/foskaay-ggi/docs**
- Addresses ship in `@foskaay/ggi-contracts-sdk`

---

## Install

```bash
npm install @foskaay/ggi-sdk viem
```

`viem` is a peer dependency, so it stays in your app where it already lives.

---

## Who pays what (read this first)

- **Players pay nothing.** Ever. No gas, no top-ups, no popups. There is no
  player-pay option in the rail at all, by design.
- **The game pays one small fixed fee per session**, taken at connect. It is in
  native USDC and read from the chain at runtime with `ggi.fee()`, never hardcoded.
- **The game operator (your sponsor/relayer) submits and pays the transactions.**
  The player's wallet is their identity and session-key authoriser, nothing more.
  A player with an empty wallet plays fine.
- **Nothing is sent to the chain during play.** Moves are signed with a session key
  and tied together locally. Only connect and settle are transactions.

---

## Quick start

```js
import { GgiClient } from '@foskaay/ggi-sdk';

// walletClient is your SPONSOR wallet: the one that pays the tiny fee and gas.
const ggi = new GgiClient({ network: 'testnet', walletClient });

// 1. CONNECT a session. This is one transaction; the fee is paid here.
const sessionId = '0x...';           // any unique id you choose
await ggi.handover({
  sessionId,
  gameLogic: myGameAddress,
  startHash,                          // your game's starting state hash
  seedCommit,                         // a randomness seed you committed (optional)
  players: [p0, p1],
  sessionKeys: [k0, k1],
  randomCount: 1,
});

// 2. PLAY for free. Each move: update your local state, hash it, and sign.
const key = ggi.createSessionKey();   // in-memory, no popup
// ... after each move compute finalHash, then:
const signature = await ggi.signMove(key, sessionId, finalHash);

// 3. SETTLE once. Every player signs the final hash (or a session Merkle root).
await ggi.settle({
  sessionId,
  finalHash,
  seedReveal,                          // reveals the committed seed
  sigs: [sig0, sig1],
  signers: [p0, p1],
});
```

`settleMany` connects/settles many sessions in one transaction so many games share
the cost (the cheapest shape: one connect + one settle for a whole session of
games).

---

## Free randomness

The registry exposes pure `random(seed, counter)` and `randomN(seed, counter, n)`.
They run through `eth_call`, so they cost nothing:

```js
const seed = await ggi.random(sessionSeed, moveNumber);
const dice = Number(seed % 6n) + 1;
```

Randomness is part of the room, exactly like moves, lives and timers, so it adds
no fee and no extra contract.

---

## In the browser (no bundler needed)

The package ships a ready browser bundle that exposes `window.GgiSdk`:

```html
<script src="https://cdn.jsdelivr.net/npm/@foskaay/ggi-sdk/dist/ggi-sdk.browser.js"></script>
<script>
  const { GgiClient } = window.GgiSdk;
</script>
```

Or with a bundler, import normally.

---

## What the client gives you

| Method | What it does |
|---|---|
| `handoverWithAccounts(cfg)` | connect + delegate your game/player accounts (recommended) |
| `handover(cfg)` | connect a session with the legacy single fee (one transaction) |
| `settle(cfg)` | close one session (verified signatures on-chain) |
| `settleMany(cfg)` | close many sessions in one transaction |
| `settleGame(sessionId, games, seatPlayers, gameTag)` | write the finished game(s) and credit the player |
| `encodeGame({turn,seats,step,board,over})` | build a game tuple for `settleGame` (game-agnostic) |
| `getInitialState` / `applyMove` / `hashState` | run your game's pure rules free via eth_call |
| `verifyMoveLog(sessionId, log)` | verify a signed move log (the midchain) client-side: chain continuity, every signature, and the on-chain anchors. Catch a tampered relay before it is rendered |
| `pointsOf(player, gameTag)` / `gameCount(sessionId)` / `playerGamesOf(sessionId, player)` | read the player points and the games (and per-player games) committed |
| `createSessionKey()` | fresh in-memory signer (silent moves, no popups) |
| `signMove(key, sessionId, finalHash)` | sign the exact digest the core checks |
| `random(seed, counter)` / `randomN(...)` | free randomness via eth_call |
| `feeBase()` / `feePerAccount()` / `feePerGame()` / `sessionFee(accounts, games)` | read the 3-part fee |
| `isPaid(sessionId)` | whether a session is paid |

### Networks

Foskaay GGI is deployed on **both Arc mainnet and Arc testnet**, with the same contracts and the same
fee model. Pick the network you want the client to talk to:

```js
const live = new GgiClient({ network: 'mainnet' }); // production
const dev  = new GgiClient({ network: 'testnet' }); // build + test, free to run
```

The default is `mainnet`. The addresses are always read from `@foskaay/ggi-contracts-sdk`, never
pasted into your code. The single source of truth is the site's
[Networks page](https://foskaayggi.globalfolkgames.fun/docs/#networks): if addresses ever change, you
update nothing in your game, just reinstall the package.

### How a session ends (read this)

A session does not close itself. Your game decides when a game is over, then you close it:

0. **The midchain rule: no per-move Arc transactions, ever.** During play every move is computed free via
   eth_call and hash-chained (`prevHash -> newHash`) and signed, and that signed log IS the midchain. The
   relay is only an untrusted cache. `connect` and `settle` are the ONLY Arc transactions per session. Do
   NOT write live state to Arc per move (no on-chain `recordLive`): that reintroduces a third fee per
   session. Verify other people's relays with `verifyMoveLog` before rendering anything.
1. `settleGame(sessionId, games, seatPlayers, gameTag)` records the game(s) on-chain and credits the
   player account in the same transaction. Call it when the match ends (unbatched) or when your batch
   is full (batched).
2. `settle(cfg)` closes the session on the core, verifying the players' signatures over the final hash.

Unbatched: `games: 1` at connect, then `settleGame([one])` + `settle` after the match.
Batched: `games: N` at connect, play N matches free, then ONE `settleGame([...N])` + ONE `settle`.
Batching only changes when the result lands on-chain, never how fast play is. Measured on Arc testnet:
3 games in one session, one `settleGame` wrote all 3 and credited 3x; only the per-game part of the
fee grew. Numbers live on the pricing page.

Everything else (boards, points, lives, timers) lives in **your** game contract,
never here: the rail never learns your game.

---

## License

MIT
