# Foskaay GGI on Arc: what it is and how game developers use it

**Quick answers (so the summary lands even if you stop here):**

1. **What is Foskaay GGI?** Foskaay Gasless Games Infrastructure. A game opens an on-chain session on Arc, everything inside the session (moves, dice, timers, point credits) runs free, and it settles once. Players never pay gas and never see a wallet popup. Your game contract stays the source of truth; the rail only provides the room.
2. **Is this on Arc mainnet?** Yes, and on testnet. Build and test on testnet for free, switch to mainnet when ready. Same contracts, same fee model.
3. **Is Foskaay GGI open source?** Yes. Contracts, relay, SDK and demo: https://github.com/solomonfoskaay/foskaay-ggi
4. **Is there a demo?** Yes. A live on-chain Ludo: https://foskaayggi.globalfolkgames.fun/demos/board/ludo/ (more demos coming).
5. **How do I integrate it into a new or existing game?** The SDKs are published on npm (`@foskaay/ggi-sdk`, `@foskaay/ggi-contracts-sdk`), so they install like any package. Docs quick start: https://foskaayggi.globalfolkgames.fun/docs/#quickstart plus a designing guide for gasless-shaped contracts.
6. **Can you help integrate my game?** Yes, via the hire page: https://foskaayggi.globalfolkgames.fun/hire/ (solo developer, limited slots, so book early).

---

**TL;DR**

- **What it is:** Foskaay Gasless Games Infrastructure (Foskaay GGI) lets a game run entirely free inside an Arc session and settle twice (connect + close), so a 200+ move match costs about 0.01 USDC all-in instead of 1 to 3 USDC paid move by move.
- **Who it's for:** game developers on Arc who want real on-chain play without gas per action, wallet popups per move, or a sponsor bill that scales with every move.
- **What you can do today:** play the live Ludo (mainnet or testnet), install the npm SDK, or read the docs. All live now.

---

**What it is**

Foskaay GGI is a gasless rail for Arc. You delegate your game contract (and a player account) into a session, play the whole match free inside, and settle once. Exactly two Arc transactions exist per game: connect (fee paid once in USDC) and close. A 200-move game costs the same as a 5-move game, because nothing inside the session is charged. Players hold no gas and sign nothing per move; session keys sign silently.

The midchain is not a sidechain, not a validator and not a separate RPC. Each move runs through your own pure contract logic via eth_call, is hash-chained and signed with session keys, and commits to the chain at settle. Anyone can replay a session and verify every move against the on-chain result, so the game stays provably fair and fully on-chain, just hundreds of times cheaper to play.

**Who it's for**

Game developers building on Arc (EVM). Also founders and studios tired of subsidizing per-transaction play, solo builders who want players to play free, and any Arc team that wants on-chain gameplay as an acquisition loop for a finance-led ecosystem.

**What you can do today**

- Play the live on-chain Ludo demo: https://foskaayggi.globalfolkgames.fun/demos/board/ludo/
- Install the SDK: `npm install @foskaay/ggi-sdk`
- Read the docs and designing guide: https://foskaayggi.globalfolkgames.fun/docs/#quickstart
- Browse the code: https://github.com/solomonfoskaay/foskaay-ggi

**How to use it**

Install the SDK, open a session on chain (one transaction, fee in USDC), run the whole game free through your own pure rules, then settle (one transaction). The SDK handles connect, settle, session keys, provable randomness and client-side session verification. See the docs quick start for the full flow, and the designing guide for shaping a contract to the two-account (game + player) pattern that is cheapest.

**Where to find it**

- Website: https://foskaayggi.globalfolkgames.fun/
- Docs: https://foskaayggi.globalfolkgames.fun/docs/
- GitHub Repo: https://github.com/solomonfoskaay/foskaay-ggi
- Live demo: https://foskaayggi.globalfolkgames.fun/demos/board/ludo/
- Pricing (measured numbers): https://foskaayggi.globalfolkgames.fun/pricing/
- SDK on npm: https://www.npmjs.com/package/@foskaay/ggi-sdk and https://www.npmjs.com/package/@foskaay/ggi-contracts-sdk

**Can you build against it?**

Yes. Open source, npm SDK, docs, and a relay mode you can run yourself. The demo is a real integration, not a mockup.

---

**What it does (in plain language)**

A normal 2-player Ludo is roughly 100 moves per player, over 200 moves plus dice per game. On Arc, each of those used to need a transaction, roughly 1 to 3 USDC per single game for whoever sponsors it. I built Foskaay GGI so the same game runs inside a session for free and settles twice. In testing, a full 2-player Ludo with 200+ moves cost about 0.01 USDC all-in, both transactions paid, which is roughly 80 to 100x cheaper. I have run 80+ games for about 1 USDC all-in, and the batching table on the pricing page goes further from there.

