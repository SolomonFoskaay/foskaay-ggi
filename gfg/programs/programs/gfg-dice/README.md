# gfg-dice — MagicBlock VRF dice program

Provably-fair dice for GlobalFolkGames. A player requests verifiable randomness
from the MagicBlock VRF program (devnet base-layer queue); a verified oracle
fulfills the request and calls back into `callback_roll_dice`, storing two dice
values (`1..=6`) on the player's PDA.

The game client reads the PDA and uses those values for the roll.

## Status

**Deployed on Solana devnet.**

| Item            | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| Program ID      | `CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ`                        |
| Cluster         | `devnet` (base-layer VRF queue `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`) |
| Upgrade auth    | `~/.config/solana/id.json` (deployer wallet)                           |
| Client config   | `src/gfg-dice-config.js` + `src/gfg-dice-idl.json` (repo root)         |

## Requirements

| Tool    | Version | Install                                      |
| ------- | ------- | -------------------------------------------- |
| Solana  | 3.x     | https://docs.anza.xyz/cli/install            |
| Rust    | 1.8x    | https://rustup.rs                            |
| Anchor  | 1.0.x   | `cargo install --git https://github.com/solana-foundation/anchor avm --force` then `avm use 1.0.2` |

## Rebuild (after code changes)

```bash
cd programs            # Anchor workspace root (contains Anchor.toml)
anchor build
```

Artifacts land in `programs/target/deploy/` (`.so` + program keypair) and
`programs/target/idl/gfg_dice.json`. The `target/` dir is gitignored — the
program keypair must never be committed.

## Redeploy / upgrade

**Do NOT use `anchor deploy` or `anchor program deploy`** — they route through
the slow public devnet RPC (`devnet.rpcpool.com`) and frequently time out.
Use the Solana CLI directly with the Alchemy RPC (fast, dedicated endpoint):

```bash
cd /path/to/globalfolkgames
source .env  # loads GFG_DEVNET_RPC (Alchemy)
solana program deploy \
  programs/target/deploy/gfg_dice.so \
  --program-id programs/target/deploy/gfg_dice-keypair.json \
  --url "$GFG_DEVNET_RPC" \
  --skip-fee-check
```

For mainnet, swap `GFG_DEVNET_RPC` for the mainnet Alchemy/Helius/Quicknode
RPC in the env file — same command, same flow.

Keep the deployer wallet (`~/.config/solana/id.json`) and the program keypair
(`programs/target/deploy/gfg_dice-keypair.json`) backed up together. Losing both
means you cannot upgrade the program; you'd deploy a fresh program with a new ID.

If you want to bump the program ID, instead generate a new keypair and update
`declare_id!` in `src/lib.rs` + `[programs.devnet]` in `Anchor.toml`, then build
and deploy.

## Client note (important)

The program is built with **Anchor 1.x**, which emits the new "spec" IDL format.
The browser client MUST use the matching 1.x SDK — `@anchor-lang/core` (NOT the
old `@coral-xyz/anchor` 0.32 client, which crashes parsing spec IDLs).
`src/magicblock-vrf.js` imports `Program`/`AnchorProvider` from
`@anchor-lang/core` and constructs it as `new Program(idl, provider)` (the
program ID is read from `idl.address`, not passed separately).

`programs/` is not built by Vercel — the site only ships `src/`. The program ID
and IDL are already baked into `src/gfg-dice-config.js` + `src/gfg-dice-idl.json`.

## Note on the TWO_OF_TWO threshold

`request`'s `caller_seed` uses `client_seed` (1 byte) repeated across 32 bytes.
Keep `client_seed` unique per roll — it is the client-side entropy commitment
included in the VRF proof.

---

## Gasless model — MagicBlock Ephemeral Rollup (ER)

Players hold **0 SOL** by design. The app (a sponsor relay) pays the only two
base-layer transactions a player ever needs, on first roll:

1. `initialize` — creates the player's dice PDA (sponsor pays rent).
2. `delegate` — pins the PDA into an ER session on a devnet ER validator
   (sponsor pays the one-time session cost). Total onboarding ≈ 0.0013 SOL.

After delegation, every `roll_dice` runs **gasless on the ER** and VRF is free
(ER VRF queue). The player's session key signs; no wallet popup, no balance.

### ER key addresses (devnet)

| Item                  | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Delegation program    | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`                     |
| ER validator (US)     | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`                      |
| ER VRF queue (free)   | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`                     |
| Base VRF queue (paid) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`                     |
| ER RPC                | rotation registry in `src/gfg-rpc.js` (US `devnet-us.magicblock.app` / AS `devnet-as.magicblock.app` / EU `devnet-eu.magicblock.app`; CORS `*`, wss ok). Clients/relay/probe pick the best region per operation with exponential-backoff failover; a banned region is skipped until its cooldown expires. |
| Magic program         | `Magic11111111111111111111111111111111111111`                       |
| Magic context         | `MagicContext1111111111111111111111111111111`                       |

Take the ER RPC URL **with a trailing slash** — some clients 404 without it.

Base-layer rolls via the paid queue (0.0005–0.0008 SOL) remain as a fallback if
the ER validator is unreachable.

## PDA schema & delegation

- Seed: `[b"gfgplayerd", player_authority.key()]` — keyed to the **player's
  wallet**, NOT the payer, so any sponsor can fund it.
- `delegate` passes the ER validator as a remaining account; the delegation
  program pins the PDA to that validator for the session.

## Sponsor relay

`scripts/delegate-relay.mjs` exports `handleDelegate(playerPubkey)`, which is
idempotent: if the PDA's owner already equals the delegation program
(`info.owner.equals(DELEGATION_PROGRAM)`) it returns `{ delegated: true,
steps: [] }` immediately; otherwise it runs `initialize` (+ `delegate`) and
returns the signatures. Runs locally as `relay-server.mjs` on `:8787` (Vite
proxies `/api` → it) and as the Vercel function `api/delegate.mjs` in prod.

Gotchas (fixed):

- Compare `PublicKey`s with `.equals()`, never `string === publicKeyObject`.
  `info.owner.toBase58() === DELEGATION_PROGRAM` was silently false and caused
  the relay to re-delegate every roll.
- The public devnet RPC intermittently returns `null` for existing accounts, so
  the relay retries the account read before deciding the PDA is missing.

## Instructions

`initialize, delegate, roll_dice, callback_roll_dice, undelegate, commit,
process_undelegation`.
