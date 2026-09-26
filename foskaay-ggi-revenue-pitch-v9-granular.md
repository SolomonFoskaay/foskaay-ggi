# Foskaay GGI Revenue & Pitch - Granular Breakdown
## Preserved from v8 + Expanded for Devs

> This file expands v8 without tampering it. v8 stays as is. This adds granular batched views and MAU vs daily plays.

### Section A1: Fee Tiers - Old vs New (from v8)

- Old: 0.001 USDC per session = $1 per 1000
- New Unbatched: 0.0004 USDC = $0.40 per 1000 fee alone, $0.76 per 1000 total with gas at 5 Gwei
- New Batched: 0.0002 USDC = $0.20 per 1000 fee alone, ~$0.36 per 1000 total with gas at 5 Gwei

### Section A2: Granular Batched Breakdown - Cost per 1000 Games

Devs batch handoverMany + settleMany. Base tx 21k amortized. At 5 Gwei (Arc mainnet realistic, not 20 Gwei):

| Batch Size | Gas/ session (handover+settle) | Fee/ session | Total/ session | **Total per 1000 games** |
| --- | --- | --- | --- | --- |
| 1 (unbatched) | 0.0003675 USDC | 0.0004 | 0.0007675 | **$0.76** |
| 2 | 0.0002625 | 0.0002 | 0.0004625 | **$0.46** |
| 3 | 0.0002275 | 0.0002 | 0.0004275 | **$0.42** |
| 5 | 0.0001995 | 0.0002 | 0.0003995 | **$0.39** |
| 10 | 0.0001785 | 0.0002 | 0.0003785 | **$0.37** |
| 20 | 0.000168 | 0.0002 | 0.000368 | **$0.36** |
| 50 | 0.0001617 | 0.0002 | 0.0003617 | **$0.36** |
| 100 | 0.0001596 | 0.0002 | 0.0003596 | **$0.35** |
| 1000 | 0.0001577 | 0.0002 | 0.0003577 | **$0.35** |
| 1000 (promo fee 0.0001) | 0.0001577 | 0.0001 | 0.0002577 | **$0.25 - hits $0.30 target** |

**Takeaway for agent:** Even batch 2 cuts cost 40% vs unbatched. From batch 5 onward cost flat ~$0.36/1000. Batch 1000 with promo fee hits $0.25/1000.

Sessions needed to earn:

- $1 at 0.0004 = 2,500 sessions, at 0.0002 = 5,000 sessions
- $10 = 25k / 50k
- $100 = 250k / 500k
- $1000 = 2.5M / 5M

Top chain opBNB does 317M txs, Ronin 321M - $1000 is 0.8% of that.

### Section A3: MAU vs Daily Plays - Real Web2 Scale

Formula: Sessions/month = MAU × Avg Daily Plays × 30

#### MAU 100 (indie test)

| Avg Daily | Sessions/Month | Cost Unbatched (0.0007675) | Cost Batched 20 (0.000368) |
| --- | --- | --- | --- |
| 2 | 6,000 | $4.60 | $2.20 |
| 3 | 9,000 | $6.90 | $3.31 |
| 5 | 15,000 | $11.51 | $5.52 |
| 10 | 30,000 | $23.02 | $11.04 |
| 15 | 45,000 | $34.53 | $16.56 |

#### MAU 5,000 (small web3 game)

| 2 | 300,000 | $230.25 | $110.40 |
| 3 | 450,000 | $345.37 | $165.60 |
| 5 | 750,000 | $575.62 | $276.00 |
| 10 | 1,500,000 | $1,151.25 | $552.00 |
| 15 | 2,250,000 | $1,726.87 | $828.00 |

#### MAU 10,000 (growing)

| 2 | 600,000 | $460.50 | $220.80 |
| 3 | 900,000 | $690.75 | $331.20 |
| 5 | 1,500,000 | $1,151.25 | $552.00 |
| 10 | 3,000,000 | $2,302.50 | $1,104.00 |
| 15 | 4,500,000 | $3,453.75 | $1,656.00 |

#### MAU 100,000 (Ludo King scale small %)

| 2 | 6,000,000 | $4,605 | $2,208 |
| 3 | 9,000,000 | $6,907.50 | $3,312 |
| 5 | 15,000,000 | $11,512.50 | $5,520 |
| 10 | 30,000,000 | $23,025 | $11,040 |
| 15 | 45,000,000 | $34,537.50 | $16,560 |

**Why batch matters for web2 huge daily play:** A web2 game with 100k MAU playing 10 times daily = 30M sessions/month. Unbatched $23k, batched 20 $11k - 52% cheaper. At batch 1000 promo fee $0.25/1000, same 30M = $7,731/month.

Compare: PlayFab for 100k MAU ~ $299 base + (100k-37k)*$0.008 = $803 + API/storage meters ~$1,500-3,000/month, but no provable randomness, no explorer, still need servers.

Foskaay GGI batched $2,208 is competitive and adds trust layer PlayFab doesn't have.

### Section B: Pitch - Why Web3 and Web2 Devs Need Foskaay GGI in Stack

**Web3 Reality Today:** 4.66M daily active wallets Q3 2025, 5.8M daily players, 8M peak Q2 2025. opBNB 2.2M DAU, 97 TPS avg, $0.0001 median fee. Axie averages 22 on-chain actions per wallet/month. World of Dypians 3.7M monthly, 737M total txs. So 300k-3M sessions/day is normal for breakout.

**Web2 Trust Problem:** Ludo King 1B-1.5B downloads, 260M recent, but complaints "app cheating, dice controlled, lobbying". Common failure is generating dice on client. Even server-side RNG is "trust me bro" opaque custodial. Players in competitive earn games don't trust dev not manipulating dice, cards, loot boxes against them.

**Foskaay GGI Fix:** Commit-reveal keccak(seed, counter) onchain. Handover commits seed, Settlement reveals. Dice derived pure via randomN free eth_call. Explorer reads Handover + Settled via eth_getLogs directly from contracts, no backend. Midchain moves signed by ephemeral session key representing EVM wallet, hash chain verified client-side - if relay down, finalHash dual sigs still prove truth. Gasless for player and sponsor: 2 txs (handover + settle) not 200 per Ludo match.

**Cost Comparison:**

- Pure onchain Ludo: 40+ turns × $0.0001 = $0.02 per game = $20/1000
- Foskaay GGI: $0.76/1000 unbatched, $0.36/1000 batched 20, $0.25/1000 batched 1000 promo - 26x-80x cheaper than pure onchain, adds proof PlayFab doesn't.

**One-liner for Agent to Use:**

"Keep PlayFab for auth/analytics, replace dice server with Foskaay GGI - same web2 UX, players can verify you didn't rig roll in Explorer, you pay $0.36 per 1000 games when batched 20 instead of $20 pure onchain, and for 100k MAU playing 10/day you go from $23k to $11k by batching."

