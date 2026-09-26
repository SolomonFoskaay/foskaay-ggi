# evm/ — Arc rail (arcv2m16)

Phase 0 scaffold for the Arc (Circle EVM) rail. Nothing here touches the live
Solana flow: it is a separate Foundry project that compiles and tests locally.

## What Phase 0 proves

The model, with no chain and no cost:

- `GameRegistry`: a game starts with a TTL deadline, settles once, and an
  abandoned game can be expired by anyone after the deadline. Batch roots let
  one transaction commit many games (the cost saver).
- `Randomness`: one seed is committed per batch and revealed later; every game
  roll is derived as `keccak256(seed, gameId, counter)`, so rolls cost nothing
  extra and are verifiable.

## Commands (local only)

```
cd evm
forge build
forge test
```

From the repo root: `npm run evm:build` and `npm run evm:test`.

## Not here yet (later phases)

Deploy + measured cost on Arc Testnet (Phase 1), the gasless relayer
(self-hosted, no paid sponsor plan), batching at scale and the per-game cost
table (Phase 3), and mainnet (Phase 5). No key material is ever stored here.

## Deployed on Arc Testnet (measured 2026-09-18, addresses updated 2026-09-21)

Active set (single source of truth: `public/arc-config.json`):

- PlayerCore:      `0x892CdbeD707425cdD3F0b0f9FE5428084E2FC730` (lives, points, premium, per-game buckets)
- MatchSettlement: `0x9171dd39f5ee581c240473080f0052c1652f0963` (per-match start commit + co-signed settle, arcv2m17)
- GameRegistry:    `0x19BbC0C9e71318cDa9ca03994380a73B1280b38a` (batch window / flush only)
- Randomness:      `0xb406295b4F7E5B513b656122AfFF29AF720E9E23`
- Chain 5042002, `https://rpc.testnet.arc.io`, gas 25 Gwei, USDC is gas.
- Deploy cost for BOTH Phase 1 contracts: about 0.023 USDC.

Superseded (kept for the record, never delete):

- GameRegistry (Phase 1): `0xC0d3c82994e31d8C97A589aCCd480B2Cf36311eb` (replaced 2026-09-19 by the turn-clock redeploy).
- PlayerCore (Phase 2):   `0xcebA2d46ea6d30BC32f6A6dC336c9b8adb3F56cc` (replaced by `0x892C...`; no balances orphaned).

Updated 2026-09-19 (on-chain turn clock + finish order, arcv2m1/2ii-2iii):
GameRegistry was redeployed (`0x19BbC0C9e71318cDa9ca03994380a73B1280b38a`)
with the turn clock, permissionless `expireTurn`, and `settleGameOrder`/
`resultOrder` (full 1st..Nth finish order). PlayerCore (points) is UNCHANGED,
so no player balance moved. Live proof: `node scripts/arc-phase2-clocks.mjs`.

Measured gas and cost per action (one real session, `node scripts/arc-phase1.mjs`):

| Action | Gas | USDC |
| --- | --- | --- |
| commitBatch (opens, 100 games in ONE tx) | 28,985 | 0.000724625 |
| openGame (single) | 97,153 | 0.002428825 |
| commitSeed | 46,041 | 0.001151025 |
| revealSeed | 48,554 | 0.00121385 |
| settleGame (single) | 50,506 | 0.00126265 |
| commitBatch (settles, 100 games in ONE tx) | 46,087 | 0.001152175 |
| a dice roll (derived from the revealed seed) | 0 (read) | 0 |

Batched per game (100 games sharing one open tx and one settle tx): about
**0.000019 USDC**, roughly **50,000 games per USDC**. Single (unbatched) game:
about 0.005 USDC. This confirms the batching design beats the 0.0001 USD/game
target by roughly 5x.

## Phase 2 — PlayerCore + sponsored (gasless) session, measured 2026-09-18

- PlayerCore (single per-player account): `0x892CdbeD707425cdD3F0b0f9FE5428084E2FC730`
  (admin = the self-hosted relayer `0xAd0A4348...86EB4`). Superseded Phase 2 address:
  `0xcebA2d46ea6d30BC32f6A6dC336c9b8adb3F56cc`.

Full game, sponsored by our own relayer (`node scripts/arc-relayer.mjs`):

| Action | Gas | USDC |
| --- | --- | --- |
| openGame (match starts, TTL) | 96,937 | 0.002423425 |
| commitSeed (dice locked) | 46,041 | 0.001151025 |
| chargeLife (one life) | 94,403 | 0.002360075 |
| revealSeed (dice revealed) | 48,554 | 0.001213850 |
| recordPoints (bucket + global) | 104,925 | 0.002623125 |
| settleGame (match ends) | 50,494 | 0.001262350 |
| **total per game (unbatched)** | | **0.011033850** |

The player signed nothing and paid nothing (balance unchanged). On-chain result
verified: life 1/5, bucket pure 100, global lifetime 100, roll derived from the
revealed seed.

Cost falls sharply with batching: the open and the settle become one tx for many
games (about 0.00002 USDC each per game), and the per-player writes cluster the
same way, so a batched game is roughly 0.0001 USDC or less.

## Phase 3 — batching at scale + TTL, measured 2026-09-18

One transaction commits a Merkle root for N games, so the gas is O(1) and the
per-game cost falls as 1/N (all at 25 Gwei):

| N games in one tx | Gas | Batch USDC | Per-game USDC |
| --- | --- | --- | --- |
| 1 | 28,985 | 0.000724625 | 0.00072463 |
| 20 | 28,985 | 0.000724625 | 0.00003623 |
| 100 | 28,985 | 0.000724625 | 0.00000725 |
| 1000 | 28,997 | 0.000724925 | 0.00000072 |

TTL/expire proven live: a game opened with a 2s TTL was expired permissionlessly
after the deadline (about 51,700 gas), and the settled `lastOpenRoot` was read
back on-chain.

Settlement policy: flush on N games OR T seconds, whichever first, and stay
per-game while volume is low. At 1000 games per flush a game is about
0.0000007 USDC, roughly 1.4 million games per USDC.
