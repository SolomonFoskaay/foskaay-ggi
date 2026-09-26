// scripts/m4-module-harness.mjs
// M4 Track A — module harness (benchmark = the M4 locked spec in architecture.json).
//
// Loads the REAL universal module (public/universal/ledgers/global-ledger.js)
// under a stubbed DOM and drives it with simulated M2 result envelopes to
// assert the locked global ledger rules:
//   - Kind-0 game wins: pure += points, lifetime += points, spendable += points
//   - Kind-1 other credits: pure UNCHANGED, lifetime += points, spendable += points
//   - M4a pure is NEVER credited on kind-1 (the core invariant)
//   - Spend decrements spendable only (pure + lifetime untouched)
//   - Idempotency: duplicate match_ref never double-credits
//   - Resilience: transient retry, confirm-timeout read-back, hard failure surfacing
//
// Run: node scripts/m4-module-harness.mjs   (exit 0 = all green)

import { readFileSync } from 'fs';

const MODULE_URL = new URL('../public/universal/ledgers/global-ledger.js', import.meta.url);

// ---- stubbed browser globals ---------------------------------------------
const lsStore = {};
const lsShim = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};

// Mock on-chain global ledger behind magicblockDice.
const mockGlobal = {
  globalPureLifetime: 0,
  globalLifetime: 0,
  globalSpendableBalance: 0,
  gameCreditCount: 0,
  otherCreditCount: 0,
  spendCount: 0,
  lastRecordedTs: 0,
  lastReason: 0,
  lastPoints: 0,
  lastMatchRef: '0',
  awardCount: 0,
  lastSpendTs: 0,
  lastSpendRef: '0',
  lastSpendReason: 0,
};
const credits = [];
const spends = [];

// Failure injection
let failNextCreditCount = 0;
let throwButLedgerLands = false;
let hardFailError = null;
const notifs = [];

let capturedSeamHandler = null;

globalThis.window = {
  localStorage: lsShim,
  addEventListener: () => {},
  onGameResult: (handler) => { capturedSeamHandler = handler; },
  magicblockDice: {
    recordGlobalPoints: async (kind, sourceCode, points, reason, matchRef) => {
      if (hardFailError) throw hardFailError;
      if (throwButLedgerLands) {
        if (mockGlobal.gameCreditCount + mockGlobal.otherCreditCount === 0) {
          mockGlobal.globalPureLifetime += (kind === 0 ? points : 0);
          mockGlobal.globalLifetime += points;
          mockGlobal.globalSpendableBalance += points;
          mockGlobal.lastPoints = points;
          mockGlobal.lastReason = reason;
          mockGlobal.lastMatchRef = String(matchRef);
          mockGlobal.lastRecordedTs = Date.now();
          mockGlobal.awardCount += 1;
          if (kind === 0) mockGlobal.gameCreditCount += 1;
          else mockGlobal.otherCreditCount += 1;
        }
        throw new Error('ER confirm-timeout (false failure: the write landed)');
      }
      if (failNextCreditCount > 0) {
        failNextCreditCount--;
        throw new Error('transient ER error');
      }
      credits.push({ kind, sourceCode, points, reason, matchRef: String(matchRef) });
      mockGlobal.globalPureLifetime += (kind === 0 ? points : 0);
      mockGlobal.globalLifetime += points;
      mockGlobal.globalSpendableBalance += points;
      mockGlobal.lastPoints = points;
      mockGlobal.lastReason = reason;
      mockGlobal.lastMatchRef = String(matchRef);
      mockGlobal.lastRecordedTs = Date.now();
      mockGlobal.awardCount += 1;
      if (kind === 0) mockGlobal.gameCreditCount += 1;
      else mockGlobal.otherCreditCount += 1;
      return 'mock-sig-' + credits.length;
    },
    spendGlobal: async (amount, reason, spendRef) => {
      spends.push({ amount, reason, spendRef: String(spendRef) });
      mockGlobal.globalSpendableBalance -= amount;
      mockGlobal.lastSpendRef = String(spendRef);
      mockGlobal.lastSpendReason = reason;
      mockGlobal.lastSpendTs = Date.now();
      mockGlobal.spendCount += 1;
      return 'mock-spend-' + spends.length;
    },
    fetchGlobalPointsPda: async () => ({ ...mockGlobal }),
    globalPointsPdaFor: () => 'mock-global-pda',
    matchRefFromSignature: (sig) => String([...sig].reduce((a, c) => a + c.charCodeAt(0), 0)),
  },
};

