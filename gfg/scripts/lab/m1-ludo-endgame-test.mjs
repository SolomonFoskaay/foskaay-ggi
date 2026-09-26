// m1-ludo-endgame-test.mjs - M1A Ludo endgame + persistence harness (Node, no browser).
//
// Loads the REAL public/games/ludo-lab mechanics files with a stubbed DOM/window
// and drives the turn loop + endgame + refresh-restore against the locked M1A
// Ludo spec (architecture.json -> M1 -> games -> Ludo). Run: node scripts/lab/m1-ludo-endgame-test.mjs
//
// ludo-lab M1 endgame test harness (Node, no browser).
// Loads the REAL ludo-lab mechanics files with a stubbed DOM/window and
// drives the turn loop + endgame against the locked M1A Ludo spec.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', 'public', 'games', 'ludo-lab');
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`); }
}

// ----- stub browser environment -----
const listeners = {};
const elementIds = [
  'ludoCanvas',
  'ludo-log', 'type-green', 'type-yellow', 'type-blue', 'type-red',
  'startMatchBtn', 'diceBtn', 'pauseBtn', 'turn-indicator',
  'mode-2p', 'mode-4p',
  'val-d1', 'val-d2', 'val-total', 'verify-tx-link',
  'custom-confirm-overlay', 'confirm-ok-btn', 'confirm-cancel-btn',
  'result-ceremony-overlay', 'result-ceremony-msg', 'result-ceremony-list',
  'play-again-btn', 'ceremony-end-btn',
];
const ctx2d = new Proxy({}, {
  get(t, p) {
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'fillText') return () => {};
    if (typeof p === 'symbol') return undefined;
    if (p in t) return t[p];
    return () => {};
  },
  set() { return true; },
});
const canvasStub = {
  width: 600, height: 600,
  getContext: () => ctx2d,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
  addEventListener() {},
};

function makeEl(id) {
  if (id === 'ludoCanvas') return canvasStub;
  const classes = new Set();
  return {
    id,
    value: id.startsWith('type-') ? (id.endsWith('-green') ? 'you' : 'computer') : '',
    innerText: '', innerHTML: '', textContent: '', style: {}, disabled: false,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) { const on = (force === undefined) ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
    },
    addEventListener() {},
  };
}
const els = {};
elementIds.forEach(id => els[id] = makeEl(id));
els['type-green'].value = 'you';

// window IS the vm global (like a browser) so window.x = ... creates bare x.
const sandbox = {
  location: { reload: () => { sandbox._reloaded = true; } },
  addEventListener: (name, cb) => { listeners[name] = cb; },
  dispatchEvent() {},
  console,
  currentUser: { dynamicId: 'stub-user' },
  currentProfile: { solana_wallet: 'STUBWALLET' },
  document: null,
  localStorage: null,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Math, Date, JSON, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
};
sandbox.window = sandbox;
sandbox.document = {
  getElementById(id) { return els[id] || null; },
  addEventListener(name, cb) { listeners['dom_' + name] = cb; },
  body: null,
};
sandbox.document.body = {
  appendChild() {},
};

// Chain/vrf stubs so rollDiceEngine can run without a relay (double-6 tests).
let nextRoll = [3, 5];
sandbox.fetch = async () => ({ ok: true, json: async () => ({ roll1: nextRoll[0], roll2: nextRoll[1], seed: 1, signature: 'house-sig' }) });
sandbox.magicblockDice = {
  available: () => true,
  roll: async () => nextRoll,
  getLastProofRollSignature: () => 'stub-proof-sig',
  ping: async () => true,
};
// Browser-faithful rAF stub: DEFERS each frame to a later tick (a real rAF
// never runs the callback synchronously inside the schedule call). The game's
// idle render engine re-queues rAF while a token blinks, so a synchronous
// loop here would recurse until the stack blows. A global frame cap keeps an
// intentionally-stuck blink from spinning forever in the sandbox.
sandbox.__rafFrames = 0;
sandbox.requestAnimationFrame = (cb) => {
  if (++sandbox.__rafFrames > 5000) return sandbox.__rafFrames;
  setTimeout(() => { try { cb(0); } catch (e) { console.error('rAF callback error:', e && e.stack || e); } }, 0);
  return sandbox.__rafFrames;
};
sandbox.cancelAnimationFrame = () => {};

sandbox.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] !== undefined ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

function loadFile(rel) {
  const full = rel.startsWith('/') ? rel : `${ROOT}/${rel}`;
  const code = fs.readFileSync(full, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: full });
}

// Load the REAL universal result bus FIRST (mirrors index.html)
loadFile(path.join(__dirname, '..', '..', 'public', 'universal', 'result-seam', 'game-result.js'));
// Load order must mirror index.html
loadFile('board.js');
loadFile('physics.js');
loadFile('mechanics/state/persistence.js');
loadFile('mechanics/state/win-detection.js');
loadFile('mechanics/state/turn.js');
loadFile('mechanics/paths/index.js');
loadFile('mechanics/actions/dice.js');
loadFile('mechanics/actions/movement.js');
loadFile('mechanics/actions/capture.js');
loadFile('mechanics/actions/ai.js');

// Trigger the DOMContentLoaded handlers (initBoard + persistence listeners)
vm.runInContext('initBoard();', sandbox);
Object.keys(listeners).filter(k => k.startsWith('dom_')).forEach(k => { try { listeners[k](); } catch (e) {} });

const T = () => vm.runInContext('({currentTurn,isDiceRolled,currentTurnMoves,hasRolledThisTurn,isGamePaused,matchOver,setupConfigurationLocked,playerProfiles,turnSequence,colorsMap,consecutiveDoubleSixes,lastDiceRoll1,lastDiceRoll2})', sandbox);
const win = () => vm.runInContext('({getFinishOrder: window.getFinishOrder, getMatchStatus: window.getMatchStatus, isSeatFinished: window.isSeatFinished, allSeatsFinished: window.allSeatsFinished, isMatchComplete: window.isMatchComplete, serializeWinState: window.serializeWinState, hydrateWinState: window.hydrateWinState, getPlayerRank: window.getPlayerRank})', sandbox);

function setAllTokensHome(color) {
  vm.runInContext(`window.tokens['${color}'].forEach(t => { t.stepsWalked = 57; t.pathIndex = -2; });`, sandbox);
}
function setTokensInYard(color) {
  vm.runInContext(`window.tokens['${color}'].forEach(t => { t.stepsWalked = 0; t.pathIndex = -1; });`, sandbox);
}
function resetAllTokensToYard() {
  vm.runInContext(`Object.keys(window.tokens).forEach(c => window.tokens[c].forEach(t => { t.stepsWalked = 0; t.pathIndex = -1; }));`, sandbox);
}
function lockFreshMatch() {
  resetAllTokensToYard();
  vm.runInContext('setupConfigurationLocked = false; window.resetWinDetection(); window.selectMatchMode("4p"); window.setMatchStatus("in-progress"); matchOver = false; window.initiateArenaMatch();', sandbox);
}
// End a 4P match the "decided" way (3 finished seats -> trailing seat auto-last).
function finishThreeSeatsIn4P() {
  setAllTokensHome('green');
  setAllTokensHome('yellow');
  setAllTokensHome('blue');
  vm.runInContext('window.checkForMatchWinner("green"); window.checkForMatchWinner("yellow"); window.checkForMatchWinner("blue");', sandbox);
}

console.log('\n== Setup: lock match as You vs 3 computers ==');
vm.runInContext('initiateArenaMatch();', sandbox);
check('setupConfigurationLocked after initiateArenaMatch', T().setupConfigurationLocked === true);

console.log('\n== Spec: finish detection = all 4 tokens stepsWalked>=57 ==');
setAllTokensHome('green');
const afterGreen = win();
check('isSeatFinished(green) after all home', afterGreen.isSeatFinished('green') === true);
check('isSeatFinished(yellow) still false', afterGreen.isSeatFinished('yellow') === false);
check('allSeatsFinished false (only green)', afterGreen.allSeatsFinished() === false);

console.log('\n== Spec: finish order recorded 1st..Nth, loop continues ==');
vm.runInContext('window.checkForMatchWinner("green");', sandbox);
let fin = win().getFinishOrder();
check('green recorded 1st', fin[0] === 'green' && fin.length === 1, JSON.stringify(fin));
check('matchStatus still in-progress after 1 seat', win().getMatchStatus() === 'in-progress');

setAllTokensHome('yellow');
vm.runInContext('window.checkForMatchWinner("yellow");', sandbox);
fin = win().getFinishOrder();
check('yellow recorded 2nd', fin[1] === 'yellow', JSON.stringify(fin));
check('matchStatus still in-progress after 2 seats', win().getMatchStatus() === 'in-progress');

console.log('\n== NEW: 4P early end - 3rd winner ends the match, last seat auto-4th ==');
setAllTokensHome('blue');
vm.runInContext('window.checkForMatchWinner("blue");', sandbox);
fin = win().getFinishOrder();
check('blue recorded 3rd', fin[2] === 'blue', JSON.stringify(fin));
check('4P match ends at 3rd winner (status finished)', win().getMatchStatus() === 'finished', win().getMatchStatus());
check('red auto-4th without playing', JSON.stringify(fin) === JSON.stringify(['green','yellow','blue','red']), JSON.stringify(fin));
const published4p = vm.runInContext('window.gfgLastGameResult', sandbox);
check('4P seam envelope published', !!published4p);
check('4P envelope 4 players', published4p && published4p.players.length === 4);
check('4P envelope positions 1..4', published4p && JSON.stringify(published4p.players.map(p => p.position)) === '[1,2,3,4]');
check('4P ceremony overlay shown', els['result-ceremony-overlay'].classList.contains('visible'));

console.log('\n== NEW: 2P early end - one winner ends the match, other auto-2nd ==');
vm.runInContext('setupConfigurationLocked = false; window.resetWinDetection(); window.setMatchStatus("in-progress"); matchOver = false; window.selectMatchMode("2p"); window.setActiveSeats(["green","red"]); window.initiateArenaMatch();', sandbox);
setAllTokensHome('green');
vm.runInContext('window.checkForMatchWinner("green");', sandbox);
fin = win().getFinishOrder();
check('2P green recorded 1st', fin[0] === 'green', JSON.stringify(fin));
check('2P match ends at 1st winner (status finished)', win().getMatchStatus() === 'finished', win().getMatchStatus());
check('2P red auto-2nd without playing', JSON.stringify(fin) === JSON.stringify(['green','red']), JSON.stringify(fin));
const published2p = vm.runInContext('window.gfgLastGameResult', sandbox);
check('2P seam envelope published', !!published2p);
check('2P envelope 2 players', published2p && published2p.players.length === 2);
check('2P envelope positions 1..2', published2p && JSON.stringify(published2p.players.map(p => p.position)) === '[1,2]');
check('2P envelope schema', published2p && published2p.schema === 'gfg:game-result@1');

console.log('\n== NEW: 2P mid-match reload restores mode + ONLY the two chosen seats ==');
vm.runInContext(`
  setupConfigurationLocked = false;
  window.resetWinDetection();
  window.setMatchStatus("in-progress");
  matchOver = false;
  window.selectMatchMode("2p");
  window.setActiveSeats(["green","red"]);
  window.initiateArenaMatch();
  currentTurn = "green"; isDiceRolled = false; currentTurnMoves = [];
  window.tokens.green.forEach(t => { t.pathIndex = 2; t.stepsWalked = 2; });
  saveGameStateToStorage();
