// scripts/plans-config.mjs — CONFIG-DRIVEN PLAN LADDER (M5).
// Single source of truth for plan attributes served to the client at /api/plans
// and used by the relay (affiliate share). More levels = more rows HERE, never
// code. Owner 2026-08-31: L0 free .. L3. Activation points are based on the
// ACTUAL (strike) USD price at the base rate 500 points = $1, never the
// discount, so removing a discount later needs no code change. Prices are
// USD CENTS only (no Naira).
export const PLAN_LADDER = {
  0: {
    level: 0,
    name: 'Level 0 (free)',
    mult: 1,
    gamesPerDay: 1,             // 1 rotation game free per day (NOT enforced in beta)
    livesPerDay: 5,
    dailyReward: 25,
    compFinalBoost: 0,          // not eligible to enter competitions
    adFree: false,              // full ads (ads never hidden)
    activationPremiumCost: 0,
    usdRegularCents: 500,       // $5
    usdDiscountCents: 0,        // $0 free for new accounts
    activeDays: 0,
  },
  1: {
    level: 1,
    name: 'Level 1',
    mult: 1.5,                 // 1.5x win points (owner 2026-08-31)
    gamesPerDay: 2,
    livesPerDay: 10,
    dailyReward: 50,
    compFinalBoost: 1000,       // 1.0x
    adFree: false,              // less ads (ads never hidden)
    activationPremiumCost: 5000, // actual $10 -> 5,000 pts (500 pts = $1)
    usdRegularCents: 1000,       // $10 actual
    usdDiscountCents: 500,       // $5 payable
    activeDays: 30,
  },
  2: {
    level: 2,
    name: 'Level 2',
    mult: 2,                   // 2x win points (owner 2026-08-31)
    gamesPerDay: 4,
    livesPerDay: 15,
    dailyReward: 100,
    compFinalBoost: 1250,       // 1.25x final-points boost (owner 2026-08-31)
    adFree: false,              // less ads (ads never hidden)
    activationPremiumCost: 10000, // actual $20 -> 10,000 pts (500 pts = $1)
    usdRegularCents: 2000,       // $20 actual
    usdDiscountCents: 1000,      // $10 payable
    activeDays: 30,
  },
  3: {
    level: 3,
    name: 'Level 3',
    mult: 3,                   // 3x win points (owner 2026-08-31)
    gamesPerDay: 8,
    livesPerDay: 20,
    dailyReward: 200,
    compFinalBoost: 1500,       // 1.5x
    adFree: false,              // less ads (ads never hidden)
    activationPremiumCost: 15000, // actual $30 -> 15,000 pts (500 pts = $1)
    usdRegularCents: 3000,       // $30 actual
    usdDiscountCents: 1500,      // $15 payable
    activeDays: 30,
  },
};

export const AFFILIATE_RATE = 0.20; // 20% of the referred plan's PAYABLE USD price (owner 2026-08-22)

export function planPayableUsdCents(level) {
  const p = PLAN_LADDER[level];
  return p ? p.usdDiscountCents : 0;
}

export function affiliateShareUsdCentsFor(level) {
  return Math.floor(planPayableUsdCents(level) * AFFILIATE_RATE);
}

export function planFor(level) {
  return PLAN_LADDER[level] || null;
}