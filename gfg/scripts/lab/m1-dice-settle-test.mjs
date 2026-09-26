// M1 dice-settle harness: runs the REAL ludo-lab physics loop headless for every
// (v1,v2) roll combo across random seeds and asserts the final settled cube shows
// EXACTLY the ER VRF face-up value. This is the regression proof for the
// "natural settle can end on a wrong face" bug the owner reported (e.g. 5+5
// from VRF displaying 1+1).
import vm from 'vm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PHYSICS_JS = path.join(ROOT, 'public', 'games', 'ludo-lab', 'physics.js');
const STYLE_CSS = path.join(ROOT, 'public', 'games', 'ludo-lab', 'style.css');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; } else { fail++; console.log('  FAIL ' + name); }
}

// ---- CSS face transforms (same as the orientation harness) ------------------
const css = fs.readFileSync(STYLE_CSS, 'utf8');
const cssTransforms = {};
const cssRe = /\.gfg-die-face-([a-z]+)\s*\{\s*transform:\s*([^;]+);/g;
let m;
while ((m = cssRe.exec(css)) !== null) cssTransforms[m[1]] = m[2].trim();

function rotX(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
function rotY(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
function matMul(a, b) { return a.map((row, i) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])); }
function applyMat(mat, v) { return [0, 1, 2].map((i) => mat[i][0] * v[0] + mat[i][1] * v[1] + mat[i][2] * v[2]); }
function cssFaceNormal(transform) {
  let n = [0, 0, 1];
  const re = /rotate([XY])\((-?[\d.]+)deg\)/g;
  let r;
  while ((r = re.exec(transform)) !== null) n = r[1] === 'X' ? applyMat(rotX(parseFloat(r[2])), n) : applyMat(rotY(parseFloat(r[2])), n);
  return n;
}
function quatToMat(q) {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
  ];
}

const src = fs.readFileSync(PHYSICS_JS, 'utf8');
// eslint-disable-next-line no-eval
const faceClass = eval('({' + src.match(/const faceClass = \{(.*?)\};/s)[1] + '})');
const PRES = matMul(rotY(12), rotX(18));

function faceUpValue(q) {
  const Q = quatToMat(q);
  let best = 0, bestY = -Infinity;
  for (const [value, cls] of Object.entries(faceClass)) {
    const world = applyMat(PRES, applyMat(Q, cssFaceNormal(cssTransforms[cls] || '')));
    if (world[1] > bestY) { bestY = world[1]; best = Number(value); }
  }
  return best;
}

// ---- load the real physics in a vm sandbox with browser-faithful rAF --------
let rng = 0; // simple deterministic RNG per run
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
};
sandbox.window = sandbox;
sandbox.requestAnimationFrame = (cb) => { setTimeout(() => { try { cb(0); } catch (e) { console.error('rAF error', e && e.message); } }, 0); return ++sandbox.__frames; };
sandbox.cancelAnimationFrame = () => {};
sandbox.finalizeDiceScores = () => { sandbox.__finalized = true; };
sandbox.drawLudoLayout = () => {};
sandbox.playDiceTick = () => {};
sandbox.playDiceRattle = () => {};
sandbox.__frames = 0;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(PHYSICS_JS, 'utf8'), sandbox, { filename: PHYSICS_JS });

function runRoll(v1, v2, seed, vOverride) {
  // Deterministic pseudo-random sequence for this seed (replace Math.random
  // inside the vm via a seeded wrapper).
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  sandbox.__random = next;
  sandbox.Math = Object.assign(Object.create(Math), { random: next });

  sandbox.__frames = 0;
  sandbox.__finalized = false;
  const mk = vOverride
    ? `{ x: 200, y: 260, vx: ${vOverride[0]}, vy: ${vOverride[1]}, value: ${v1}, finalValue: ${v1}, q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) }`
    : `{ x: 200, y: 260, vx: (Math.random() * 14) - 7, vy: (Math.random() * 14) - 7, value: ${v1}, finalValue: ${v1}, q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) }`;
  const mk2 = vOverride
    ? `{ x: 310, y: 300, vx: ${-vOverride[0]}, vy: ${-vOverride[1]}, value: ${v2}, finalValue: ${v2}, q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) }`
    : `{ x: 310, y: 300, vx: (Math.random() * 14) - 7, vy: (Math.random() * 14) - 7, value: ${v2}, finalValue: ${v2}, q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) }`;
  vm.runInContext(`(function() {
    physicalDice = [${mk}, ${mk2}];
    runDicePhysicsCalculations();
  })()`, sandbox);
}

async function settleAndCheck(v1, v2, seed) {
  // Poll until the physics loop finishes (self-terminates when settled), with a
  // generous hard cap so a loaded CI box never spuriously fails.
  const t0 = Date.now();
  let res = null;
  while (Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 30));
    res = vm.runInContext('({ settled: physicalDice[0]._settledExact && physicalDice[1]._settledExact, q1: physicalDice[0].q, q2: physicalDice[1].q })', sandbox);
    if (res.settled) break;
  }
  total.checked++;
  const f1 = faceUpValue(res.q1);
  const f2 = faceUpValue(res.q2);
  const ok = res.settled && f1 === v1 && f2 === v2;
  check(`${v1}+${v2} seed ${seed}: settled=${res.settled} faceUp=${f1}+${f2}`, ok);
  if (!ok) total.bad++;
}

const total = { bad: 0, checked: 0 };
// Sample every combo across a handful of seeds.
for (let v1 = 1; v1 <= 6; v1++) {
  for (let v2 = 1; v2 <= 6; v2++) {
    const seeds = [1, 7, 42, 99, 2001];
    for (const seed of seeds) {
      runRoll(v1, v2, seed);
      await settleAndCheck(v1, v2, seed);
    }
  }
}
// Hammer the owner's exact reported failures (5+5 -> 1+1, 6+4 -> 6+1) hard.
for (const [v1, v2] of [[5, 5], [6, 4]]) {
  for (let seed = 1000; seed < 1050; seed++) {
    runRoll(v1, v2, seed);
    await settleAndCheck(v1, v2, seed);
  }
}
// Adversarial throws: slam both dice hard into opposite walls so boundary
// bounces + settle interact across the whole board.
for (const v of [[9, 9], [-9, 9], [9, -9], [-9, -9], [12, 3], [-12, -3]]) {
  for (let seed = 5000; seed < 5020; seed++) {
    runRoll(3, 4, seed, v);
    await settleAndCheck(3, 4, seed);
  }
}

console.log(`\nchecked ${total.checked} roll-seed combos, ${total.bad} ended with a wrong face-up value`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