`, sandbox);
const saved2p = JSON.parse(sandbox.localStorage.getItem('gfg_ludo_persistence_state'));
check('2P payload saves matchMode', saved2p && saved2p.matchMode === '2p', saved2p && saved2p.matchMode);
check('2P payload saves activeSeats', saved2p && JSON.stringify(saved2p.activeSeats) === '["green","red"]', saved2p && JSON.stringify(saved2p.activeSeats));
// simulate a full reload: reset in-memory module state back to the 4P default
vm.runInContext(`
  matchMode = "4p";
  activeSeats = ["green","yellow","blue","red"];
  setupConfigurationLocked = false;
  matchOver = false;
  currentTurn = "yellow";
  loadGameStateFromStorage();
`, sandbox);
check('2P reload restores matchMode', vm.runInContext('matchMode', sandbox) === '2p', vm.runInContext('matchMode', sandbox));
check('2P reload restores ONLY the two chosen seats', JSON.stringify(vm.runInContext('window.getActiveSeats()', sandbox)) === '["green","red"]', JSON.stringify(vm.runInContext('window.getActiveSeats()', sandbox)));
check('2P reload keeps setup locked', vm.runInContext('setupConfigurationLocked', sandbox) === true);
check('2P reload restores currentTurn', vm.runInContext('currentTurn', sandbox) === 'green', vm.runInContext('currentTurn', sandbox));

console.log('\n== Spec: ENDGAME auto-skip finished seat (human "You" seat) ==');
lockFreshMatch();
setAllTokensHome('green');
setAllTokensHome('yellow');
vm.runInContext('window.checkForMatchWinner("green"); window.checkForMatchWinner("yellow");', sandbox);
vm.runInContext('currentTurn = "green"; isDiceRolled = false; currentTurnMoves = []; matchOver = false; passTurnSequence();', sandbox);
const afterPass1 = T();
check('green (finished) auto-skipped to next seat', afterPass1.currentTurn !== 'green', afterPass1.currentTurn);
check('auto-skip did NOT set isDiceRolled', afterPass1.isDiceRolled === false);
check('auto-skip moved to yellow', afterPass1.currentTurn === 'yellow');

vm.runInContext('currentTurn = "yellow"; isDiceRolled = false; currentTurnMoves = []; matchOver = false; passTurnSequence();', sandbox);
const afterPass2 = T();
check('yellow (finished) auto-skipped to blue', afterPass2.currentTurn === 'blue', afterPass2.currentTurn);

console.log('\n== Spec: NO infinite cycling / loop stops once decided ==');
lockFreshMatch();
finishThreeSeatsIn4P();
check('4P match decided at 3rd winner', win().getMatchStatus() === 'finished');
const beforeStop = T().currentTurn;
vm.runInContext('passTurnSequence();', sandbox);
const afterStop = T();
check('passTurnSequence after match decided does not advance', afterStop.currentTurn === beforeStop, `before=${beforeStop} after=${afterStop.currentTurn}`);
check('matchOver true', afterStop.matchOver === true);

console.log('\n== Spec: Play Again resets to fresh match (same locked setup) ==');
lockFreshMatch();
setAllTokensHome('green');
vm.runInContext('window.checkForMatchWinner("green");', sandbox);
vm.runInContext('window.playAgainAfterCeremony();', sandbox);
fin = win().getFinishOrder();
check('finish order cleared', fin.length === 0, JSON.stringify(fin));
check('matchStatus back to in-progress', win().getMatchStatus() === 'in-progress');
check('tokens reset to yard', win().isSeatFinished('green') === false && win().isSeatFinished('red') === false);
check('currentTurn green', T().currentTurn === 'green');
check('diceBtn re-enabled', els['diceBtn'].disabled === false);
check('setup still locked (same seat setup)', T().setupConfigurationLocked === true);

console.log('\n== Spec: End Match = abandoned, never rewarded, never seam ==');
vm.runInContext(`
  window.__captured = [];
  window.onGameResult(r => window.__captured.push(r));
  window.setMatchStatus("in-progress");
  window.endMatchAbandon();