globalThis.document = {
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

// Mock window.localPoints — M4 reads lastSeenAward from M3's output.
// The harness sets this before each envelope emit.
let mockLastSeenAward = null;
window.localPoints = {
  get lastSeenAward() { return mockLastSeenAward; },
  get lastAward() { return mockLastSeenAward; },
};
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

if (typeof window.globalLedger.subscribe === 'function') {
  window.globalLedger.subscribe((ledger, credit) => {
    if (credit) notifs.push({ status: credit.status || 'banked', points: credit.points, error: credit.error || null });
  });
}

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
const seat = (seat, actor, position) => ({ seat, actor, position });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(env) { emit(env); await sleep(80); }

function waitForTerminal(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (notifs.some((n) => n.status !== 'banking') || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// Helper: set M3's mock award + emit envelope in one call.
// M3 computes award BEFORE M4's handler fires (M3 loads first in HTML).
async function emitWithAward(players, proofSig, awardOpts) {
  const { gameTag = 'ludo', points = 100, reason = 1 } = awardOpts || {};
  setMockAward(gameTag, points, reason);
  await run(envelope(players, proofSig));
  clearMockAward();
}

function resetMock() {
  mockGlobal.globalPureLifetime = 0; mockGlobal.globalLifetime = 0;
  mockGlobal.globalSpendableBalance = 0; mockGlobal.gameCreditCount = 0;
  mockGlobal.otherCreditCount = 0; mockGlobal.spendCount = 0;
  mockGlobal.lastRecordedTs = 0; mockGlobal.lastReason = 0;
  mockGlobal.lastPoints = 0; mockGlobal.lastMatchRef = '0';
  mockGlobal.awardCount = 0; mockGlobal.lastSpendTs = 0;
  mockGlobal.lastSpendRef = '0'; mockGlobal.lastSpendReason = 0;
  credits.length = 0; spends.length = 0; notifs.length = 0;
  failNextCreditCount = 0; throwButLedgerLands = false; hardFailError = null;
  if (window.globalLedger && typeof window.globalLedger.clearTransient === 'function') {
    window.globalLedger.clearTransient();
  }
}

console.log('\n=== kind-0 game win: pure + lifetime + spendable all credited ===');
resetMock();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await sleep(100);
check('kind-0 credits exactly once', credits.length === 1);
check('kind=0 (game win)', credits[0].kind === 0);
check('sourceCode=1 (ludo)', credits[0].sourceCode === 1);
check('pure += 100', mockGlobal.globalPureLifetime === 100);
check('lifetime += 100', mockGlobal.globalLifetime === 100);
check('spendable += 100', mockGlobal.globalSpendableBalance === 100);
check('gameCreditCount = 1', mockGlobal.gameCreditCount === 1);

console.log('\n=== kind-1 other credit: pure UNCHANGED, lifetime + spendable credited ===');
resetMock();
credits.length = 0;
// Manually call recordGlobalPoints kind=1 via the module API (credit() now takes sourceCode)
await window.globalLedger.credit({ kind: 1, sourceCode: 11, source: 'referral', points: 50, reason: 1, matchRef: 'ref-1' });
await sleep(100);
check('kind=1 credits once', credits.length === 1);
check('pure UNCHANGED (0)', mockGlobal.globalPureLifetime === 0);
check('lifetime += 50', mockGlobal.globalLifetime === 50);
check('spendable += 50', mockGlobal.globalSpendableBalance === 50);
check('otherCreditCount = 1', mockGlobal.otherCreditCount === 1);

console.log('\n=== idempotency: duplicate match_ref never double-credits ===');
resetMock();
const dup = 'dup-match-ref-123';
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dup);
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dup);
await sleep(100);
check('only one credit for duplicate match_ref', credits.length === 1);
check('pure = 100 (not 200)', mockGlobal.globalPureLifetime === 100);

console.log('\n=== spend: spendable decremented, pure + lifetime untouched ===');
resetMock();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await sleep(100);
const beforeSpend = { pure: mockGlobal.globalPureLifetime, lifetime: mockGlobal.globalLifetime, spendable: mockGlobal.globalSpendableBalance };
const sig = await window.globalLedger.spend(30, 1, 'spend-ref-1');
await sleep(50);
check('spend returns receipt', typeof sig === 'string' && sig.length > 0);
check('spendable decremented 100 -> 70', mockGlobal.globalSpendableBalance === beforeSpend.spendable - 30);
check('pure untouched by spend', mockGlobal.globalPureLifetime === beforeSpend.pure);
check('lifetime untouched by spend', mockGlobal.globalLifetime === beforeSpend.lifetime);
check('spend recorded', spends.length === 1 && spends[0].amount === 30);

console.log('\n=== ledger readback (module fetch -> client) ===');
resetMock();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await sleep(100);
const fetched = await window.globalLedger.get();
check('fetch returns all 3 tracks', fetched && fetched.globalPureLifetime === 100 && fetched.globalLifetime === 100 && fetched.globalSpendableBalance === 100);

console.log('\n=== resilience: transient failure retried ===');
resetMock();
failNextCreditCount = 1;
const transDone = waitForTerminal();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await transDone;
check('transient retried -> banks exactly once', credits.length === 1 && credits[0].points === 100);
check('ledger landed after retry', mockGlobal.globalPureLifetime === 100);

console.log('\n=== resilience: confirm-timeout (write landed, confirm threw) ===');
resetMock();
throwButLedgerLands = true;
const recoveryDone = waitForTerminal();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await recoveryDone;
check('ledger actually holds the points', mockGlobal.globalPureLifetime === 100);
check('read-back recovery surfaces the award', window.globalLedger.lastCredit && window.globalLedger.lastCredit.points === 100);
check('no lastError (recovered)', window.globalLedger.lastError === null);

console.log('\n=== resilience: hard failure surfaces failed state ===');
resetMock();
hardFailError = new Error('program error: account not found');
const hardDone = waitForTerminal();
await emitWithAward([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]);
await hardDone;
check('failed status notified', notifs.some(n => n.status === 'failed'));
check('lastError explains the failure', window.globalLedger.lastError && window.globalLedger.lastError.includes('account not found'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