**Quickstart**

Shortest path to a working game:

```js
const ggi = new GgiClient({ network: 'mainnet' });       // or 'testnet'
await ggi.handoverWithAccounts({ ... });                  // connect: one tx, USDC fee
// play the whole match free through your pure contract (eth_call, no gas)
await ggi.settleGame(sessionId, [game], seats, tag);      // commit result + points
await ggi.settle({ ... });                                // close: one tx
```

Expected result: a session with exactly two on-chain transactions on Arc, a fully recorded board, committed points, and a verifiable seed reveal. Full code example and contract-shaping guide: https://foskaayggi.globalfolkgames.fun/docs/#quickstart

**Integration notes**

- **SDK:** `@foskaay/ggi-sdk` (TypeScript/JS, browser and Node) plus `@foskaay/ggi-contracts-sdk` for Solidity interfaces. Helpers cover connect, settle, session keys, pure rules and randomness.
- **Wallets/auth:** players sign in with an email-code embedded wallet (Dynamic), a session key is created silently, and every move signs in the background. No per-move wallet popup, no player gas.
- **Payments/USDC:** the fee is paid once at connect in USDC (the Arc gas token), so costs are stable and predictable in dollars.
- **Frameworks:** the browser SDK drops into Next.js/React/Node projects; the reference relay is a single API route, so it works with any host.
- **Indexing/analytics:** the Explorer reads Handover and Settled events straight from the chain via eth_getLogs; any indexer can watch the same events.
- **Verifiability:** `verifyMoveLog` replays a session client-side (hash chain, signatures, on-chain anchors), so a user can prove what happened without trusting a server.

**Security/limits**

- **Ready to launch vs experimental:** deployed and live on Arc mainnet + testnet; the SDK and docs are stable. More demo games and tooling are in progress.
- **Key management:** players use an embedded wallet with an ephemeral in-memory session key; the sponsor relay holds one key in its environment and never exposes it to clients. The relay has no per-move spend path; it only signs. Moves never create Arc transactions.
- **Known constraints:** an active mid-game session lives in the relay's signed log (an untrusted, verifiable cache). If the host restarts cold, a not-yet-settled mid-game session needs a fresh match; a settled session stays reviewable on-chain forever. The frontend uses no browser storage; the session URL is the handle.
- **Audit:** no third-party audit yet. The contracts are upgradeable (UUPS), so fixes never strand accounts, and the public test suite runs green.
- **Fees:** nothing is charged inside a session, ever. Connect and settle are the only Arc transactions; numbers are measured on testnet and published on the pricing page.

**Links**

- Website: https://foskaayggi.globalfolkgames.fun/
- Docs: https://foskaayggi.globalfolkgames.fun/docs/
- GitHub Repo: https://github.com/solomonfoskaay/foskaay-ggi
- Demo/screen recording: [paste the demo video embed link here, YouTube or Vimeo per the forum rules; the owner will post a short clip on X and link it here]

**Media**

1. Screenshot: [paste screenshot of the live Ludo board mid-game, moves running free]
2. Screenshot: [paste screenshot of the on-chain result after settle: committed game + points + the two transaction hashes]
3. Screenshot: [paste screenshot of the cost line showing ~0.01 USDC for a 200+ move match]
4. Screen recording (30-120s): [paste the setup-to-result recording: open the demo, play, settle, show the two on-chain transactions]

**Persona targeting**

- **Builders:** install the SDK, wire one route, and your first gasless match runs today; the demo is the reference.
- **Founders/PMs:** integration is hours, not weeks, and it turns per-move burn into a fixed ~0.01 USDC per match.
- **Infra/tooling:** it is open source behind upgradeable proxies, with events an indexer can follow and zero infrastructure to operate.
- **Community/educators:** the live Ludo is the easiest demo path, one link, no wallet needed, and every move is explainable on-chain.
- **End users:** play free, no wallet, no gas, no popups; the result is verifiable on chain.

**Two questions to drive replies**

1. What game stack are you building on today, and which feature would a gasless session unlock first for you: multiplayer, daily rewards, paid matches, or something else?
2. If you tried the demo or the SDK, what was the first blocker: contract shaping, auth, the cost numbers, or something I should document better?

*Built by a solo smart contract developer working in Solidity (EVM) and Rust (SVM). I will keep this thread updated as more demos and tooling land, so check back or reply with what you want built next.*