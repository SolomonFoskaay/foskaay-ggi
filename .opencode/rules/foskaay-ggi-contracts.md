# Foskaay GGI Contract Names — LOCKED (do not rename without owner approval)

This rule is auto-loaded every session. The owner has explicitly locked the
contract names. **NEVER rename, alias, or abbreviate these without the owner's
explicit approval in that turn.** Renaming without approval is a regression.

## Locked names (final)

| Role | File name | Solidity contract |
| --- | --- | --- |
| Core (session rail) | `foskaay-ggi/src/FoskaayGGI.sol` | `FoskaayGGI` |
| Game (all games) | `foskaay-ggi/demos/board/ludo/FoskaayGGIGames.sol` | `FoskaayGGIGames` |
| Player (points/lives/records) | `foskaay-ggi/demos/board/ludo/FoskaayGGIPlayers.sol` | `FoskaayGGIPlayers` |

Old names (`SessionRegistry`, `GGFLudo`, `GGFPlayer`, `FoskaayGGIDemoGames`,
`FoskaayGGIDemoPlayer`) are retired and were only ever scaffolds. Do not bring
them back.

## Rules that come with the names

- Every one of the three is deployed BEHIND a UUPS (OpenZeppelin) proxy and is
  upgradeable. After the first deploy, changes are UPGRADES only, never a new
  deployment (except a name-change-driven fresh deploy the owner approves).
- Storage is append-only (`version` + `__gap`); logic-only upgrades do not bump
  `version`; layout changes do.
- The core stays NON-OPINIONATED: it takes a dev-declared account list of ANY
  size and never learns game/player/points. Fee = base + per account + per game,
  charged at connect; nothing inside the Foskaay GGI Midchain is charged.

## Current addresses (updated by the deploy/upgrade scripts; keep in sync)

- `FoskaayGGI` core proxy: (set on fresh deploy)
- `FoskaayGGIGames` proxy: (set on fresh deploy)
- `FoskaayGGIPlayers` proxy: (set on fresh deploy)
