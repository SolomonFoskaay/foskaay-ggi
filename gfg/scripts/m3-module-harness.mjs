// scripts/m3-module-harness.mjs
// M3 — module harness (benchmark = the M3 locked spec in architecture.json).
//
// Loads the REAL universal module (public/universal/points/local-points.js)
// under a stubbed DOM and drives it with simulated M2 result envelopes to
// assert the locked scoring rules end-to-end:
//   4P: 1st=100 / 2nd=50 / 3rd=10 / 4th=0 ; 2P: 1st=100, 2nd=0.
//   ONLY the 'user' seat earns, at its OWN position (house/local earn nothing).
//   No proof signature -> no bank. Duplicate match_ref -> never double-banks.
//   spend_local decrements spendable only (pure untouched).
//
// Run: node scripts/m3-module-harness.mjs   (exit 0 = all green)

import { readFileSync } from 'fs';

const MODULE_URL = new URL('../public/universal/points/local-points.js', import.meta.url);

// ---- stubbed browser globals ---------------------------------------------
const lsStore = {};
const lsShim = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};

// Mock on-chain ledger behind magicblockDice. recordPoints accumulates into
// the ledger (pure + spendable together); spendLocal decrements spendable only.
const mockLedger = {
  pureLifetime: 0,
  spendableBalance: 0,
  lastPoints: 0,
  lastReason: 0,
  lastMatchRef: '0',
  awardCount: 0,
  lastSpendTs: 0,
  lastSpendRef: '0',
  lastSpendReason: 0,
  spendCount: 0,
};
const banks = [];
const spends = [];

// Failure injection for the resilience tests:
//   failNextBankCount   -> throw this many recordPoints calls before banking.
//   throwButLedgerLands -> throw every time, but STILL write the ledger (mimics
//                          an ER confirm-timeout false failure).
let failNextBankCount = 0;
let throwButLedgerLands = false;
const notifs = [];

// Captured seam handler: the module subscribes to window.onGameResult at load
// time, so we install the capturer BEFORE importing the module.
let capturedSeamHandler = null;

globalThis.window = {
  localStorage: lsShim,
  addEventListener: () => {},
  onGameResult: (handler) => { capturedSeamHandler = handler; },
  magicblockDice: {
    recordPoints: async (gameTag, points, reason, matchRef) => {
      if (throwButLedgerLands) {
        // The write lands EXACTLY once; every retry of the same match_ref is
        // rejected by the program's DuplicateMatchRef guard (lib.rs), exactly
        // like the real chain. Then confirm throws (a false failure).
        if (mockLedger.awardCount === 0) {
          mockLedger.pureLifetime += points;
          mockLedger.spendableBalance += points;
          mockLedger.lastPoints = points;
          mockLedger.lastReason = reason;
          mockLedger.lastMatchRef = String(matchRef);
          mockLedger.awardCount += 1;
        }
        throw new Error('ER confirm-timeout (false failure: the write landed)');
      }
      if (failNextBankCount > 0) {
        failNextBankCount--;
        throw new Error('transient ER error');
      }
      banks.push({ gameTag, points, reason, matchRef: String(matchRef) });
      mockLedger.pureLifetime += points;
      mockLedger.spendableBalance += points;
      mockLedger.lastPoints = points;
      mockLedger.lastReason = reason;
      mockLedger.lastMatchRef = String(matchRef);
      mockLedger.awardCount += 1;
      return 'mock-sig-' + banks.length;
    },
    spendLocal: async (gameTag, amount, reason, spendRef) => {
      spends.push({ gameTag, amount, reason, spendRef: String(spendRef) });
      mockLedger.spendableBalance -= amount;
      mockLedger.lastSpendRef = String(spendRef);
      mockLedger.lastSpendReason = reason;
      mockLedger.spendCount += 1;
      return 'mock-spend-' + spends.length;
    },
    fetchPointsPda: async () => ({ ...mockLedger }),
    matchRefFromSignature: (sig) => String([...sig].reduce((a, c) => a + c.charCodeAt(0), 0)),
  },
};

