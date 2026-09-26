# Publishing @foskaay packages to npm: a beginner's guide

This is a step by step guide for publishing the Foskaay GGI packages for the
first time. It is written for someone who has only ever installed packages, never
published one. Follow it in order.

There are two packages:

- `@foskaay/ggi-sdk` (the client, in `foskaay-ggi/packages/sdk`)
- `@foskaay/ggi-contracts-sdk` (interfaces + addresses, in `foskaay-ggi/packages/contracts`)

---

## 1. The five things you need

1. **A free npm account** at https://www.npmjs.com/signup
2. **Two-factor authentication (2FA)** enabled on that account (npm requires it
   for publishing; use an authenticator app, not SMS).
3. **The `@foskaay` scope claimed.** A *scope* is the `@name/` part. A scope can
   be free as long as you plan to make the packages public. You claim it by
   creating an **organization** named `foskaay` (free plan), or by publishing a
   first public package under that scope.
4. **Node and npm installed** (you already have these for this repo).
5. **Logged in on the machine:** run `npm login` once and complete the browser
   prompt.

Check you are logged in:

```bash
npm whoami
```

---

## 2. Before your FIRST publish (do these once)

### 2.1 Check the package name is free

```bash
npm view @foskaay/ggi-sdk
npm view @foskaay/ggi-contracts-sdk
```

If both say something like `404 Not Found`, the names are free. If a package
already exists with your name, stop and pick another name; **you can never
un-publish a name onto someone else's package.**

### 2.2 Check what will actually be uploaded

This is the most important safety habit. It shows you the exact file list npm
will put on the internet:

```bash
cd foskaay-ggi/packages/sdk
npm pack --dry-run

cd ../contracts
npm pack --dry-run
```

Read that list. It must contain ONLY source, README and the `deployments` folder.
If you ever see a `.env`, a key file, a `.pem`, or anything with a secret, STOP
and fix `files` in `package.json` before going further.

**Do's and don'ts for what goes in a package:**

- DO keep the package small: only the code a consumer needs.
- DO keep a clear README (it becomes the package page).
- DON'T include secrets, `.env`, private keys, tokens or local machine paths.
- DON'T include build caches, test fixtures with real credentials, or internal
  notes. `files` in `package.json` is an allow-list, which is safer than a
  block-list. Both packages already use `files`.

### 2.3 Bump the version correctly

Versions follow `MAJOR.MINOR.PATCH` (for example `0.1.0`).

- `0.1.0` onward is fine while the product is new and may change.
- A fix: `npm version patch` (0.1.0 -> 0.1.1)
- A backward-compatible addition: `npm version minor` (0.1.0 -> 0.2.0)
- A breaking change: `npm version major` (0.1.0 -> 1.0.0)

**A published version is permanent.** You can never replace the contents of a
version. If you make a mistake, you publish the NEXT version (for example 0.1.1)
and, if needed, deprecate the bad one (see section 6).

---

## 3. Publish

Do the contracts first, because the SDK reads from it.

```bash
cd foskaay-ggi/packages/contracts
npm publish --access public

cd ../sdk
npm publish --access public
```

`--access public` is required for a scoped package (`@foskaay/...`). Without it,
npm assumes a private package and refuses on a free plan.

The first publish claims the `@foskaay` scope publicly. From then on, anyone can
`npm install @foskaay/ggi-sdk`.

---

## 4. Verify it really works, like a stranger would

Never trust the publish; test the install in a clean folder:

```bash
mkdir /tmp/ggi-check && cd /tmp/ggi-check
npm init -y
npm install @foskaay/ggi-sdk @foskaay/ggi-contracts-sdk viem
node -e "const {testnet} = require('@foskaay/ggi-contracts-sdk'); console.log(testnet.contracts.FoskaayGGI)"
```

If that prints the address, the package is genuinely installable. If it fails,
the error tells you what to fix, and you publish a patch.

---

## 5. How the numbers and discovery work

### 5.1 Stats

npm shows, on the package page:

- **Weekly downloads** (from the registry, refreshed over time)
- **Version list and publish dates**
- **Dependents** (other packages that depend on yours)
- **License, size, last publish**

Downloads are a real signal and they help grant applications, credibility and
discovery. They are also **gameable**, so treat them as a soft signal. Early
downloads come mostly from your own CI, your demo, and curious devs.

### 5.2 How developers actually find a package

Yes, people search npm and the web for terms like "gasless game", "web3 game
infrastructure", "cheaper than gas", "on-chain game backend". Two things drive
discovery:

1. **The README text** (npm renders it and indexes it). This is your main lever.
2. **`keywords` in `package.json`** (npm indexes these).

Both packages already include keywords such as `gasless`, `arc`, `games`,
`session`. You can add more over time, for example `game-backend`,
`web2-to-web3`, `no-gas`, `web3-game`.

### 5.3 SEO: how to show up for the right searches

The goal is to be found by (a) web3 devs comparing rails and (b) **web2 game devs
who want cheaper infrastructure without changing their users' experience.**

Write the README and the docs page so those phrases appear naturally:

- "gasless on-chain game infrastructure"
- "no gas, no wallet popups for players"
- "cheaper than per-transaction game backends"
- "keep your players' normal web2 flow"
- "pay per session, not per action"

Do NOT keyword-stuff. npm and search engines both penalise it, and it reads as
spam. One clear sentence using the phrase beats ten repetitions.

**Positioning to use in the README and docs:** Foskaay GGI competes on *cost and
player experience*, not only against other web3 rails. The honest comparison is
three-way: per-transaction on-chain (expensive), gasless rails like MagicBlock
(good, but on Solana and per-commit), and traditional web2 game backends (cheap,
but not transparent). Foskaay GGI sits between them: web2-like cost and flow,
with on-chain transparency.

---

## 6. When things go wrong

- **Publish fails with `403`:** you are not logged in, or you do not own the
  scope. Run `npm whoami` and confirm the org exists.
- **Publish fails with `402 Payment Required`:** you tried to publish a private
  scoped package on a free plan. Add `--access public`.
- **A bad version is live:** publish the next patch. Optionally mark the bad
  one: `npm deprecate @foskaay/ggi-sdk@0.1.0 "do not use, use 0.1.1"`. You cannot
  delete a version after 72 hours, and you should not try.
- **You published a secret by accident:** treat it as compromised immediately.
  Rotate/revoke the secret first. Then unpublish within 72 hours if possible,
  and publish a clean version. Then tell the owner. Do not hide it.

---

## 7. The safety checklist (run before every publish)

1. `npm pack --dry-run` shows only intended files.
2. No `.env`, key, token, `.pem`, or credential in that list.
3. Version bumped correctly.
4. `npm test` or the repo build passes.
5. After publishing, install in a clean folder and import it.

---

## 8. Open questions for this project

- **Do we need our own repo first?** No. You can publish from this repo now.
  Moving the folder or repo later does not affect any already-published version.
- **Publish before the demo, or defer?** Publish first. The demo should consume
  the real published package, so it validates the exact path a stranger takes.
  This catches packaging bugs now. A `0.1.0` can be superseded by `0.1.1` freely.
- **Who owns the npm account?** The owner, always. The agent should never hold
  publish credentials. If automation is ever needed, use a **granular access
  token** scoped to only these two packages, stored outside the repo.