`, sandbox);
check('matchStatus abandoned', win().getMatchStatus() === 'abandoned');
check('no seam emitted on abandon', vm.runInContext('window.__captured.length', sandbox) === 0, JSON.stringify(vm.runInContext('window.__captured', sandbox)));
check('cache cleared for fresh setup', sandbox.localStorage.getItem('gfg_ludo_persistence_state') === null);

console.log('\n== Spec: reload restore of finished match -> ceremony (no resume) ==');
lockFreshMatch();
finishThreeSeatsIn4P();
// reload: reset in-memory state then restore
vm.runInContext('currentTurn = "green"; isDiceRolled = true; currentTurnMoves = [6,6]; matchOver = false; setupConfigurationLocked = false;', sandbox);
const restored = vm.runInContext('loadGameStateFromStorage()', sandbox);
check('restore of finished match loads state', restored === true);
check('finished match stays finished', win().getMatchStatus() === 'finished');
check('ceremony re-shown', els['result-ceremony-overlay'].classList.contains('visible'));

console.log('\n== Spec: reload restore of in-progress match -> resumes exact board ==');
lockFreshMatch();
vm.runInContext('window.setMatchStatus("in-progress"); matchOver=false; window.tokens.green.forEach(t => { t.pathIndex = 6; t.stepsWalked = 6; t.c = 6; t.r = 5; }); currentTurn = "yellow"; isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = []; saveGameStateToStorage();', sandbox);
const savedMid = JSON.parse(sandbox.localStorage.getItem('gfg_ludo_persistence_state'));
check('mid-match payload saved to localStorage', !!savedMid);
check('mid-match payload carries currentTurn yellow', savedMid && savedMid.currentTurn === 'yellow');
check('mid-match payload carries locked setup', savedMid && savedMid.setupConfigurationLocked === true);
vm.runInContext('currentTurn = "green"; isDiceRolled = true; currentTurnMoves = [6,6]; matchOver = false; setupConfigurationLocked = false;', sandbox);
vm.runInContext('loadGameStateFromStorage();', sandbox);
check('reload restores currentTurn yellow', T().currentTurn === 'yellow', T().currentTurn);
check('reload restores green token position (6 steps)', vm.runInContext('window.tokens.green[0].stepsWalked === 6', sandbox) === true);
check('reload keeps setup locked', T().setupConfigurationLocked === true);

console.log('\n== Spec: STALE in-progress match (24h+) -> abandoned on reload ==');
lockFreshMatch();
vm.runInContext('window.setMatchStatus("in-progress"); currentTurn = "green"; isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = [];', sandbox);
vm.runInContext('saveGameStateToStorage();', sandbox);
// age the saved payload beyond the 24h stale window (recompute the integrity
// digest so only the STALENESS is under test, not the tamper detection)
vm.runInContext(`
  const p = JSON.parse(localStorage.getItem('gfg_ludo_persistence_state'));
  p.savedAt = Date.now() - 25 * 60 * 60 * 1000;
  const str = JSON.stringify(p);
  localStorage.setItem('gfg_ludo_persistence_state', str);
  localStorage.setItem('gfg_ludo_persistence_state_digest', hashStateString(str));