globalThis.document = {
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

globalThis.setTimeout = setTimeout;
globalThis.console = console;

// ---- load the real module -------------------------------------------------
await import(MODULE_URL);
const emit = capturedSeamHandler; // captured seam handler
if (typeof emit !== 'function') { console.error('HARNESS FAIL: module did not subscribe to onGameResult'); process.exit(1); }

// Capture module state notifications (banking / banked / failed) for the
// resilience checks.
if (typeof window.localPoints.subscribe === 'function') {
  window.localPoints.subscribe((gameTag, ledger, award) => {
    if (award) notifs.push({ status: award.status || 'banked', points: award.points, error: award.error || null });
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

// Resolves once the module has emitted a TERMINAL state (banked / failed /
// recovered-as-banked) for the current bank, or after a safety timeout. The
// bank runs async (it awaits the ledger write + retry backoffs), so checks
// must wait for it to finish rather than racing 80ms.
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

function resetMock() {
  mockLedger.pureLifetime = 0; mockLedger.spendableBalance = 0; mockLedger.lastPoints = 0;
  mockLedger.lastReason = 0; mockLedger.lastMatchRef = '0'; mockLedger.awardCount = 0;
  mockLedger.spendCount = 0; mockLedger.lastSpendRef = '0'; mockLedger.lastSpendReason = 0;
  banks.length = 0; spends.length = 0; notifs.length = 0;
  failNextBankCount = 0; throwButLedgerLands = false;
  if (window.localPoints && typeof window.localPoints.clearTransient === 'function') {
    window.localPoints.clearTransient();
  }
}

console.log('\n=== 4P scoring (1st=100 / 2nd=50 / 3rd=10 / 4th=0, user-only) ===');
resetMock();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
check('4P user 1st banks 100', banks.length === 1 && banks[0].points === 100);
check('reason = win1st(1)', banks[0].reason === 1);

resetMock();
await run(envelope([seat('green', 'house', 1), seat('yellow', 'user', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
check('4P user 2nd banks 50', banks.length === 1 && banks[0].points === 50);
check('pure+spendable both 50', mockLedger.pureLifetime === 50 && mockLedger.spendableBalance === 50);

resetMock();
await run(envelope([seat('green', 'house', 1), seat('yellow', 'house', 2), seat('blue', 'user', 3), seat('red', 'house', 4)]));
check('4P user 3rd banks 10', banks.length === 1 && banks[0].points === 10);

resetMock();
await run(envelope([seat('green', 'house', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'user', 4)]));
check('4P user 4th banks 0', banks.length === 0);

console.log('\n=== 2P scoring (1st=100 only) ===');
resetMock();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2)]));
check('2P user 1st banks 100', banks.length === 1 && banks[0].points === 100);

resetMock();
await run(envelope([seat('green', 'house', 1), seat('yellow', 'user', 2)]));
check('2P user 2nd banks 0', banks.length === 0);

console.log('\n=== user-only rule (house/local never earn) ===');
resetMock();
await run(envelope([seat('green', 'house', 1), seat('yellow', 'house', 2), seat('blue', 'local', 3), seat('red', 'house', 4)]));
check('no user seat -> nothing banks', banks.length === 0);

console.log('\n=== gating ===');
resetMock();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2)], null));
check('no proof signature -> no bank', banks.length === 0);

resetMock();
const dup = 'same-proof-sig-dup';
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dup));
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)], dup));
check('duplicate match_ref -> single bank', banks.length === 1);

console.log('\n=== spend_local (spendable only, pure untouched) ===');
resetMock();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
const beforeSpend = { ...mockLedger };
const sig = await window.localPoints.spend('ludo', 30, 5, 7);
await sleep(50);
check('spend returns a receipt', typeof sig === 'string' && sig.length > 0);
check('spendable decremented 100 -> 70', mockLedger.spendableBalance === beforeSpend.spendableBalance - 30);
check('pure untouched by spend', mockLedger.pureLifetime === beforeSpend.pureLifetime);
check('spend recorded with reason+ref', spends.length === 1 && spends[0].reason === 5 && spends[0].spendRef === '7');

console.log('\n=== ledger readback (module fetch -> client) ===');
resetMock();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
const fetched = await window.localPoints.fetch('ludo');
check('fetch returns pure + spendable tracks', fetched && fetched.pureLifetime === 100 && fetched.spendableBalance === 100);
check('award_count incremented', fetched.awardCount === 1);

console.log('\n=== resilience: transient failure retried ===');
resetMock();
failNextBankCount = 1;
const transDone = waitForTerminal();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
await transDone;
check('transient failure retried -> banks exactly once', banks.length === 1 && banks[0].points === 100);
check('ledger landed after retry', mockLedger.pureLifetime === 100);
check('notified banking -> banked', notifs.some(n => n.status === 'banking') && notifs.some(n => n.status === 'banked'));
check('no lastError after success', window.localPoints.lastError === null);

console.log('\n=== resilience: every attempt errors but the write landed (confirm-timeout) ===');
resetMock();
throwButLedgerLands = true;
const recoveryDone = waitForTerminal();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
await recoveryDone;
check('ledger actually holds the points', mockLedger.pureLifetime === 100 && mockLedger.lastMatchRef !== '0');
check('read-back recovery surfaces the award', window.localPoints.lastAward && window.localPoints.lastAward.points === 100 && Date.now() - window.localPoints.lastAward.at < 15000);
check('no lastError (recovered)', window.localPoints.lastError === null);
check('processed guard set so it never re-banks', mockLedger.awardCount === 1);

console.log('\n=== resilience: hard failure surfaces failed state (never silent) ===');
resetMock();
const hardFail = new Error('program error: account not found');
window.magicblockDice.recordPoints = async () => { throw hardFail; };
const hardDone = waitForTerminal();
await run(envelope([seat('green', 'user', 1), seat('yellow', 'house', 2), seat('blue', 'house', 3), seat('red', 'house', 4)]));
await hardDone;
check('failed status notified (not silent)', notifs.some(n => n.status === 'failed'));
check('lastError explains the failure', window.localPoints.lastError === hardFail.message);
check('no award claimed on hard failure', !window.localPoints.lastAward || Date.now() - window.localPoints.lastAward.at > 15000);
check('banking state was shown before the failure', notifs.some(n => n.status === 'banking'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
