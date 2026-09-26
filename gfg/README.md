<div align="center">

# GlobalFolkGames

**Playable, production on-chain folk games with a web2 feel.**
No wallet popups. No gas for players. Provably fair on-chain dice.

[**Play now at globalfolkgames.fun**](https://globalfolkgames.fun) ·
[All games](https://globalfolkgames.fun/games) ·
[Academy](https://globalfolkgames.fun/academy) ·
[Game economy](https://globalfolkgames.fun/economy) ·
[Donate](https://globalfolkgames.fun/donate)

![live](https://img.shields.io/badge/status-live%20in%20production-2ecc71)
![chain](https://img.shields.io/badge/Solana-devnet-9945FF)
![gasless](https://img.shields.io/badge/MagicBlock%20ER-gasless-f39c12)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

> This is **not** an example repo or a demo. It is the real code behind a live,
> playable, multi-game on-chain platform. You can play it at
> [globalfolkgames.fun](https://globalfolkgames.fun) right now. The repository
> is open so other builders can learn from it and ship faster.

---

## What this is

GlobalFolkGames runs classic folk games in the browser with an on-chain,
gasless, provably-fair backend. Players sign in with an email, never hold or
pay for crypto, and every dice roll is a verifiable on-chain roll. Behind the
simple web2 experience, the game state, results, and rewards live on Solana and
the MagicBlock Ephemeral Rollup.

It exists for two reasons:

1. **Preserve folk games from around the world on-chain**, with transparent
   rules and a record nobody can quietly edit.
2. **Be the reference for building web3 games that keep the web2 audience.**
   The huge market is the 99% of gamers who are not in web3 yet. This platform
   shows how to serve them without wallet friction, while still getting the
   real benefits of on-chain: transparency and verifiable fairness.

## Why this repo is useful to you

- **Web2 game developers** learning how to add web3 rails without ruining the
  feel of their game.
- **Web3 developers** who want a genuinely playable game with web2 onboarding,
  not a token demo.
- **Students, colleges, and hackathon teams** who want a real, working Solana
  project to fork, learn from, and build on.

## The core innovation

- **Gasless by construction.** Players never pay a fee and never sign a popup
  mid-game. One-time account setup is sponsored by the platform, and all
  gameplay runs free on the MagicBlock Ephemeral Rollup.
- **Provably fair dice.** Rolls come from on-chain VRF randomness, not the
  browser. Anyone can verify them.
- **A universal result seam.** Every game ends by publishing a single result
  envelope. Reward modules subscribe to it. Adding a game does not require
  rewiring the platform: 50 games share one reward system.
- **One platform, many games.** Games, points, ledgers, subscriptions,
  competitions, and lives are separate modules that plug into the same seams.

Read the thinking behind the design on the live site and in
[`public/changelog/architecture.json`](public/changelog/architecture.json).

## The novel part: gamers earn the way creators do

This is the idea we are pioneering, and it is worth calling out on its own.

Creators get paid by the platforms they create on. Musicians, writers, and
streamers all have a way to earn from the platforms that host them. **Gamers
never had the same deal.** If you are simply good at the games your family
actually plays, almost nobody built a home for that.

GlobalFolkGames does. Each month, **30 percent of every premium membership goes
back to the gamers who join that month's Member Cup and clear the qualification
line.** The players on paid plans fund the share, not other players. You never
stake anything on a match. The person across the board is not paying your prize.

Why this matters, and why it is sustainable:

- **It is funded by revenue, not by a token.** Payouts are a share of
  subscriptions that were actually collected that month. There is no token to
  print, no fixed payout the platform has to cover, and no death spiral.
- **It grows with the platform.** More members means a bigger monthly share,
  and it grows without anyone rewriting the rules.
- **No one is forced to grind.** If there are no paid members, there is no
  pressure to give out play-to-earn money. The games stay fun first.
- **It is public and on-chain.** The pool, the winners, their final points, and
  the payout status are shown on the site.

This is a deliberate contrast to play-to-earn and to betting: it treats gamers
the way a creator platform treats paying members, but points it at gameplay.

Read the full explanation and the current cup at
[globalfolkgames.fun/competitions](https://globalfolkgames.fun/competitions),
and the reasoning at
[globalfolkgames.fun/economy](https://globalfolkgames.fun/economy).

## Current games

| Game | Status | Play |
| --- | --- | --- |
| Ludo | Live, fully playable, on-chain multiplayer | https://globalfolkgames.fun/games |
| More folk games | Added over time | https://globalfolkgames.fun/games |

The canonical, always up to date games list lives on the site:
[globalfolkgames.fun/games](https://globalfolkgames.fun/games).

## Tech stack

- **Solana** program written with **Anchor** (`programs/programs/gfg-dice`).
- **MagicBlock Ephemeral Rollup** for gasless execution and **ER VRF** for
  provably fair dice.
- **Vite** front end, plain HTML/CSS/JS, mobile first.
- **Node** sponsor relay and small serverless endpoints on **Vercel**.
- **Dynamic** embedded wallet for email sign in and silent session-key signing.

There is **no live database**. The chain is the source of truth. The only
server is the small relay that sponsors one-time setup and signs house moves.

## Run it locally

```bash
npm install
npm run dev
```

This starts the sponsor relay on `:8787` and the app on `:3000`. Open
http://localhost:3000.

For real mobile sign in (phones only expose the needed crypto APIs on HTTPS),
use a tunnel:

```bash
npm run dev:tunnel
```

Open the printed HTTPS URL on your phone.

### Build and deploy the program

```bash
cd programs && anchor build
cp programs/target/idl/gfg_dice.json src/gfg-dice-idl.json
source .env && solana program deploy programs/target/deploy/gfg_dice.so \
  --program-id programs/target/deploy/gfg_dice-keypair.json \
  --url "$GFG_DEVNET_RPC" --skip-fee-check
```

Copy `.env.example` to `.env` and fill it in. Never commit `.env`. See
[SECURITY.md](SECURITY.md).

## Learn to build this: the Academy

The [Academy](https://globalfolkgames.fun/academy) is a hands-on, mobile-first
course that takes you from web2 game basics to a deployed, gasless, verifiable
on-chain game, using this exact codebase. It is chain agnostic in shape, with
Solana (SVM) active today and an EVM track as a placeholder for later.

It includes interactive lessons, finish-the-code exercises with instant
feedback, a guided tour of the Ludo repo, and a final fork-and-deploy path.
The [game economy](https://globalfolkgames.fun/economy) lesson explains why
token and NFT funded games fail, and the subscription model that survives.

## The game economy in one paragraph

A token sale or an NFT drop brings money once. Servers, gasless sponsorship,
hosting, and new content cost money every month. When the one-time money runs
out, the game stops, and play-to-earn makes it worse by adding sell pressure.
GlobalFolkGames uses the proven web2 model instead: monthly memberships with
levels and benefits. The earn feature is funded from a share of subscription
revenue, so prizes always come from money actually earned. No token and no NFT
as the main way in. Read the full explanation at
[globalfolkgames.fun/economy](https://globalfolkgames.fun/economy).

## Built with AI agents, and they can continue it

The whole project carries a written brief for AI coding agents:
[`AGENTS.md`](AGENTS.md). It is the project brain. It records what the project
is, the terminology, the module system, the hard rules, the build and deploy
commands, and the current state, so a human **or an agent** can pick the work up
even if the original local folder is gone. That is deliberate: it means the
project can survive its author being away, on a new machine, or handing it to
contributors.

- **Cloners and learners**: keep `AGENTS.md` and `.opencode/rules/`, or copy
  them into your fork and tweak the names. Point your own AI agent at the file
  and it will follow the same architecture and safety rules instead of guessing.
  It works with any agent that can read files in the repo.
- **Contributors**: follow `AGENTS.md` strictly. It is what keeps pull requests
  mergeable. The module-first rule, the surgical-edit rule, and the no-secrets
  rule are not suggestions.

A short starting prompt for any agent:

```text
Read AGENTS.md first. State which module the change belongs to before writing
code. Make surgical edits only. Never commit secrets. Run the build before you
finish.
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md)
first, and follow the module-first rule and the surgical edit rule.

Be clear about what contributing gives you: **no promised reward or payment**.
You get real, deep experience with Solana and the MagicBlock ER on a live
product, and a **public, verifiable record of your work** (your commits and
merged pull requests) that you can show for jobs, gigs, grants, and
hackathons. If a team later asks us for help on this stack, maintainers may
recommend contributors with a strong track record here. That depends entirely
on a request arriving, and there is no program or promise behind it.

## Security

Do not open a public issue for a security problem. Report it privately via
[globalfolkgames.fun/contact](https://globalfolkgames.fun/contact). See
[SECURITY.md](SECURITY.md). Never commit a private key, seed phrase, `.env`,
or keypair. Public keys and program ids are not secrets.

## Community and support

- Live platform: https://globalfolkgames.fun
- Contact and Discord: https://globalfolkgames.fun/contact
- Forum: https://globalfolkgames.fun/forum
- All games: https://globalfolkgames.fun/games

If this project is useful to you, please star the repo, share it, and tell a
friend. That is free and it helps enormously.

## Donate

GlobalFolkGames is free to play and open source. Donations of any amount keep
the games free and help add more folk games from around the world. Donations
are appreciated and they are gifts, not an investment, with no promised return.

- Donate any amount (SOL or USDC on Solana):
  [globalfolkgames.fun/donate](https://globalfolkgames.fun/donate)
- Want lifetime access: that is the limited
  [Early Backer collection](https://globalfolkgames.fun/backers), which also
  funds the move to Mainnet.

We do not promise earnings, rewards, or financial returns of any kind.

## License

[MIT](LICENSE). Build something great with it.