`, sandbox);
vm.runInContext('setupConfigurationLocked = false; matchOver = false; currentTurn = "red";', sandbox);
vm.runInContext('const origLoad = loadGameStateFromStorage; loadGameStateFromStorage = function(){ const r = origLoad(); console.log("  DBG load returned", r, "status", window.getMatchStatus(), "savedAt", localStorage.getItem("gfg_ludo_persistence_state") ? JSON.parse(localStorage.getItem("gfg_ludo_persistence_state")).savedAt : null); return r; };', sandbox);
const staleLoad = vm.runInContext('loadGameStateFromStorage()', sandbox);
// An abandoned restore resets to a FRESH, unlocked setup (status 'in-progress'
// again, cache cleared) — that IS the abandoned outcome, not status=abandoned.
check('stale match treated as abandoned', staleLoad === true && win().getMatchStatus() === 'in-progress' && T().setupConfigurationLocked === false, win().getMatchStatus());
check('stale match cache cleared', sandbox.localStorage.getItem('gfg_ludo_persistence_state') === null);
check('stale match returns to fresh setup (unlocked)', T().setupConfigurationLocked === false);

console.log('\n== Spec: interrupted-roll recovery on reload ==');
lockFreshMatch();
vm.runInContext('window.setMatchStatus("in-progress"); currentTurn = "blue"; isDiceRolled = true; hasRolledThisTurn = true; currentTurnMoves = []; saveGameStateToStorage();', sandbox);
vm.runInContext('isDiceRolled = true; hasRolledThisTurn = true; currentTurn = "green";', sandbox);
vm.runInContext('loadGameStateFromStorage();', sandbox);
check('roll started but never finalized -> re-armed (isDiceRolled false)', T().isDiceRolled === false, T().isDiceRolled);
check('re-armed keeps hasRolledThisTurn false', T().hasRolledThisTurn === false);

console.log('\n== Spec: PAUSE / RESUME (manual pause must never eat the turn) ==');
lockFreshMatch();
vm.runInContext('currentTurn = "green"; isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = [];', sandbox);
vm.runInContext('toggleArenaPauseState();', sandbox);
check('pause sets isGamePaused', T().isGamePaused === true);
check('pause button reads Resume', els['pauseBtn'].innerText === '▶ Resume');
vm.runInContext('toggleArenaPauseState();', sandbox);
check('resume clears isGamePaused', T().isGamePaused === false);
check('resume button reads Pause', els['pauseBtn'].innerText === '⏸ Pause');

vm.runInContext('toggleArenaPauseState(); rollDiceEngine();', sandbox);
check('dice click while paused is blocked (no roll starts)', T().isDiceRolled === false, T().isDiceRolled);
vm.runInContext('toggleArenaPauseState();', sandbox);
vm.runInContext('rollDiceEngine();', sandbox);
check('dice click after resume starts the roll', T().isDiceRolled === true, T().isDiceRolled);

vm.runInContext(`
  window.setMatchStatus("in-progress"); matchOver = false;
  window.tokens.green.forEach((t,i) => { t.pathIndex = i; t.stepsWalked = i; });
  currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true; currentTurnMoves = [3,5];
  toggleArenaPauseState();
