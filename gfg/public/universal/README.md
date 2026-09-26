# GlobalFolkGames — Universal modules

The **platform side** of the plug-and-play contract bus. Every game (M1) emits
one envelope when it completes; the universal modules here (M2+) receive it.
A game NEVER knows how points, tiers or competitions work: it just calls
`window.publishGameResult(...)` and its job is done. 50 games = one reward
plug, one competition plug.

```
public/universal/
├── result-seam/      M2  the bus itself (game-result.js + the envelope spec)
├── points/           M3  local per-game points (PURE, proof-of-play gated)
├── ledgers/          M4  global ledgers (pure / lifetime / spendable)
├── subscription/     M5  Active Tier subscription (powers the multiplier)
├── point-sources/    M6  referral / giveaway / signup / social earn
├── competitions/     M7  game-agnostic competitions (earn events)
├── escrow/           M8  optional sponsor escrow plugin (brand prize pools)
└── multiplayer/      M12 standalone  FREE multiplayer RAIL (match codes,
                                     gasless ER moves, clocks, finish; AGM
                                     plugs money on later, game never changes)
```

## How a game plugs in (the only contract games need)

A game ends by emitting the canonical envelope:

```js
window.publishGameResult({
    gameId: 'ludo',
    players: [
        { seat: 'green', actor: 'user', position: 1 },
        { seat: 'yellow', actor: 'house', position: 2 },
    ],
    proof: { method: 'magicblock-vrf', chain: 'solana-devnet', signature: '...' },
});
```

The bus (`result-seam/game-result.js`) validates/normalizes into the
`gfg:game-result@1` envelope and fans it out to every subscriber.

## How a universal module plugs in

Every module that reacts to a finished game subscribes once at boot:

```js
window.onGameResult(function (result) {
    // handle the verified finish; never read game internals
});
```

Modules stay interchangeable and game-agnostic. Each folder below documents
its module's contract, its current status, and what the next build does there.
The single source of truth for module status is `public/changelog/architecture.json`.