// scripts/test-dispute.mjs — proves the FREE dispute verifier works:
//   1. A truthful reveal of the move log reproduces the co-signed digest.
//   2. A TAMPERED reveal does NOT (so a lied-about game is caught).
// The verifier used here mirrors the relayer's replayDigestFromMoves; the digest
// itself comes from the browser engine, so this also proves the two agree.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../public/universal/settlement/match-engine.js', import.meta.url), 'utf8');
const sandboxWin = { gfgChain: { isArc: () => true }, TextEncoder };
const eng = new Function('window', 'TextEncoder', src + '\nreturn window.gfgMatchEngine;')(sandboxWin, TextEncoder);

// ---- mirror of the relayer verifier (must match byte-for-byte) --------------
function rolling(prevHex, moveStr) {
  const bytes = Buffer.from((prevHex || '0') + '|' + moveStr, 'utf8');
  let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (Math.imul(h2 ^ bytes[i], 2246822519) + h1) >>> 0;
  }
  const hx = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return '0x' + hx(h1) + hx(h2) + hx((h1 ^ h2) >>> 0) + hx(Math.imul(h1, h2) >>> 0) +
    hx((h1 + bytes.length) >>> 0) + hx((h2 ^ bytes.length) >>> 0) +
    hx((h1 ^ 0x9e3779b9) >>> 0) + hx((h2 + 0x85ebca6b) >>> 0);
}
function serverReplay(entries, meta, result) {
  let d = rolling('0', 'open:' + String((meta && meta.matchRef) || 0));
  for (const e0 of (entries || [])) {
    const e = e0 || {};
    const mv = (e.move !== undefined) ? e.move : e;
    const seat = (e.seat != null) ? e.seat : 0;
    const keys = (mv && typeof mv === 'object' && !Array.isArray(mv)) ? Object.keys(mv).sort() : undefined;
    const canonical = JSON.stringify(mv == null ? null : mv, keys);
    d = rolling(d, 'move:' + seat + ':' + canonical);
  }
  if (result !== undefined && result !== null) {
    const rk = (typeof result === 'object' && !Array.isArray(result)) ? Object.keys(result).sort() : undefined;
    d = rolling(d, 'result:' + JSON.stringify(result, rk));
  }
  return d;
}

// ---- play a match on the engine (the source of truth) ----------------------
eng.open({ gameTag: 'ludo', matchRef: 777, seats: 2, turnSecs: 45 });
const moves = [
  { seat: 0, move: { roll: [3, 5], seat: 'green' } },
  { seat: 1, move: { roll: [6, 2], seat: 'yellow' } },
  { seat: 0, move: { token: 1, from: 0, to: 8 } },
  { seat: 1, move: { pass: 1, to: 0, t: 1234 } },
];
for (const m of moves) eng.move(m.seat, m.move);
eng.close({ winner: 0, finishOrder: [0, 1] });
const signed = eng.summary().digest;

// The revealed log is [{ seat, move }]: the SEAT INDEX is what the engine hashed.
const revealed = eng.state().moves.map(x => ({ seat: x.seat, move: x.move }));

const result = eng.summary().result;
const honest = serverReplay(revealed, { matchRef: 777 }, result);
console.log('co-signed digest :', signed);
console.log('revealed replay  :', honest);

const tamperedList = revealed.map((e, i) => i === 2 ? { seat: e.seat, move: { token: 1, from: 0, to: 99 } } : e);
const tampered = serverReplay(tamperedList, { matchRef: 777 }, result);
console.log('tampered replay  :', tampered);
console.log('');
const ok1 = String(honest).toLowerCase() === String(signed).toLowerCase();
const ok2 = String(tampered).toLowerCase() !== String(signed).toLowerCase();
console.log(ok1 ? 'PASS: an honest reveal reproduces the co-signed digest' : 'FAIL: honest reveal did not match');
console.log(ok2 ? 'PASS: a tampered reveal is caught (digest differs)' : 'FAIL: tamper not caught');
if (!ok1 || !ok2) process.exit(1);
