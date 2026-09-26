# Security Policy

GlobalFolkGames is a production, live on-chain game platform. We take security
seriously and we welcome responsible disclosure.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Instead, report it
privately through the live site contact page:

- https://globalfolkgames.fun/contact

Include a clear description, steps to reproduce, and the impact. We will
acknowledge your report and work on a fix. Please give us reasonable time to
ship the fix before any public discussion.

## What we never put in the repo

- Private keys, seed phrases, or keypair JSON files.
- `.env` contents or any server secret.
- API tokens or service credentials.

A public key, a program id, or an admin wallet **address** is not a secret.
Access requires the private key, which never lives in this repository. Secrets
live only in local env files or the deployment platform environment, both of
which are gitignored.

## Design principle

Anything that must not be bypassed is enforced **on-chain** (accounts, PDAs,
authority checks) or **server-side** with a secret the client never sees. We do
not treat browser JavaScript as a security boundary. If you find a gate that is
enforced only in the client, that is a bug and we want to know.
