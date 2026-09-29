# Commit / Push Preflight — HARD RULE (run before EVERY commit/push)

This rule is auto-loaded into every session. It is NON-NEGOTIABLE. No commit
and no push runs until every step below is CLEAN. When the owner asks for a
commit/push, still run the full preflight; never skip it because it was asked
for. The preflight protects the owner.

## Order (never reorder)

0. **Self-verification** (see `.opencode/rules/security-leak-scan.md` Step 0):
   re-read every edited file, trace caller to callee names, check DOM ids
   exist, confirm script load order. Any doubt = fix first, never commit
   half-checked work.
1. **Leak scan** (see `.opencode/rules/security-leak-scan.md`): staged diff +
   worktree diff + secret-file check. ANY hit = HARD STOP.
2. **Build green:** `npm run build` must pass. Changed serverless modules also
   pass `node --check`. Solidity changes also pass `forge build` (+ `forge test`
   for the touched contract).
3. **No build artifacts:** `git ls-files | grep -E 'programs/target|dist/|out/'`
   must be EMPTY of committed artifacts (Vercel builds from source).
4. **Single serverless function:** `api/` must contain ONLY `index.mjs`. New
   endpoints go in the dispatch map inside it, never as new files under `api/`.
5. **Diff review:** `git status --porcelain` + `git diff --stat` must show ONLY
   intended files, additive (new lines), never a rewrite or silent delete of
   another feature. Protected records (`deployments/addresses.mjs`,
   `deployments/*.json`, docs) change additively or not at all.
6. **Secrets never committed:** `.env`, `.env.*`, keypair JSON, forge
   `cache/` + `broadcast/` (hold the deploy key) stay gitignored and uncommitted.
   Public addresses, tx hashes and proxy addresses are NOT secrets.

## Branches (open-source repo, `main` protected)

- Active work branch is `osv1Arc`. The agent commits and pushes to `osv1Arc`
  ONLY, and only after the owner approves the push in that turn.
- The OWNER creates the pull request from `osv1Arc` to `main` and approves it.
  The agent never pushes to `main` and never opens a PR unless asked.
- Never amend a pushed commit without explicit owner approval; make a new
  commit instead.
- Commit format: `<type>(<scope>): <short summary>`, types `feat|fix|chore|
  docs|refactor`, imperative lowercase summary, no period.
