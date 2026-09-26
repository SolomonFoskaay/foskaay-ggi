// M1 dice-orientation harness: proves the 3D CSS cubes show EXACTLY the roll
// value the MagicBlock ER VRF returned, on the face-up side.
//
// The settled cube's quaternion (DICE_Q_COMPUTE_TARGET) puts the roll's face
// normal at +Y (board-up). The user then reads the pips of whatever CSS face
// ends up physically on top. So the CSS face transforms (style.css) MUST agree
// with DICE_FACE_NORMALS (physics.js): the class that holds value v's pips has
// to point where the JS thinks face v points. This harness parses the REAL
// shipped CSS + the REAL math, applies the same presentation tilt the renderer
// uses, and asserts the face-up value === the VRF roll for all six faces.
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
  if (ok) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// ---- load the REAL physics math in a vm sandbox (browser-like) ------------
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(PHYSICS_JS, 'utf8'), sandbox, { filename: PHYSICS_JS });

// ---- parse the REAL CSS face transforms -----------------------------------
const css = fs.readFileSync(STYLE_CSS, 'utf8');
const cssTransforms = {};
const cssRe = /\.gfg-die-face-([a-z]+)\s*\{\s*transform:\s*([^;]+);/g;
let m;
while ((m = cssRe.exec(css)) !== null) cssTransforms[m[1]] = m[2].trim();

// Rotation matrices exactly per css-transforms-2 (standard right-handed).
function rotX(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function rotY(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
function matMul(a, b) {
  return a.map((row, i) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}
function applyMat(mat, v) {
  return [0, 1, 2].map((i) => mat[i][0] * v[0] + mat[i][1] * v[1] + mat[i][2] * v[2]);
}
// Normal of a face given its CSS transform string (rotations only; translateZ
// does not change a face's orientation). Applies rotations left-to-right
// (the CSS order), then flattens the roundtrip of [0,0,1].
function cssFaceNormal(transform) {
  let normal = [0, 0, 1];
  const re = /rotate([XY])\((-?[\d.]+)deg\)/g;
  let r;
  while ((r = re.exec(transform)) !== null) {
    const deg = parseFloat(r[2]);
    normal = r[1] === 'X' ? applyMat(rotX(deg), normal) : applyMat(rotY(deg), normal);
  }
  return normal;
}

// Quaternion -> rotation matrix (standard convention, q = [w,x,y,z]).
function quatToMat(q) {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
  ];
}

// ---- parse the REAL faceClass map from physics.js --------------------------
const src = fs.readFileSync(PHYSICS_JS, 'utf8');
const fcMatch = src.match(/const faceClass = \{(.*?)\};/s);
if (!fcMatch) { console.error('faceClass map not found in physics.js'); process.exit(1); }
// eslint-disable-next-line no-eval
const faceClass = eval('({' + fcMatch[1] + '})');

// const/let top-level names don't become vm globals (only function/var do), so
// parse the normals map from source too.
const nMatch = src.match(/const DICE_FACE_NORMALS = \{(.*?)\};/s);
if (!nMatch) { console.error('DICE_FACE_NORMALS not found in physics.js'); process.exit(1); }
// eslint-disable-next-line no-eval
const jsNormals = eval('({' + nMatch[1] + '})');

// ---- cross-check: CSS face normals vs the JS DICE_FACE_NORMALS -------------
console.log('--- CSS face transforms agree with JS DICE_FACE_NORMALS ---');
for (const [value, cls] of Object.entries(faceClass)) {
  const cssN = cssFaceNormal(cssTransforms[cls] || '');
  const jsN = jsNormals[value];
  const ok = cssN.length === 3 && jsN && cssN.every((v, i) => Math.abs(v - jsN[i]) < 1e-9);
  check(`face ${value} (${cls}) CSS normal [${cssN.map((v) => v.toFixed(2)).join(',')}] == JS [${jsN ? jsN.join(',') : '??'}]`, ok);
  if (!cssTransforms[cls]) console.log('    (missing CSS rule for .gfg-die-face-' + cls + ')');
}

// ---- settle + presentation tilt: which face is up for each roll? -----------
console.log('--- settled cube face-up value vs VRF roll ---');
// Same presentation the renderer applies: 'rotateY(12deg) rotateX(18deg) rotate3d(q)'
const PRES = matMul(rotY(12), rotX(18));
let okCount = 0;
for (let v = 1; v <= 6; v++) {
  const target = sandbox.DICE_Q_COMPUTE_TARGET(v, { _spinAngle: 0 });
  const Q = quatToMat(target);
  let best = 0, bestY = -Infinity;
  for (const [value, cls] of Object.entries(faceClass)) {
    const world = applyMat(PRES, applyMat(Q, cssFaceNormal(cssTransforms[cls] || '')));
    if (world[1] > bestY) { bestY = world[1]; best = Number(value); }
  }
  check(`VRF roll ${v} -> face-up shows ${best}`, best === v);
  if (best === v) okCount++;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
