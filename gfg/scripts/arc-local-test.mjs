// scripts/arc-local-test.mjs — exercise the Arc relayer path end to end.
// Calls the SAME handler the browser hits (/api/arc) with a small res shim, so
// this proves the exact production path: reads, dice, life, points, global,
// open/settle and the usage summary. Reads the local env; prints no secrets.
import './load-env.mjs';
import { keccak256, toHex } from 'viem';
import handler from '../api_handlers/arc-relay.mjs';

function call(action, params) {
  return new Promise((resolve) => {
    const req = { method: 'POST', body: JSON.stringify({ action, params }), headers: {} };
    let done = false;
    const res = {
      _c: 200,
      setHeader() { return this; },
      status(c) { this._c = c; return this; },
      json(o) { if (!done) { done = true; resolve({ status: this._c, body: o }); } },
      end() { if (!done) { done = true; resolve({ status: this._c, body: null }); } },
    };
    handler(req, res).catch((e) => resolve({ status: 500, body: { error: e.message } }));
  });
}

const PLAYER = '0x000000000000000000000000000000000000dEaD';
const P2 = '0x000000000000000000000000000000000000bEEF';
const tag = 'ludo';

function line(label, r) {
  const b = r.body || {};
  const ok = r.status === 200 && b.ok !== false;
  const extra = b.txHash ? (' tx ' + b.txHash.slice(0, 12) + '… gas ' + b.gas + ' usdc ' + b.usdc)
    : b.error ? (' ERROR ' + b.error) : '';
  console.log((ok ? 'PASS ' : 'FAIL ') + label.padEnd(22) + extra);
  return b;
}

const out = {};
out.usage0 = await call('arcUsage', {});
line('arcUsage (before)', out.usage0);

out.read0 = await call('readPlayer', { player: PLAYER, tag });
const r0 = line('readPlayer (before)', out.read0);
if (r0.ok) console.log('     before: lives', r0.lives.used + '/' + r0.lives.pool, '| bucket', r0.bucket.pure + '/' + r0.bucket.spendable, '| global', r0.globals.lifetime);

const batchId = keccak256(toHex('luditest-batch-' + Date.now()));
const gameId = keccak256(toHex('luditest-game-' + Date.now()));
const matchRef = Date.now();

line('commitDiceSeed', await call('commitDiceSeed', { batchId }));
out.roll1 = await call('rollDice', { gameId, counter: 1 });
line('rollDice #1', out.roll1);
out.roll2 = await call('rollDice', { gameId, counter: 1 });
line('rollDice #1 again', out.roll2);
if (out.roll1.body && out.roll2.body && out.roll1.body.roll1 !== undefined && out.roll2.body.roll1 !== undefined) {
  const a = out.roll1.body, c = out.roll2.body;
  console.log('     deterministic:', (a.roll1 === c.roll1 && a.roll2 === c.roll2) ? 'YES' : 'NO',
              '| rolls ' + a.roll1 + '+' + a.roll2 + ' vs ' + c.roll1 + '+' + c.roll2 + ' (same seed+counter)');
}

line('openGame', await call('openGame', { gameId, p2: P2, ttl: 1800 }));
line('chargeLife', await call('chargeLife', { player: PLAYER, matchRef }));
line('recordPoints', await call('recordPoints', { player: PLAYER, tag, points: 100, reason: 1, matchRef }));
line('recordGlobal', await call('recordGlobal', { player: PLAYER, kind: 1, points: 25, matchRef: matchRef + 1 }));
line('settleGame', await call('settleGame', { gameId, resultHash: keccak256(toHex('result-' + Date.now())) }));
line('revealDiceSeed', await call('revealDiceSeed', { batchId }));

out.read1 = await call('readPlayer', { player: PLAYER, tag });
const r1 = line('readPlayer (after)', out.read1);
if (r1.ok) console.log('     after:  lives', r1.lives.used + '/' + r1.lives.pool, '| bucket', r1.bucket.pure + '/' + r1.bucket.spendable, '| global', r1.globals.lifetime);

out.usage1 = await call('arcUsage', {});
const u = (out.usage1.body && out.usage1.body.usage) || { periods: [] };
const w = u.periods && u.periods[0];
if (w) console.log('     usage 24h: ' + w.txs + ' tx, ' + w.games + ' games, ' + w.usdc + ' USDC, ' + w.usdcPerGame + '/game');
const rollOk = !!(out.roll1.body && out.roll1.body.ok);
console.log('\nArc relayer path: ' + ((r1.ok && rollOk) ? 'ALL GOOD' : 'CHECK FAILURES ABOVE'));
