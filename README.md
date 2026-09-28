# Foskaay Gasless Games Infrastructure (Foskaay GGI)

Foskaay Gasless Games Infrastructure (Foskaay GGI) is an open rail that lets game developers make any
fully on-chain game gasless for its players on **Arc** (Circle's EVM L1 where USDC is the gas token).
It is the EVM equivalent of MagicBlock's Ephemeral Rollup on Solana: you delegate your game and player
contracts to a session, everything inside runs free through your own pure rules, and one settlement
closes it. Players never pay gas and never see a wallet popup.

**Live on Arc mainnet and Arc testnet.** The core, the demo game and the player account are deployed
on both; the SDK defaults to mainnet for real use and testnet stays for development and cost previews.

It is **not** a game. Ludo, chess, an idle game and an MMO are all the same to this rail: participants,
an opaque state model the game defines, pure rules that run free, and one settlement. The rail never
learns a game concept.

---

## The shape

- **One core contract: `FoskaayGGI`.** Connect a session (`handoverWithAccounts`), settle it
  (`settle`), and get free pure randomness (`random`/`randomN`). The fee is built in and forwarded to
  the destination in the same transaction, so a session cannot start unpaid.
- **Your game + player contracts are yours.** The rail is unopinionated: it takes a dev-declared
  account list of any size and never interprets them. The recommended two-account shape (one game, one
  player) is an offered example, not a rule.
- **Provable randomness, free.** Dice, cards and lootboxes derive from a committed seed through the
  core's pure `random`, revealed at settle. No extra contract, no extra fee.
- **Upgradeable.** Every contract is behind a UUPS proxy (OpenZeppelin), so addresses are permanent
  and a fix never strands data.

## The fee

One fee per session, charged once at connect, in USDC:

```
session base + per delegated account + per game
```

Nothing inside the session is charged. Measured numbers (Arc gas, games per 1 USDC, batching) live on
the single pricing page.

## Deployed addresses

Single source of truth (edit here, never in Vercel env):
`deployments/addresses.mjs`. The published `@foskaay/ggi-contracts-sdk` carries the same values for
both networks.

## Packages

- `@foskaay/ggi-sdk` — the client (`handoverWithAccounts`, `settle`, `settleGame`, `encodeGame`,
  `createSessionKey`, `signMove`, pure-rule reads, fee reads, `pointsOf`/`gameCount`).
- `@foskaay/ggi-contracts-sdk` — Solidity interfaces + deployed addresses.

Both are published to npm and verified from a clean install (connect, free dice, pure rules,
session-key signing, settle, points) like an outside developer.

## Docs and demos

- Home / docs / pricing / explorer / about / contact / hire: https://foskaayggi.globalfolkgames.fun
- Ludo demo: a working game on the rail, used to prove the SDK and the gasless promise end to end.
  The demo runs on Arc testnet so game developers can test for free; the contract set it runs is the
  same shape you integrate for your own game on mainnet.

## Layout

```
src/                 Solidity: the core (FoskaayGGI) - Foundry project
demos/               the Ludo demo game + player contracts and the page
deployments/         addresses.mjs (single source) + per-network records
web/                 the site's auth bootstrap (Dynamic email + EVM/Solana wallets)
public/              the site assets
packages/sdk/        @foskaay/ggi-sdk
packages/contracts/  @foskaay/ggi-contracts-sdk
api/                 the serverless relay (sponsor key signs; no game state)
gfg/                 reference copy of the GlobalFolkGames codebase (its own repo)
```

## Running

- `npm run build` — build the site (Vite).
- `forge test` — 48+ Foundry tests for the core and the demo game.

Keys never live in this repo: the sponsor/deployer key is read from
`~/.config/gfg/arc-sponsor.json` at deploy/runtime time only, and non-secret addresses live in
`deployments/addresses.mjs` so Vercel env only ever holds secrets.