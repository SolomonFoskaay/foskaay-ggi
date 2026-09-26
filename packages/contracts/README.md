# @foskaay/ggi-contracts-sdk

Solidity interfaces and the **published deployed addresses** for Foskaay Gasless
Games Infrastructure (Foskaay GGI), for any game that calls the rail directly from
its own contract.

Foskaay GGI is **two core contracts**, both upgradeable (UUPS) so logic can be
improved without ever moving an address or stranding an active session.

- Overview: **/foskaay-ggi/docs**
- The JS client that does the calls for you: `@foskaay/ggi-sdk`

---

## Interfaces

```solidity
import {ISessionRegistry, IFeeVault} from "@foskaay/ggi-contracts-sdk/src/IGgi.sol";
```

| Interface | Responsibility |
|---|---|
| `ISessionRegistry` | connect a session (paying the fee), settle the result, and free pure randomness |
| `IFeeVault` | the per-session fee; only the registry can deposit; owner withdraws |

There is nothing else. Randomness is a free pure function on the registry, and
batching needs no contract (one settle carries a session Merkle root).

---

## Deployed addresses (testnet and mainnet, same format)

```js
import { testnet, mainnet, forChain } from '@foskaay/ggi-contracts-sdk';

testnet.contracts.SessionRegistry;   // Arc Testnet  (chain id 5042002)
testnet.contracts.FeeVault;
mainnet.contracts.SessionRegistry;   // Arc Mainnet  (chain id 5042) - null until deployed
```

The full data lives in `deployments/addresses.json`, the single source of truth for
addresses; the JS SDK reads the same file, so the two can never disagree.

### Current status

| Network | Chain id | Status |
|---|---|---|
| Arc Testnet | 5042002 | Deployed |
| Arc Mainnet | 5042 | Not deployed yet (testnet first) |

---

## The fee is not optional, and not bypassable

`SessionRegistry.handover` is payable and forwards the fee to the `FeeVault` in the
same transaction, so a session cannot start unpaid. `settle` refuses unless the
`FeeVault` recorded the session as paid. The fee is native USDC (Arc's gas token),
so it is the cheapest possible collection and the receiving wallet still gets
normal, movable USDC.

---

## License

MIT
