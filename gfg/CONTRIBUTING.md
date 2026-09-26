# Contributing to GlobalFolkGames

Thank you for wanting to help. This is a real, live platform, not a sample
repo, so contributions are held to a production bar. Please read this whole
file before your first pull request.

## What this project is

GlobalFolkGames runs classic folk games in the browser with an on-chain,
gasless, provably-fair backend. Players sign in with email, never hold or pay
for crypto, and every dice roll is a verifiable on-chain roll. The platform is
a modular system: each game plugs into a universal result seam, and reward
modules subscribe to that seam. Adding a game means adding a game module; the
rest of the platform does not change.

## What contributing gives you

We are honest about this: **we do not promise any reward, payment, or
incentive.** There is no guaranteed bounty and no paid program.

What you do get is real:

- Deep, practical experience with Solana, the MagicBlock Ephemeral Rollup,
  gasless transactions, and ER VRF, on a live product, not a toy.
- A **public, verifiable record of your work**: commits and merged pull
  requests you can show for jobs, gigs, grants, and hackathons.
- A codebase you actually understand end to end after working on it.

If, later, a team or project reaches out to us asking for help building on
this stack, maintainers may recommend contributors who have a strong,
verifiable track record here. That depends entirely on a request arriving, and
on the contributor's own history. There is no program, no roster, and no
promise. If there is no request, nothing happens. Never count on it.

## Ground rules

1. **Do not break working games.** The games are live and playable. If your
   change touches game logic, prove it still plays before opening a PR.
2. **Surgical edits only.** Read the whole file first, change only the lines
   that need changing, and preserve everything else. Never rewrite a file to
   "clean it up."
3. **Module-first.** Every feature belongs to a module. Read
   `public/changelog/architecture.json` first and say which module your change
   belongs to. If it does not fit, it may need its own module.
4. **On-chain is the source of truth.** Rules that must not be bypassed are
   enforced on-chain or server-side with a secret. Never build a gate that only
   exists in browser JavaScript.
5. **No secrets, ever.** Never commit a private key, seed phrase, `.env`, API
   token, or keypair. Public keys and program ids are fine.
6. **No em dashes in user-facing text.** In any player-facing copy, README,
   page, or UI label, use parentheses, commas, "and", or full stops instead.
   This keeps the writing human. Code comments are exempt.
7. **Do not build ahead of a module's status.** Some modules are planned but
   not started. Check the architecture file before building.

## Working with an AI agent

This project ships a written brief for AI coding agents, [`AGENTS.md`](AGENTS.md),
plus focused rules under `.opencode/rules/`. They exist so a human or an agent
can continue the work safely, and they are the project brain when the original
author is unavailable.

- **You may use any AI agent** (Claude, Cursor, Copilot, opencode, and others).
  Point it at `AGENTS.md` before it writes anything.
- **Follow it strictly for contributions.** A pull request that ignores the
  module-first rule, the surgical-edit rule, or the no-secrets rule will be sent
  back. The brief is what keeps the platform from regressing.
- **Never let an agent commit a secret**, and never let it rewrite a
  source-of-truth file (`architecture.json`, `changelog.json`) wholesale.

A short starting prompt:

```text
Read AGENTS.md first. State which module the change belongs to before writing
code. Make surgical edits only. Never commit secrets. Run the build before you
finish.
```

## Getting started

```bash
npm install
npm run dev        # sponsor relay (:8787) + Vite (:3000)
```

Open http://localhost:3000. To test the real mobile sign-in flow, use
`npm run dev:tunnel` and open the printed HTTPS URL on your phone.

The on-chain program lives under `programs/`. Build and deploy notes are in the
README and in the program README.

## Pull request checklist

- The build is green (`npm run build`).
- Any changed script passes `node --check`.
- No secrets in the diff.
- The change is explained: what it does, which module it belongs to, and how
  you verified it.
- For game changes: a short description of how you confirmed play still works.

## Commit style

Use conventional commits: `feat(scope): summary`, `fix(scope): summary`,
`chore: summary`, `docs: summary`, `refactor(scope): summary`. Scope is the
module or area, for example `M3`, `ludo`, `relay`, `profile`.

## Questions and support

Everything about the live product, games, help, and contact lives on the site:

- https://globalfolkgames.fun
- https://globalfolkgames.fun/contact
