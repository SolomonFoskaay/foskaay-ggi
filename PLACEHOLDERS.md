Foskaay Gasless Games Infrastructure (Foskaay GGI) — build map

CORE is 4 unopinionated contracts and NOTHING else. No optional pattern is core.

src/SessionRegistry.sol        - CORE 1: open/close sessions; participant authorities; session keys (scope + expiry)
src/SessionState.sol           - CORE 2: accept signed session events; sequence numbers; digest
src/Randomness.sol             - CORE 3: commit-reveal seed(s); derive hash(seed, counter)
src/FeeVault.sol               - CORE 4: per-session fee collection; configurable destination
src/verifiers/                 - OPTIONAL: per-game verifier (the Ludo referee replays moves; decides a dispute)

NOT core, NOT in this contract set (OPTIONAL patterns a game may adopt, offered as examples only):
- Batched Settlement (Merkle root per window)
- Managed Accounts (PlayerCore-style, one account per player with slots)

test/                          - Foundry tests, written alongside each step
packages/sdk/                  - @foskaay/ggi-sdk (built once the contracts are stable)
packages/contracts/            - @foskaay/ggi-contracts-sdk (interfaces + deployed addresses)

CORE vs OPTIONAL, the two laws and the build order are in ../README.md
and ../../docs/globalfolkgames-bs-spec.md. Authoritative spec: architecture.json `arcv2m18`.
