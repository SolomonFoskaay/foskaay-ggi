# GlobalFolkGames — Launch-Day Run Sheet (phone walkthrough)

Goal: click through every feature once, top to bottom, and note anything broken, confusing, or that "breaks like a beta bug". Run it on BOTH a phone (mobile) and a desktop browser.

## 0) Setup notes
- Test on the live site: `https://globalfolkgames.fun` (or `npm run dev:tunnel` for a fresh sign-in flow).
- Use a normal (non-admin) email for the player-side tests, and the admin wallet for the staff tests.
- Hard refresh before you start so the latest build loads.

## 1) Sign in / out
1. Open the site. The header shows a `Sign in` button, the **Beta** badge next to the brand, and the logo.
2. Tap Sign in → email OTP flow → you land signed-in. Header now shows your points pill + tier badge (L1) and a sign-out button.
3. Sign out, then sign back in. Points should come back from your account (not vanish).

## 2) Homepage
1. USP banner "Preserving Global Native Games On-Chain" is the first thing.
2. Three tabs: **Games / Countries / Competition** — tap each; each goes to its hub page.
3. Promo card ("How good are you at your native games...") shows with the three preview cards (Games / Countries / Competition) each linking onward.
4. Footer: About, Support, Contact, Forum, What's New, Play Ludo, **Privacy Policy** — all links work; footer shows Beta.
5. No "crypto", no "play to earn", no "training" wording anywhere.

## 3) Games hub (`/games/`)
1. Search box filters the grid.
2. Ludo tile shows `Play now` → opens `/games/ludo-lab/`. Every other game shows `Coming soon` (no broken links).

## 4) Countries hub (`/countries/`)
1. Promo line + country cards (India/Nigeria/Brazil/Italy/Spain/Japan).
2. Ludo under India is `play`; others `soon`. Search works.

## 5) Ludo game (ludo-lab)
1. Start a match (Human vs 3 computers). First human roll should resolve on-chain (sponsored delegate) then be fast.
2. Finish a match and WIN in 1st place. Win ceremony: M3 local points +100, M4 global pure/lifetime/spendable +100, a receipt with a "See on-chain receipt" link.
3. Verify the receipt on `/verify` (open it; it should show the rolls + proof).
4. Lives: the game shows your lives; playing a match consumes one on completion (reset at midnight GMT). Try to see the "no lives left" overlay → it has the Premium + Booster CTAs.

## 6) Profile
1. Profile home: shows your wallet (copyable), points, and quick links.
2. Points & level page: loads your ledgers (local + global + premium) and level.
3. Upgrade page: the premium balance should AUTO-LOAD on visit (no manual tap). Shows L2/L3 selector + Booster card + countdowns.

## 7) Plans (single sales page `/profile/subscription.html`)
1. Two plan cards (Level 2 2x, Level 3 3x) with USD-first prices, Nigeria-only strikethrough-red + green discount line, and a comparison table including **Ads** (L2 light ads, L3 no ads).
2. Per-plan **Pay** buttons + "I have paid · confirm payment" → after-payment page.
3. After-payment dropdown has **Level 2 (5,000P), Level 3 (10,000P), 72h Booster (500P)** with correct amounts/hints.

## 8) Premium + activation (test admin)
1. Admin credits premium points (dashboard → Premium credit / tracker).
2. On upgrade page, refresh → activate **Level 2**: header shows L2 · 2x; daily reward 200P; lives 10; 2x win (a 100P win banks 200P on global).
3. Activate **Level 3**: L3 · 3x; 300P daily; 15 lives; **ad-free** (no Monetag tag injected); 1.5x competition boost.

## 9) Booster
1. With ≥500P premium spendable, activate the 72h booster on `/profile/upgrade#booster-card` (or booster sales page). Lives meter shows ∞ + countdown.

## 10) Affiliate
1. `/profile/affiliate`: your handle shows (no "sign in to get your code" when signed in). Copy link works.
2. Claim 500 signup points once → button becomes text "already claimed"; never reclaims. Refresh earnings gives visible feedback.

## 11) Competitions (the big one)
1. Hub `/competitions/`: tabs **Ongoing / Upcoming / Past** with counts; **search** by name and by month/year; pagination.
2. Open LUDO EARN (or a test comp): **eligibility checklist** shows Tier (green on L2/L3, red on L1 with upgrade link), Points (your current balance in the required family, green/red), Games, Window.
3. **Enter** → spends the entry (e.g., 500P global). Button shows success. Try entering without the right tier or enough points → accurate error, not "sign in first".
4. Play inside the window → the board should show you with Total Points and Final Points (L3 1.5x, L2 1.0x).
5. **Downgrade test**: with L3, watch Final = Total × 1.5; switch to L2 → Final becomes Total × 1.0; switch to free → you go HIDDEN (no position) until you resubscribe.
6. **Admin settle** (dashboard → Competitions): load the board, Close (after window end), Record winners (top N by Final Points), Settle, then **Mark paid**. The competition page then shows a single board with **PAID** status on the winners.
7. Past tab shows the completed competition; its page shows the winners + paid status (proof).

## 12) Admin dashboard
1. `/dashboard/` opens for the admin wallet (no redirect to home). Its menu lists every admin page.
2. **Competitions** creator UI: create a small test competition (games Ludo, tiers L2+L3, 500P global, duration e.g. 6h, $2 pool, 10 shares) → shows on-chain instance.
3. Other admin pages load (ops, endpoints, accounts, recovery, premium, premium-subscribers, affiliate, release, workspaces).

## 13) Changelog
1. `/changelog/` public: 3 tabs, pagination, new items show (booster, Level 3, competitions).
2. `/changelog/admin.html` (admin): raw detail + approvals.

## 14) Legal / ads
1. `/privacy.html` loads (header menu + footer link).
2. `/ads.txt` serves the Google line. `/media/logo.png` = favicon; header shows the logo; background uses the logo design (not stretched).

## 15) Negative / edge cases to try
1. Enter a competition without a qualifying plan → tier message.
2. Enter with low spendable → balance message with "how to get points".
3. Play with 0 lives → overlay appears with Premium + Booster buttons.
4. Open every nav link on a phone (no horizontal scroll, no broken layout).
5. Hard-refresh mid-session: points/badges should restore from your account.

## Report format
For anything that fails, note: page → action → what happened vs what should happen. Screenshot if easy. Then we fix, redeploy, re-test before flipping ads on.
