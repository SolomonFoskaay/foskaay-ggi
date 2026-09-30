# v009 — Settlement economics: measured findings (Tests 1a–1c, 2a–2b, M1a–M1b)

All runs on Arc testnet, single-player demo unless stated. All costs in USDC
(sponsor-paid). Method: scripted play through the real relay (free `eth_call`
moves), receipts read per transaction, on-chain state read directly
(`pointsOf`, `recordOf`, `gameCount`) at every stage. No estimates anywhere.

## Test 1a — 100+ moves, abrupt end, no winner

110 free calls (25 rolls, 36 moves, 49 passes), 75s. Settle of the unfinished
board. Points [0, 0], no winner.

- tx1 connect: fee 0.0014 + gas ~0.00435 = 0.005748
  (`0xca75...70da`)
- tx2 game settle + tx3 core settle combined: 0.005708
  (`0xa929...850f` + `0x15d3...afeb`)
- Match total: **0.011456**. Chain transactions: 3.

## Test 1b — full game, logged-in user wins

208 free calls (48 rolls, 68 moves, 92 passes), 143s. Winner seat 0.

- tx1 connect: 0.005748 (`0x6754...280d`)
- tx2 + tx3 combined: 0.007766 (`0xcbbd...9439` + `0xb528...9626`)
- Match total: **0.013514**. Points [100, 0].

## Test 1c — crown record (win-record), two halves

Win-record fields (`played/wins/best`) were never written by the game
(`recordOf` read 0/0/0 everywhere before this test).

- Part A, no contract change: win + settle (0.007764), then one direct
  owner `addRecord` as its OWN transaction: **0.001437**
  (`0xb1f1...c00f`). Record reads 1/1/100. Match total 0.014949.
- Part B, testnet-only upgrade (same proxy `0x24e3...EcDF`, mainnet
  untouched): settle also writes the record IN the same transaction.
  Settle 0.008496 vs 1b baseline 0.007766, so the bundled write costs about
  **0.00073 extra** — roughly half the separate-transaction price. Record
  reads 1/1/100 with zero extra transactions. All 29 existing contract tests
  still pass.

Finding: each additional bundled write adds only its storage cost, never a
new transaction. A separate transaction re-pays the base fee every time.

## Test 2a — 3 games, one session, one settle (win, loss, win)

556 free calls. Connect declares 3 games: fee 0.0018 + gas = 0.006148
(`0xd066...8534`).

- After game 1 (user wins): midchain [100, 0]; on-chain points **0**,
  record 0/0/0, committed **0**.
- After game 2 (computer wins, uncredited by design): midchain [0, 100];
  on-chain **0**, 0/0/0, **0**.
- After game 3 (user wins): midchain [100, 0]; on-chain **0**, 0/0/0, **0**.
- Settle-all, still 2 transactions (`0x756c...666e` + `0xa31e...72f0`,
  0.015104): points **200**, record **3/2/200**, committed **3**.
- Match total 0.021252 = **0.007084 per game** (vs 0.013514 single).

Finding: nothing is permanent mid-session, three times over. Permanence
arrives only in the settle transactions. Batching divides the base fees
across games with zero gameplay change.

## Test 2b — won game, session left open forever

165 free calls, user wins, never settled. Midchain 100. On-chain points 0,
record 0, committed 0. Skipping settle pays nothing further and keeps nothing
permanently. There is no escape-fee path that preserves value.

## Tests M1a–M1b — merged rules-plus-ledger variant (testnet only)

One contract holding rules and ledger, no cross-contract call. Proxy
`0x5077...8019` (impl `0x4840...c51`), UUPS, same rules and timer as the
split build.

- M1a abandoned: connect (1 account lifted, fee 0.0010) = 0.004783
  (`0x96dd...14b3`). On-chain 0/0. Same zero-without-settle result.
- M1b win (182 free calls): pre-settle on-chain 0/0. Game settle 339,440 gas
  = 0.008486 (`0x50bc...c7e3`); core settle 0.001648 (`0x84f7...7727`).
  Post-settle points 100, games 1. Match total 0.014917.
- Split single-game settle measured at the same gas price: 238,596 gas.
  Merging did NOT save money in these samples; the structural expectation
  (one fewer CALL, ~2,600 gas) is noise next to six-figure storage writes.

## Conclusion against merging (measured, not stylistic)

1. No gas saving observed; samples show the opposite. The call overhead is
   ~1% of a settle.
2. It regresses the consolidation the platform was built on: one shared
   player ledger for 50 games becomes one ledger per game again.
3. It changes nothing about settle-dependence (M1a proves zero without
   settle) and nothing about the base fee (batching already amortizes it).

## Fee teardown (measured, testnet)

Start today (2 accounts, 1 game): 0.0014 + ~0.00435 gas = ~0.00575.
Session-charge only (drop per-account and per-game): ~0.00475. Zero fee:
~0.00435 gas only. Full match today ~0.0135; zero-fee match ~0.0121. Fees are
roughly a tenth to a fifth of a match; gas is the bill. Dials in order:
batching first (2–3x), checkpoint cadence second, gas-price timing third,
fee cuts last. Fees are also the only revenue line; gas is burned.
