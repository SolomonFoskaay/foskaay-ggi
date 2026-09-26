# Genre: casual / hyper-casual / arcade / runner

**Status: PLANNED. No demo built yet.**

## Who this is for
Developers building hyper-casual, arcade, endless runner, match-3 or puzzle games — the genre of
Subway Surfers, Flappy Bird and Arc8 by GAMEE (a top-50 web3 game).

**The runner is a CASUAL / HYPER-CASUAL game.**

## Why Foskaay GGI fits
Casual games live on instant fun and short sessions, so any friction (gas, popups, wallet setup)
kills them. The rail gives zero gas, zero popups and no wallet setup, and the session still settles
once on-chain so the score is provable.

## Planned demo
`endless-runner` — a fast arcade runner with obstacles, coins and a score.

## Graphics source (important)
The owner forked `github.com/solomonfoskaay/rork-subway-surfers-clone`, a pure **web2 / iOS** clone.
We reuse **only the art and the game feel**, ported to a plain web canvas that runs in any mobile
browser. We do **not** inherit its architecture, and it is **not** a web3 project. No art budget
is needed because the graphics already exist.

## What it must prove
- A fast arcade loop is fully on-rail: randomness for obstacle/coin spawns from the committed seed.
- Score is the value rail, delivered without per-action cost.
- It plays in any mobile browser with no install, which is how a stranger will actually try it.

## Adapter surface (what a dev writes)
Roughly 50 lines: serialise the run result (score, distance, seed counter) into the session payload;
read the settled result. Nothing else.