`, sandbox);
check('paused before the move', T().isGamePaused === true);
vm.runInContext('toggleArenaPauseState();', sandbox);
const b2 = vm.runInContext('window.tokens.green[0].stepsWalked', sandbox);
vm.runInContext('window.processTokenMovementExecution(0);', sandbox);
const a2 = vm.runInContext('window.tokens.green[0].stepsWalked', sandbox);
check('token tap after resume moves the piece', a2 === b2 + 3, `before=${b2} after=${a2}`);

console.log('\n== DOUBLE-6 "Shoki": up to THREE bonus rolls then pass ==');
lockFreshMatch();
vm.runInContext('window.tokens.green.forEach((t,i) => { t.pathIndex = i; t.stepsWalked = i; t.c = 1; t.r = 6; }); currentTurn = "green"; isDiceRolled = true; hasRolledThisTurn = true;', sandbox);
vm.runInContext(`
  currentTurnMoves = [6, 6]; consecutiveDoubleSixes = 1; lastDiceRoll1 = 6; lastDiceRoll2 = 6;
  window.processTokenMovementExecution(0); // use first 6
  window.processTokenMovementExecution(0); // use second 6 -> resolveTurnEndAfterMoves
`, sandbox);
check('1st double6 -> bonus turn kept (still green)', T().currentTurn === 'green', T().currentTurn);
check('1st double6 -> isDiceRolled reset for bonus roll', T().isDiceRolled === false);

vm.runInContext(`
  isDiceRolled = true; hasRolledThisTurn = true;
  currentTurnMoves = [6, 6]; consecutiveDoubleSixes = 2; lastDiceRoll1 = 6; lastDiceRoll2 = 6;
  window.processTokenMovementExecution(0);
  window.processTokenMovementExecution(0);
