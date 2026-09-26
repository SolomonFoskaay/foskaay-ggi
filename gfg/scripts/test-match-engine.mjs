// scripts/test-match-engine.mjs — proves the off-chain engine is deterministic:
// two independent "devices" applying the same moves produce the SAME digest, and
// a tampered move produces a DIFFERENT digest (so a forged log is detectable).
//
// Pure logic test, no chain, no spend.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../public/universal/settlement/match-engine.js', import.meta.url), 'utf8');
const sandboxWin = { gfgChain: { isArc: () => true }, TextEncoder };
const fn = new Function('window', 'TextEncoder', src + '\nreturn window.gfgMatchEngine;');
const eng = fn(sandboxWin, TextEncoder);

function playSequence(engine) {
    engine.open({ gameTag: 'ludo', matchRef: 42, players: ['A', 'B'], seats: 2, turnSecs: 50 });
    engine.move(0, { token: 1, from: 0, to: 6 });
    engine.move(1, { token: 2, from: 0, to: 6 });
    engine.move(0, { token: 1, from: 6, to: 12 });
    engine.setTurn(1);
    engine.close({ winner: 0, finishOrder: [0, 1], points: 100 });
    return engine.summary().digest;
}

const a = playSequence(eng);
eng.reset();
const b = playSequence(eng);
eng.reset();

// Tampered log: same moves but one differs.
eng.open({ gameTag: 'ludo', matchRef: 42, players: ['A', 'B'], seats: 2, turnSecs: 50 });
eng.move(0, { token: 1, from: 0, to: 6 });
eng.move(1, { token: 2, from: 0, to: 6 });
eng.move(0, { token: 1, from: 6, to: 99 }); // tampered
eng.setTurn(1);
eng.close({ winner: 0, finishOrder: [0, 1], points: 100 });
const tampered = eng.summary().digest;

console.log('device A digest: ', a);
console.log('device B digest: ', b);
console.log('tampered digest: ', tampered);
console.log('');
console.log(a === b ? 'PASS: two devices agree (deterministic)' : 'FAIL: devices disagree');
console.log(a !== tampered ? 'PASS: tampering changes the digest (detectable)' : 'FAIL: tamper not detected');
if (a !== b || a === tampered) process.exit(1);
