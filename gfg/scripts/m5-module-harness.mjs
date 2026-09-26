// scripts/m5-module-harness.mjs
// M5 — module harness (benchmark = the M5 locked spec in architecture.json).
//
// Loads the REAL universal module (public/universal/subscription/premium-ledger.js)
// under a stubbed DOM and drives it to assert the locked launch rules:
//   - Credit-then-activate: a banked 5,000P premium balance activates Level 1
//     (2x), deducting 5,000 premium spendable and setting a 30-day window.
//   - Re-activate with an insufficient balance is refused (the module surfaces
//     the failure, never silently).
//   - spend: premium spendable decrements, premium_lifetime is NEVER touched.
//   - Spend guard: spending more than the balance fails.
//   - Multiplier AT M4 FLOW-UP ONLY: on a verified finish while a paid level is
//     active, the module credits M4 kind=1 source=tier_boost (points =
//     (multiplier-1)*base, reason 5), NEVER touch M4a pure, and NEVER re-boosts
//     a match it already boosted; a free tier boosts nothing; an expired sub
//     boosts nothing. Ladder (owner 2026-08-31): L1 1.5x -> +0.5*base,
//     L2 2x -> +1*base, L3 3x -> +2*base.
//   - 30-day expiry pass-through: active_until lapsing drops back to free.
//
// Run: node scripts/m5-module-harness.mjs   (exit 0 = all green)

import { readFileSync } from 'fs';

const MODULE_URL = new URL('../public/universal/subscription/premium-ledger.js', import.meta.url);

// ---- stubbed browser globals ---------------------------------------------
const lsStore = {};
const lsShim = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};

// Mock on-chain PREMIUM ledger behind magicblockDice.
const mockPremium = {
  version: 1,
  adminAuthority: 'mock-admin',
  premiumLifetime: 0,
  premiumSpendable: 0,
  subscriptionLevel: 0,
  subscriptionActiveUntil: 0,
  lastCreditTs: 0,
  lastCreditPoints: 0,
  lastCreditRef: '0',
  lastSpendTs: 0,
  lastSpendRef: '0',
  lastSpendReason: 0,
  spendCount: 0,
};
let activateNowImpl = null; // injectable now() for expiry tests

// Mock global ledger (what tier_boost credits into). Tracks the invariant that
// kind=1 NEVER touches pure.
const mockGlobal = {
  globalPureLifetime: 0,
  globalLifetime: 0,
  globalSpendableBalance: 0,
  lastMatchRef: '0',
};
const boosts = [];

let capturedSeamHandler = null;
let magicReady = true;

globalThis.window = {
  localStorage: lsShim,
  addEventListener: () => {},
  onGameResult: (handler) => { capturedSeamHandler = handler; },
  getDynamicSolanaWallet: () => '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB',
  magicblockDice: {
    isConfigured: () => magicReady,
    fetchPremiumPointsPdaFor: async () => ({ ...mockPremium }),
    spendPremiumPoints: async (amount, reason, spendRef) => {
      if (mockPremium.premiumSpendable < amount) {
        throw new Error('InsufficientPremiumBalance');
      }
      mockPremium.premiumSpendable -= amount;
      mockPremium.lastSpendTs = Date.now();
      mockPremium.lastSpendRef = String(spendRef);
      mockPremium.lastSpendReason = reason;
      mockPremium.spendCount += 1;
      return 'mock-premium-spend-' + mockPremium.spendCount;
    },
    activateSubscriptionLevel: async (level) => {
      const lvl = Math.min(3, Math.max(1, Number(level) || 1));
      const cost = [0, 5000, 10000, 15000][lvl];
      if (mockPremium.premiumSpendable < cost) {
        throw new Error('InsufficientPremiumBalance');
      }
      mockPremium.premiumSpendable -= cost;
      mockPremium.subscriptionLevel = lvl;
      const now = activateNowImpl ? activateNowImpl() : Date.now();
      mockPremium.subscriptionActiveUntil = now + 30 * 24 * 60 * 60 * 1000;
      return 'mock-activate-' + Date.now();
    },
    matchRefFromSignature: (sig) => String([...sig].reduce((a, c) => a + c.charCodeAt(0), 0)),
    boostRefFromSignature: (sig) => String([...sig].reduce((a, c) => a + c.charCodeAt(0) * 2, 0)),
  },
  // M3's computed award (the module reads the base award from M3).
  localPoints: {
    get lastSeenAward() { return mockLastSeenAward; },
    get lastAward() { return mockLastSeenAward; },
  },
  // M4 bank the tier_boost credits into (kind=1: pure NEVER touched).
  globalLedger: {
    credit: async ({ kind, sourceCode, source, points, reason, matchRef }) => {
      // Mirror global-ledger.js: the module passes `source`; the real M4
      // module resolves the code from its SOURCE_CODES table.
      const SOURCE_CODES = { ludo: 1, ayo_olopon: 2, signup_bonus: 10, referral: 11, giveaway: 12, tier_boost: 13 };
      const resolved = sourceCode != null ? sourceCode : (SOURCE_CODES[source] || 0);
      boosts.push({ kind, sourceCode: resolved, source, points, reason, matchRef: String(matchRef) });
      mockGlobal.globalPureLifetime += (kind === 0 ? points : 0);
      mockGlobal.globalLifetime += points;
      mockGlobal.globalSpendableBalance += points;
      mockGlobal.lastMatchRef = String(matchRef);
      return 'mock-global-boost-' + boosts.length;
    },
    get: () => ({
      pureLifetime: mockGlobal.globalPureLifetime,
      lifetime: mockGlobal.globalLifetime,
      spendableBalance: mockGlobal.globalSpendableBalance,
      lastMatchRef: mockGlobal.lastMatchRef,
    }),
  },
};