`, sandbox);
check('2nd double6 -> bonus turn kept (still green)', T().currentTurn === 'green', T().currentTurn);

vm.runInContext(`
  isDiceRolled = true; hasRolledThisTurn = true;
  currentTurnMoves = [6, 6]; consecutiveDoubleSixes = 3; lastDiceRoll1 = 6; lastDiceRoll2 = 6;
  window.processTokenMovementExecution(0);
  window.processTokenMovementExecution(0);
`, sandbox);
check('3rd double6 -> NO bonus granted (isDiceRolled stays true)', T().isDiceRolled === true, T().isDiceRolled);
check('3rd double6 -> counter force-reset to 0 (streak over)', vm.runInContext('consecutiveDoubleSixes', sandbox) === 0, vm.runInContext('consecutiveDoubleSixes', sandbox));

console.log('\n== DOUBLE-6 "Shoki": bonus kept even with NO usable moves ==');
vm.runInContext(`
  window.setMatchStatus("in-progress"); matchOver=false;
  window.tokens.green.forEach(t => { t.stepsWalked = 57; t.pathIndex = -2; });
  window.tokens.yellow.forEach(t => { t.pathIndex = 0; t.stepsWalked = 0; t.c = 8; t.r = 0; });
  currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true;
  currentTurnMoves = [6, 6]; consecutiveDoubleSixes = 1; lastDiceRoll1 = 6; lastDiceRoll2 = 6;
  if (typeof window.resolveTurnEndAfterMoves === 'function') window.resolveTurnEndAfterMoves();
`, sandbox);
check('double6 with no moves still grants bonus (green stays)', T().currentTurn === 'green', T().currentTurn);
check('double6 with no moves resets isDiceRolled', T().isDiceRolled === false);

console.log('\n== DOUBLE-6 HARDENING: stale counter on a NON-double roll must NOT grant a bonus ==');
vm.runInContext(`
  window.setMatchStatus("in-progress"); matchOver=false;
  currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true;
  currentTurnMoves = [2, 6]; consecutiveDoubleSixes = 2; lastDiceRoll1 = 2; lastDiceRoll2 = 6;
  window.processTokenMovementExecution(0);
  window.processTokenMovementExecution(0);
`, sandbox);
check('2+6 with stale counter -> NO bonus (isDiceRolled stays true)', T().isDiceRolled === true, T().isDiceRolled);
check('2+6 with stale counter -> counter force-reset to 0', vm.runInContext('consecutiveDoubleSixes', sandbox) === 0, vm.runInContext('consecutiveDoubleSixes', sandbox));
vm.runInContext(`
  currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true;
  currentTurnMoves = [3, 5]; consecutiveDoubleSixes = 3; lastDiceRoll1 = 3; lastDiceRoll2 = 5;
  window.processTokenMovementExecution(0);
  window.processTokenMovementExecution(0);
