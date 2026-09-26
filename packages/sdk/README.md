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
| `handover(cfg)` | connect a session and pay the fee (one transaction) |
| `handoverMany(cfg)` | connect many sessions in one transaction |
| `settle(cfg)` | settle one session (verified signatures on-chain) |
| `settleMany(cfg)` | settle many sessions in one transaction |
| `createSessionKey()` | fresh in-memory signer (silent moves, no popups) |
| `signMove(key, sessionId, finalHash)` | sign the exact digest the registry checks |
| `verifyMove(...)` | recover the signer of a move |
| `random(seed, counter)` / `randomN(...)` | free randomness via eth_call |
| `fee()` / `isPaid(sessionId)` | read the fee and whether a session is paid |

Everything else (boards, points, lives, timers) lives in **your** game contract,
never here: the rail never learns your game.

---

## License

MIT