globalThis.document = {
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

let mockLastSeenAward = null;
function setMockAward(gameTag, points, reason, matchRef) {
  mockLastSeenAward = { gameTag, points, reason, matchRef, position: 1, at: Date.now() };
}
function clearMockAward() { mockLastSeenAward = null; }

globalThis.setTimeout = setTimeout;
globalThis.console = console;

// ---- load the real module -------------------------------------------------
await import(MODULE_URL);
const emit = capturedSeamHandler;
if (typeof emit !== 'function') { console.error('HARNESS FAIL: module did not subscribe to onGameResult'); process.exit(1); }

let sigCounter = 0;
const nextSig = () => 'sig-' + (++sigCounter) + '-' + sigCounter + '-' + sigCounter + '-' + sigCounter;
const envelope = (players, proofSig) => {
  const sig = proofSig === null ? null : (proofSig === undefined ? nextSig() : proofSig);
  return {
    schema: 'gfg:game-result@1',
    gameId: 'ludo',
    mode: 'human_vs_computer',
    players,
    proof: sig ? { method: 'magicblock-vrf', chain: 'solana-devnet', signature: sig } : null,
  };
};
const seat = (seat, actor, position, identity) => ({ seat, actor, position, identity: identity || (actor === 'user' ? '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB' : undefined) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Emit + refresh the premium ledger cache (the module's reads are cached).
async function emitAndSync(env) {
  emit(env);
  await sleep(160);
}
async function refreshCache() {
  if (window.premiumPoints && typeof window.premiumPoints.fetch === 'function') {
    await window.premiumPoints.fetch();
  }
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function resetMock() {
  mockPremium.premiumLifetime = 0; mockPremium.premiumSpendable = 0;
  mockPremium.subscriptionLevel = 0; mockPremium.subscriptionActiveUntil = 0;
  mockPremium.lastCreditTs = 0; mockPremium.lastCreditPoints = 0; mockPremium.lastCreditRef = '0';
  mockPremium.lastSpendTs = 0; mockPremium.lastSpendRef = '0';
  mockPremium.lastSpendReason = 0; mockPremium.spendCount = 0;
  mockGlobal.globalPureLifetime = 0; mockGlobal.globalLifetime = 0;
  mockGlobal.globalSpendableBalance = 0; mockGlobal.lastMatchRef = '0';
  boosts.length = 0;
  clearMockAward();
  activateNowImpl = null;
  if (window.premiumPoints && typeof window.premiumPoints.clearTransient === 'function') {
    window.premiumPoints.clearTransient();
  }
}

// Helper: bank a simulated admin credit onto the premium ledger.
function adminCredit(points, ref) {
  mockPremium.premiumLifetime += points;
  mockPremium.premiumSpendable += points;
  mockPremium.lastCreditPoints = points;
  mockPremium.lastCreditRef = String(ref);
  mockPremium.lastCreditTs = Date.now();
}

// ---- credit-then-activate -------------------------------------------------
console.log('\n=== credit-then-activate (admin credits 5,000P -> activate deducts) ===');
resetMock();
adminCredit(5000, 'paystack_1');
await refreshCache();
check('premium balances 5000/5000 after credit', mockPremium.premiumLifetime === 5000 && mockPremium.premiumSpendable === 5000);
check('level is 0 (free) before activation', (window.activeTier.get() || {}).level === 0);
const actSig = await window.premiumPoints.activate();
await sleep(80);
check('activate returns a receipt', typeof actSig === 'string' && actSig.length > 0 && actSig.indexOf('mock-activate') === 0);
check('activation deducted 5,000 premium spendable', mockPremium.premiumSpendable === 0);
check('premium_lifetime UNTOUCHED by activation', mockPremium.premiumLifetime === 5000);
check('level is now 1', (window.activeTier.get() || {}).level === 1);
check('30-day window set', (window.activeTier.get() || {}).daysLeft >= 29 && (window.activeTier.get() || {}).daysLeft <= 30);
check('subscription reported active', (window.activeTier.get() || {}).active === true);

console.log('\n=== insufficient balance refuses activation ===');
resetMock();
adminCredit(4999, 'paystack_2');
await refreshCache();
const beforeLevel = (window.activeTier.get() || {}).level;
await window.premiumPoints.activate();
await sleep(80);
check('level stays free (0)', (window.activeTier.get() || {}).level === 0 && beforeLevel === 0);
check('failure surfaced (not silent)', window.premiumPoints.lastError && String(window.premiumPoints.lastError).indexOf('InsufficientPremiumBalance') >= 0);

console.log('\n=== spend: spendable only, lifetime never touched ===');
resetMock();
adminCredit(5000, 'paystack_3');
await refreshCache();
const beforeLifetime = mockPremium.premiumLifetime;
const spSig = await window.premiumPoints.spend(120, 1, 'sub-upgrade');
await sleep(80);
check('spend returns a receipt', typeof spSig === 'string' && spSig.indexOf('mock-premium-spend') === 0);
check('spendable 5000 -> 4880', mockPremium.premiumSpendable === 4880);
check('premium lifetime untouched by spend', mockPremium.premiumLifetime === beforeLifetime);

console.log('\n=== spend guard: over-balance spend is refused ===');
resetMock();
adminCredit(100, 'paystack_4');
await refreshCache();
await window.premiumPoints.spend(200, 1, 'over');
await sleep(80);
check('spend rejected (200 > 100)', mockPremium.premiumSpendable === 100);
check('guard surfaced (not silent)', window.premiumPoints.lastError && String(window.premiumPoints.lastError).indexOf('InsufficientPremiumBalance') >= 0);

// ---- multiplier at M4 flow-up (kind=1 tier_boost) -------------------------
console.log('\n=== multiplier applies ONLY at M4 flow-up while active ===');
resetMock();
adminCredit(5000, 'paystack_5');
await refreshCache();
await window.premiumPoints.activate();
await sleep(80);
clearMockAward();
setMockAward('ludo', 100, 3, 'boost-1-ref');
await emitAndSync(envelope([seat('green', 'user', 3, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB'), seat('yellow', 'house', 1), seat('blue', 'house', 2), seat('red', 'house', 4)]));
check('tier_boost credited to M4', boosts.length === 1);
check('kind=1 (M4a pure NEVER touched)', boosts[0].kind === 1);
check('source = tier_boost (code 13)', boosts[0].source === 'tier_boost' && boosts[0].sourceCode === 13);
check('boost points = (mult-1)*base = 50 (L1 1.5x)', boosts[0].points === 50);
check('reason = 5', boosts[0].reason === 5);
check('M4a pure stays 0 (kind=1 never credits pure)', mockGlobal.globalPureLifetime === 0);
check('M4b lifetime +50', mockGlobal.globalLifetime === 50);
check('M4c spendable +50', mockGlobal.globalSpendableBalance === 50);

console.log('\n=== duplicate match never double-boosts ===');
resetMock();
adminCredit(5000, 'paystack_6');
await refreshCache();
await window.premiumPoints.activate();
await sleep(80);
const dupSig = 'dup-boost-sig';
clearMockAward();
setMockAward('ludo', 100, 1, 'dup-boost-ref');
await emitAndSync(envelope([seat('green', 'user', 1, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB'), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dupSig));
await emitAndSync(envelope([seat('green', 'user', 1, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB'), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dupSig));
check('only one boost for the duplicate match', boosts.length === 1);
check('M4b lifetime = 50 (not 100)', mockGlobal.globalLifetime === 50);

console.log('\n=== free tier boosts nothing ===');
resetMock();
adminCredit(2000, 'paystack_7'); // not enough to activate
await refreshCache();
clearMockAward();
setMockAward('ludo', 100, 1, 'free-ref');
await emitAndSync(envelope([seat('green', 'user', 1, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB'), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
check('free tier -> no tier_boost credit', boosts.length === 0);

console.log('\n=== no user seat / no proof boosts nothing ===');
resetMock();
adminCredit(5000, 'paystack_8');
await refreshCache();
await window.premiumPoints.activate();
await sleep(80);
clearMockAward();
setMockAward('ludo', 100, 1, 'nouser-ref');
await emitAndSync(envelope([seat('green', 'house', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
check('no user seat -> no boost', boosts.length === 0);

resetMock();
adminCredit(5000, 'paystack_9');
await refreshCache();
await window.premiumPoints.activate();
await sleep(80);
clearMockAward();
setMockAward('ludo', 100, 1, 'noproof-ref');
emit({ schema: 'gfg:game-result@1', gameId: 'ludo', players: [seat('green', 'user', 1, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB')], proof: null });
await sleep(160);
check('no proof -> no boost', boosts.length === 0);

console.log('\n=== expired sub passes through to free (no boost) ===');
resetMock();
adminCredit(5000, 'paystack_10');
activateNowImpl = () => Date.now() - 31 * 24 * 60 * 60 * 1000; // active_until 31 days ago
mockPremium.subscriptionActiveUntil = Date.now() - 31 * 24 * 60 * 60 * 1000;
mockPremium.subscriptionLevel = 2;
await refreshCache();
check('expired sub reports inactive', (window.activeTier.get() || {}).active === false);
clearMockAward();
setMockAward('ludo', 100, 1, 'expired-ref');
await emitAndSync(envelope([seat('green', 'user', 1, '7aGs8riYmxQsMy1jiaGavw7Rnx6pb8gFwmC9VH4RfHDB'), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
check('expired sub -> no tier_boost credit', boosts.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);