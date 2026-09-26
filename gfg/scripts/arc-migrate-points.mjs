// scripts/arc-migrate-points.mjs — move every player's Solana balances to Arc.
//
// Batch version of the lazy login migration: lists Dynamic users, reads each
// player's Solana Player Core, maps to their EVM address, and credits their Arc
// Player Core with migratePlayer. Idempotent by a reference derived from the
// Solana wallet, so a re-run is a clean no-op.
//
// Usage:
//   node scripts/arc-migrate-points.mjs --dry     # plan only
//   node scripts/arc-migrate-points.mjs --run     # execute
import './load-env.mjs';
import { createHash } from 'crypto';
import arcRelay from '../api_handlers/arc-relay.mjs';
import { readSolanaCore, coreBalances, hasBalances } from './solana-core-read.mjs';

const DRY = !process.argv.includes('--run');
const TAG = 'ludo';
const DYNAMIC_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
const DYNAMIC_ENV = process.env.DYNAMIC_ENV_ID || process.env.DYNAMIC_ENVIRONMENT_ID || '';
const OP_TOKEN = process.env.GFG_OPERATOR_TOKEN || '';

export function migrationRefFor(solWallet) {
  return parseInt(createHash('sha256').update('arc-migrate:' + solWallet).digest('hex').slice(0, 15), 16);
}

async function dynamicUsers() {
  if (!DYNAMIC_TOKEN || !DYNAMIC_ENV) return [];
  const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV}/users?limit=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${DYNAMIC_TOKEN}` } });
  if (!r.ok) throw new Error('Dynamic API ' + r.status);
  const j = await r.json();
  return (j.users || []).map((u) => {
    let sol = null, evm = null;
    const creds = u.verifiedCredentials || [];
    const sc = creds.find(c => c.chain === 'SOL'); if (sc) sol = sc.address;
    const ec = creds.find(c => c.chain === 'EVM'); if (ec) evm = ec.address;
    if (u.wallets) {
      const sw = u.wallets.find(w => w.chain === 'SOL'); if (!sol && sw) sol = sw.publicKey || sw.address;
      const ew = u.wallets.find(w => w.chain === 'EVM'); if (!evm && ew) evm = ew.publicKey || ew.address;
    }
    return { id: u.id, email: u.email || '', sol, evm };
  }).filter(u => u.sol || u.evm);
}

function call(action, params, token) {
  return new Promise((resolve) => {
    const req = { method: 'POST', body: JSON.stringify({ action, params, token }), headers: {} };
    let done = false;
    const res = { _c: 200, setHeader() { return this; }, status(c) { this._c = c; return this; }, json(o) { if (!done) { done = true; resolve({ status: this._c, body: o }); } }, end() { if (!done) { done = true; resolve({ status: this._c, body: null }); } } };
    arcRelay(req, res).catch(e => resolve({ status: 500, body: { error: e.message } }));
  });
}

const users = await dynamicUsers();
console.log((DRY ? 'DRY RUN' : 'MIGRATE') + ' | dynamic users with a wallet:', users.length);
let planned = 0, migrated = 0, skipped = 0, totalPure = 0;
for (const u of users) {
  if (!u.sol || !u.evm) { skipped++; continue; }
  const core = await readSolanaCore(u.sol).catch(() => null);
  const b = coreBalances(core, TAG);
  if (!hasBalances(b)) { skipped++; continue; }
  planned++;
  totalPure += b.localPure;
  console.log(`  ${u.sol.slice(0, 8)}… -> ${u.evm.slice(0, 10)}… | ludo ${b.localPure}/${b.localSpendable} global ${b.globalPure}/${b.globalLifetime}/${b.globalSpendable} premium ${b.premiumLifetime}/${b.premiumSpendable} lvl ${b.level}`);
  if (DRY) continue;
  const r = await call('migratePlayer', { player: u.evm, data: { ...b, migrationRef: migrationRefFor(u.sol) } }, OP_TOKEN);
  if (r.status === 200 && r.body && r.body.ok) { migrated++; console.log('     migrated ' + (r.body.txHash || 'ok')); }
  else console.log('     FAILED ' + ((r.body && r.body.error) || r.status));
}
console.log(`\nplanned ${planned} | migrated ${migrated} | skipped ${skipped} | total ludo pure ${totalPure}`);
