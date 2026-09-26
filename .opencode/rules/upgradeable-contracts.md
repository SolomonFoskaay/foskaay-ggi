# Upgradeable Contracts — HARD RULE (do not skip, ever)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE. The owner has
repeatedly been burned by non-upgradeable contracts, so the default is now fixed.

## The rule

**NEVER build a smart contract for the owner that is NOT upgradeable, except if
the owner explicitly says so in that turn.** Games need consistent updating;
accounts must never be stranded and addresses must never keep changing.

- Every contract we ship (core AND games AND any player/points/state contract)
  MUST be deployed BEHIND an upgradeable proxy:
  - **OpenZeppelin UUPS** (`UUPSUpgradeable` + `Initializable` + `OwnableUpgradeable`),
    exactly like `foskaay-ggi/src/SessionRegistry.sol`.
  - The proxy address is PERMANENT. Upgrades swap the logic behind it and never
    move the address or strand data.
  - `initialize()` replaces the constructor (re-init guarded); the implementation
    is `_disableInitializers()` so it can never be used directly.
  - Include a `version` marker and a reserved `__gap` (append-only storage).
- Even a contract with no state today (e.g. a pure game) still goes behind a
  UUPS proxy, so its ADDRESS is permanent and its logic can change later.
- NEVER deploy a bare (non-proxied) contract as the final artifact. A bare
  contract is only acceptable as the IMPLEMENTATION behind a proxy.

## Storage safety (append-only)

- Never reorder, rename, or remove a state variable or a function-obvious slot.
  New variables consume from the top of `__gap`; the gap shrinks by the same
  count. A reorder reads live data as garbage.
- Logic-only upgrades must NOT bump `version`; layout changes MUST.
- ALWAYS test upgrade safety before any deploy: an upgrade keeps the proxy
  address and preserves data (see `foskaay-ggi/test/UpgradeSafety.t.sol`).

## Reporting after an upgrade

State plainly to the owner: (a) the proxy address unchanged, (b) that live data
was checked to still read correctly, (c) the tx, (d) the new logic summary.
Silence after an upgrade is not acceptable.

## Deploy order

program (implementation + proxy) -> regenerate addresses/ABI -> server
(relay/probe/api) -> client -> pages/docs. Update EVERY reference (relay,
explorer, demo pages, docs, deployments record, SDK address data) in the same
change so no page points at a dead address.

## Exceptions

Only when the owner explicitly says, in that turn, "this one can be
non-upgradeable" (for example a throwaway test). Absent that, upgradeable is
mandatory.