`, sandbox);
check('3+5 with stale counter -> NO bonus (isDiceRolled stays true)', T().isDiceRolled === true, T().isDiceRolled);
check('3+5 with stale counter -> counter force-reset to 0', vm.runInContext('consecutiveDoubleSixes', sandbox) === 0, vm.runInContext('consecutiveDoubleSixes', sandbox));

(async () => {
  // Drain any passTurnSequence timers left by the synchronous movement tests
  // so this final double-6 test is fully isolated (no turn-wrap flakiness).
  await new Promise(r => setTimeout(r, 900));

  console.log('\n== Spec: PAUSE / RESUME async (roll completes, computer re-triggers) ==');
  // Pause on the human's turn, resume: the human must NOT get an automated
  // roll (2P regression: a stale computer timer must never roll a human seat),
  // and a manual dice tap must still work and finalize after resume.
  lockFreshMatch();
  vm.runInContext(`
    currentTurn = 'green'; isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = [];
    window.tokens.green.forEach(t => { t.pathIndex = 0; t.stepsWalked = 0; });
    toggleArenaPauseState();      // paused
    rollDiceEngine();             // dice tapped while paused -> blocked
  `, sandbox);
  check('paused roll stays blocked', T().isDiceRolled === false, T().isDiceRolled);
  vm.runInContext('toggleArenaPauseState();', sandbox);   // resume
  check('resume clears pause', T().isGamePaused === false);
  await new Promise(r => setTimeout(r, 300));
  check('no phantom auto-roll on the human seat after resume', T().isDiceRolled === false, `isDiceRolled=${T().isDiceRolled} turn=${T().currentTurn}`);
  vm.runInContext('rollDiceEngine();', sandbox);   // human taps the dice after resume
  await new Promise(r => setTimeout(r, 300));
  check('human can roll again after resume', T().isDiceRolled === true, T().isDiceRolled);
  await new Promise(r => setTimeout(r, 900));
  check('human roll after resume finalizes moves', Array.isArray(T().currentTurnMoves) && T().currentTurnMoves.length === 2, JSON.stringify(T().currentTurnMoves));

  // Computer seat: pause then resume -> the automated roll re-triggers.
  vm.runInContext(`
    window.setMatchStatus("in-progress"); matchOver = false;
    isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = []; displayDiceOnBoard = false;
    currentTurn = 'yellow';
    toggleArenaPauseState();      // paused during the computer's turn
  `, sandbox);
  check('paused computer turn', T().isGamePaused === true);
  vm.runInContext('toggleArenaPauseState();', sandbox);   // resume
  check('resumed computer turn', T().isGamePaused === false);
  await new Promise(r => setTimeout(r, 1300));
  check('computer auto-roll re-triggered after resume', T().isDiceRolled === true, T().isDiceRolled);

  // 3rd double6 pass is scheduled via setTimeout(500) — verify it lands.
  vm.runInContext(`
    window.__passCalls = 0;
    const origPass = passTurnSequence;
    passTurnSequence = function () { window.__passCalls++; return origPass.apply(this, arguments); };
  `, sandbox);
  vm.runInContext(`
    setupConfigurationLocked = false;
    window.selectMatchMode("4p");
    window.setMatchStatus("in-progress"); matchOver = false;
    window.tokens.green.forEach(t => { t.pathIndex = 0; t.stepsWalked = 0; });
    currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true;
    currentTurnMoves = []; consecutiveDoubleSixes = 3; lastDiceRoll1 = 6; lastDiceRoll2 = 6;
    window.resolveTurnEndAfterMoves();
  `, sandbox);
  await new Promise(r => setTimeout(r, 800));
  check('3rd double6 -> pass fires and seat advances', vm.runInContext('window.__passCalls >= 1 && currentTurn !== "green"', sandbox), vm.runInContext('currentTurn', sandbox));

  console.log('\n== Spec: pending on-chain push queue (backup plan with tamper hash) ==');
  sandbox.localStorage.removeItem('gfg_pending_onchain_pushes');
  vm.runInContext('window.registerPendingPushHandler("reward", async (p) => { window.__pushed = p; return true; }); window.queuePendingPush("reward", { matchId: "abc" });', sandbox);
  check('push queued', vm.runInContext('window.getPendingPushes().length', sandbox) === 1);
  await vm.runInContext('window.flushPendingPushes()', sandbox);
  check('flush pushes via registered handler', vm.runInContext('window.__pushed && window.__pushed.matchId === "abc"', sandbox) === true);
  check('pushed entry dropped from queue', vm.runInContext('window.getPendingPushes().length', sandbox) === 0);

  // Tampered entry: digest mismatch -> dropped + loud warning, never pushed.
  sandbox.localStorage.removeItem('gfg_pending_onchain_pushes');
  vm.runInContext(`
    const arr = [{ type: "reward", payload: { matchId: "tampered" }, createdAt: Date.now(), digest: "WRONGDIGEST" }];
    localStorage.setItem("gfg_pending_onchain_pushes", JSON.stringify(arr));
    window.__pushed = null;
  `, sandbox);
  await vm.runInContext('window.flushPendingPushes()', sandbox);
  check('tampered pending push is dropped', vm.runInContext('window.getPendingPushes().length', sandbox) === 0);
  check('tampered pending push never pushed', vm.runInContext('window.__pushed === null', sandbox) === true);
  check('tampered pending push warns the player', vm.runInContext('window.getLastPersistenceWarning() !== null', sandbox) === true);

  console.log('\n== Spec: tamper / integrity digest on the save cache ==');
  sandbox.localStorage.removeItem('gfg_ludo_persistence_state');
  sandbox.localStorage.removeItem('gfg_ludo_persistence_state_digest');
  vm.runInContext(`
    saveGameStateToStorage();
    const raw = JSON.parse(localStorage.getItem('gfg_ludo_persistence_state'));
    raw.tokensSnapshot.green[0].stepsWalked = 99; // console tampering
    localStorage.setItem('gfg_ludo_persistence_state', JSON.stringify(raw));
  `, sandbox);
  const tamperLoad = vm.runInContext('loadGameStateFromStorage()', sandbox);
  check('tampered payload refused (returns false)', tamperLoad === false);
  check('tampered cache cleared', sandbox.localStorage.getItem('gfg_ludo_persistence_state') === null);
  check('tampered payload warns loudly', vm.runInContext('window.getLastPersistenceWarning() !== null', sandbox) === true);

  console.log('\n== Spec: on-chain outage pause survives a refresh ==');
  // A failed roll enters chain-down (banner + monitor, dice disabled) and the
  // paused state is persisted. A refresh during the outage must restore into
  // the SAME paused state (banner + monitor re-armed, no false roll) and the
  // banner's Refresh button must recover once the stack answers again.
  lockFreshMatch();
  vm.runInContext(`
    currentTurn = 'green'; isDiceRolled = false; hasRolledThisTurn = false; currentTurnMoves = [];
    window.setChainDownState(false);
    enterChainDownState();
  `, sandbox);
  check('outage sets chain-down', vm.runInContext('isChainDown', sandbox) === true);
  check('outage disables the dice button', els['diceBtn'].disabled === true);
  const savedChainDown = JSON.parse(sandbox.localStorage.getItem('gfg_ludo_persistence_state'));
  check('outage state persisted (isChainDown true)', savedChainDown && savedChainDown.isChainDown === true, savedChainDown && JSON.stringify(savedChainDown.isChainDown));

  // Simulate a refresh DURING the outage: fresh in-memory flags, restore from storage.
  vm.runInContext(`
    isChainDown = false; isGamePaused = false; setupConfigurationLocked = false;
    currentTurn = 'green'; isDiceRolled = true; hasRolledThisTurn = true; currentTurnMoves = [6,6];
    loadGameStateFromStorage();
  `, sandbox);
  check('refresh during outage re-arms chain-down', vm.runInContext('isChainDown', sandbox) === true);
  check('refresh during outage re-disables the dice button', els['diceBtn'].disabled === true);
  check('refresh during outage keeps the match locked', T().setupConfigurationLocked === true);
  await new Promise(r => setTimeout(r, 1700));
  check('no false auto-roll while chain-down restored', T().isDiceRolled === false, T().isDiceRolled);
  vm.runInContext('resumeFromChainDown();', sandbox);
  check('recovery clears chain-down', vm.runInContext('isChainDown', sandbox) === false);
  check('recovery re-enables the dice button', els['diceBtn'].disabled === false);
  sandbox.localStorage.removeItem('gfg_ludo_persistence_state');
  sandbox.localStorage.removeItem('gfg_ludo_persistence_state_digest');

  console.log('\n== Spec: 2P turn label syncs to the chosen starting seat ==');
  vm.runInContext(`
    setupConfigurationLocked = false; matchOver = false; window.resetWinDetection();
    window.setMatchStatus('in-progress');
    window.selectMatchMode('2p');
    window.setActiveSeats(['yellow','red']);
    window.playerProfiles.yellow = { mode: 'human', isUser: true };
    window.playerProfiles.red = { mode: 'computer', isUser: false };
    window.playerProfiles.green.isUser = false; window.playerProfiles.green.mode = 'human';
    window.playerProfiles.blue.isUser = false; window.playerProfiles.blue.mode = 'computer';
    document.getElementById('type-yellow').value = 'you';
    document.getElementById('type-red').value = 'computer';
    window.initiateArenaMatch();
  `, sandbox);
  check('2P match starts on the user seat (yellow)', T().currentTurn === 'yellow', T().currentTurn);
  check('2P dice-box turn label shows Yellow', els['turn-indicator'].innerText === "Yellow's Turn", els['turn-indicator'].innerText);
  check('2P dice-box turn label uses the seat colour', els['turn-indicator'].style.color === vm.runInContext('colorsMap.yellow', sandbox), els['turn-indicator'].style.color);

  console.log(`\n================  RESULT: ${passed} passed, ${failed} failed  ================`);
  process.exit(failed ? 1 : 0);
})();
