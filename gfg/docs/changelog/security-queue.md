# Security notes and status

This file is a transparent security log for GlobalFolkGames. Everything here is
published on purpose: the project is open source, and honest notes help
contributors and auditors. There is no hidden secret in this repository. The
only thing that is ever private is key material (private keys, seed phrases),
which lives in local env files and deployment env, both gitignored.

If you find a security issue, please report it privately, see SECURITY.md.

---

## Current posture (what protects value)

- **On-chain authority.** Value-bearing writes are gated by the program, not by
  the browser. Premium points credit requires the account's stored
  `admin_authority` to sign. The signup bonus is fenced once per wallet
  on-chain. Lives and premium are enforced on-chain.
- **Fail-closed server gates.** The small serverless admin endpoints
  (premium credit/activate/cancel, affiliate writes, competition admin actions,
  premium tracker) require `GFG_OPERATOR_TOKEN` and deny a missing token. They
  do not depend on any database.
- **The chain is the source of truth.** There is no live database. A client
  cannot mint premium or bypass the lives gate by editing the front end: the
  program rejects it.
- **No secrets in the repo.** Verified across the full history: no private key,
  seed phrase, keypair, `.env`, or token was ever committed. A public key,
  program id, or admin wallet address is not a secret.

## Resolved or outdated (mostly the early off-chain Ludo era)

- **Client-fakeable match state / local roll values.** The early build was
  largely off-chain and those concerns were real for that build. The active
  game is on-chain: dice rolls resolve on the MagicBlock ER VRF, and the
  multiplayer board, turns, commits, and finish live on-chain. Rewards are
  gated on the on-chain proof roll, so a client cannot fabricate a win and mint
  rewards. New games follow the same fully on-chain arcv2 model.
- **Admin write bypass.** The operator token was previously optional, so a
  missing token was allowed and anyone could ask the relay to sign a premium
  credit. Fixed: the token is now required and a missing or wrong token is
  denied. See the current posture above.
- **Admin page gate.** The staff page gate remains a client-side UX
  convenience (a wallet-role hint). It is not, and never was, a value boundary:
  no secret and no write authority sit behind it now that the write endpoints
  are fail-closed and the chain enforces authority.

## Known and accepted (by design)

- **Solo presentation is client-rendered.** In single-player, some board state
  is drawn client-side for speed, but the reward is gated on the on-chain proof
  roll. Faking a local win does not produce a real reward.
- **AI seats are signed by the house.** A computer opponent must be signed by a
  server-side house key, because a client cannot be trusted to roll fairly for
  the AI. The house holds no player value and no game state.

## Future hardening (mainnet phase)

- **Server-side staff signed-nonce.** Replace the shared operator token with a
  server nonce the admin wallet signs, verified against a server-side admin
  list. This removes the last shared secret from the admin flow.
- **Owner-wallet on-chain admin authority.** Let the owner sign admin credits
  directly as gasless ER transactions, removing the operator endpoint entirely.
- **Free-allowance and anti-farming rails.** Server-metered daily allowance,
  refund-request signature checks, and funnel detection for multi-account
  minting. The chain stays authoritative; these are audit rails.
- **Reward randomization via ER VRF.** Any future random-reward feature must use
  the same on-chain VRF path so rewards cannot be predicted or pre-rolled.
