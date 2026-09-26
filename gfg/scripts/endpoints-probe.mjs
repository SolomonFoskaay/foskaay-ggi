// scripts/endpoints-probe.mjs
// Server-side health probe for the admin operations dashboard.
//
// Runs in TWO places (same code):
//   - the Vercel function      api/endpoints.mjs
//   - the local dev relay      scripts/relay-server.mjs (Vite proxies /api)
//
// Returns:
//   - watchlist : one row per monitored dependency (RPC chain, on-chain
//     accounts, ER RPC, Supabase) with status / latency / accessibility
//     (user-accessible, staff-only, infra).
//   - ops       : sponsor devnet balance, spend ledger totals + caps,
//     version + roadmap counts, git ref, and the ER/on-chain account
//     inventory (addresses resolved live).
//   - generatedAt / environment : when + where this probe ran.
//
// SECURITY (read the AGENTS.md rules before editing):
//   The response payload must NEVER describe an unfixed weakness. Leak-scan
//   verdicts and accepted gaps (e.g. the client-gated admin pages, the fact
//   that this endpoint answers anonymous callers today) are computed by
//   logLeakSinks() and written ONLY to the server-side log:
//     - console (Vercel function logs / the local relay terminal)
//     - a JSONL file when the server has a writable filesystem
//   Nothing about them ships to the browser.

import { readFileSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { PublicKey, Keypair } from '@solana/web3.js';
import './load-env.mjs';
import { routerUrl } from '../src/gfg-rpc.js';
import { createConnection, getDelegationStatus, erRpcEndpoints, pickErRpcUrl, erEndpointStates } from '../src/gfg-rpc.js';
import { spendCaps, loadLedger, spendTotals, spendAnalytics, gasForecast } from './spend-ledger.mjs';
import { fetchCompState, compPda } from './comp-relay.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- On-chain inventory (public, stable addresses on devnet) ----
const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const ER_REGIONS = erRpcEndpoints(); // AS / EU (US excluded 2026-08-18: "client temporarily banned")
const INVENTORY = {
  gfgDiceProgram: idl.address,
  delegationProgram: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
  erValidator: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57',
  erVrfQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  baseVrfQueue: 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh',
  erRpc: 'https://devnet-as.magicblock.app/', // canonical display (rotation governed by the registry; see ops.erRotation)
};

// ---- Sponsor key resolution (mirrors delegate-relay) ----
function loadSponsorPubkey() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair))).publicKey.toBase58();
  }
  const path = join(homedir(), '.config', 'solana', 'id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))).publicKey.toBase58();
}

// ---- git ref: Vercel injects VERCEL_GIT_COMMIT_SHA; local uses git; last
//      resort = latest changelog entry's committed ref. ----
function gitRef() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (sha) return sha;
  } catch (e) { /* not a git checkout on the server */ }
  try {
    const d = JSON.parse(readFileSync(join(root, 'public/changelog/changelog.json'), 'utf8'));
    if (d.entries && d.entries[0] && d.entries[0].git) return d.entries[0].git;
  } catch (e) { /* ignore */ }
  return 'unknown';
}

// ---- Changelog: version + roadmap counts ----
function changelogStats() {
  try {
    const d = JSON.parse(readFileSync(join(root, 'public/changelog/changelog.json'), 'utf8'));
    const roadmap = d.roadmap || [];
    return {
      version: d.current || '0.0.0',
      roadmapCounts: {
        planned: roadmap.filter(r => r.status === 'planned').length,
        inProgress: roadmap.filter(r => r.status === 'in-progress').length,
        shipped: (d.entries || []).length,
        pendingApprovals: roadmap.filter(r => r.approved !== true).length,
      },
    };
  } catch (e) {
    return { version: '0.0.0', roadmapCounts: null, error: e.message };
  }
}

// ---- HTTP probe with timeout ----
async function probeHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    // Any HTTP response means the server answered; a 4xx/5xx with a body is
    // still "reachable" from an operations standpoint (caught further up).
    return { ok: res.status >= 200 && res.status < 500, status: res.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Latest signatures for an account (devnet public RPC, best-effort) ----
// Used by the Wallets & accounts tracker: for each wallet/PDA we want the most
// recent transaction(s) so the owner can click through and verify on-chain.
async function latestSignatures(address, limit = 2, timeoutMs = 8000) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit, commitment: 'confirmed' }] }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.error || !Array.isArray(data.result)) {
      return { ok: false, error: (data.error && data.error.message) || 'bad response', latencyMs: Date.now() - start, signatures: [] };
    }
    return {
      ok: true,
      latencyMs: Date.now() - start,
      signatures: data.result.map(s => ({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      })),
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start, signatures: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Wallets & accounts tracker ----
// Every account kind the site touches (with its role + gasless notes) so the
// owner always knows WHAT each wallet/PDA is and can watch its latest txs:
//   - sponsor wallet      : the house/ sponsor key (pays init+delegate once)
//   - house dice PDA      : the sponsor's own dice PDA (serves computer rolls)
//   - each sponsored player wallet + its dice PDA (from the spend ledger)
// Delegation status per PDA comes from the Magic Router; latest txs from the
// devnet public RPC (best-effort).
async function buildAccountsTracker() {
  const out = [];
  let sponsorPubkey = null;
  try { sponsorPubkey = loadSponsorPubkey(); } catch (e) { /* sponsor missing */ }

  // Best-effort shared connection (public devnet may be flaky).
  let conn = null;
  try { conn = createConnection(routerUrl(), 'confirmed'); } catch (e) { /* continue */ }
  const getConn = () => { if (!conn) { conn = createConnection(routerUrl(), 'confirmed'); } return conn; };

  const add = async (entry) => {
    const base = {
      role: entry.role,
      kind: entry.kind,       // wallet | dice-pda | program
      address: entry.address,
      gasless: entry.gasless, // human note about who pays what
      balanceSol: null,
      delegated: null,
      latestTxs: [],
      txsError: null,
    };
    try {
      if (entry.kind === 'wallet') {
        const b = await getConn().getBalance(new PublicKey(entry.address));
        base.balanceSol = +(b / 1e9).toFixed(4);
      }
    } catch (e) { base.balanceError = e.message; }
    if (entry.kind === 'dice-pda' || entry.kind === 'points-pda' || entry.kind === 'result-pda') {
      try {
        const d = await getDelegationStatus(getConn(), entry.address);
        base.delegated = !!(d && d.isDelegated);
        base.delegationDetail = d && d.fqdn ? d.fqdn : (d && d.delegationRecord ? 'delegated (ER)' : null);
      } catch (e) { base.delegationError = e.message; }
    }
    const txs = await latestSignatures(entry.address);
    base.latestTxs = txs.signatures;
    if (!txs.ok) base.txsError = txs.error;
    out.push(base);
  };

  if (sponsorPubkey) {
    await add({ role: 'Sponsor / house wallet', kind: 'wallet', address: sponsorPubkey, gasless: 'App-owned key. Pays the one-time initialize+delegate (~0.0013 SOL) and every computer roll runs ER-gasless.' });
    const [housePda] = PublicKey.findProgramAddressSync([Buffer.from('gfgplayerd'), new PublicKey(sponsorPubkey).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'House dice PDA (computer rolls)', kind: 'dice-pda', address: housePda.toBase58(), gasless: 'Dice account for computer seats; rolls gasless on the ER VRF queue.' });
    const [housePointsPda] = PublicKey.findProgramAddressSync([Buffer.from('gfgpoints'), Buffer.from('ludo'), new PublicKey(sponsorPubkey).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'House points PDA (M3 ledger, game=ludo)', kind: 'points-pda', address: housePointsPda.toBase58(), gasless: 'Per-game points ledger for the house seat; record_points/spend_local run gasless on the ER.' });
    const [houseResultPda] = PublicKey.findProgramAddressSync([Buffer.from('gfgresult'), new PublicKey(sponsorPubkey).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'House result PDA (Scope C order)', kind: 'result-pda', address: houseResultPda.toBase58(), gasless: 'Finish-order ledger for the house seat; record_result runs gasless on the ER.' });
    const [compPda] = PublicKey.findProgramAddressSync([Buffer.from('gfgcomp'), new PublicKey(sponsorPubkey).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'Competition escrow (S2)', kind: 'result-pda', address: compPda.toBase58(), gasless: 'One active competition per sponsor; fund/close/settle/claim run gasless on the ER. 70/30 rake split enforced by the program.' });
  }

  let players = [];
  try { players = (loadLedger().players || {}); } catch (e) { /* ledger empty/missing */ }
  const playerKeys = Object.keys(players);
  for (const wallet of playerKeys.slice(0, 25)) {
    await add({ role: 'Player wallet (sponsored)', kind: 'wallet', address: wallet, gasless: 'Player holds 0 SOL; app sponsors their first delegate.' });
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('gfgplayerd'), new PublicKey(wallet).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'Player dice PDA', kind: 'dice-pda', address: pda.toBase58(), gasless: 'This player\'s dice account; rolls gasless on the ER VRF queue.' });
    const [pointsPda] = PublicKey.findProgramAddressSync([Buffer.from('gfgpoints'), Buffer.from('ludo'), new PublicKey(wallet).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'Player points PDA (M3 ledger, game=ludo)', kind: 'points-pda', address: pointsPda.toBase58(), gasless: 'This player\'s per-game on-chain points ledger; record_points/spend_local run gasless on the ER.' });
    const [resultPda] = PublicKey.findProgramAddressSync([Buffer.from('gfgresult'), new PublicKey(wallet).toBytes()], new PublicKey(INVENTORY.gfgDiceProgram));
    await add({ role: 'Player result PDA (Scope C order)', kind: 'result-pda', address: resultPda.toBase58(), gasless: 'This player\'s on-chain finish-order ledger; record_result runs gasless on the ER.' });
  }

  return {
    sponsorPubkey,
    accounts: out,
    pdaSeed: 'gfgplayerd',
  };
}

// ---- RPC probe: one JSON-RPC call through the configured connection ----
async function probeRpc(conn, method, params = []) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(conn.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message, latencyMs: Date.now() - start };
    return { ok: !!data.result, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ---- The probe ----
export async function runProbe() {
  const started = Date.now();
  const ROUTER = routerUrl();
  const conn = createConnection(ROUTER, 'confirmed');
  const watchlist = [];
  const seen = new Set();
  const note = (name, category, access, result) => {
    watchlist.push({
      name, category, access,
      ok: result.ok,
      latencyMs: result.latencyMs != null ? result.latencyMs : null,
      detail: result.ok ? (result.detail || (result.status ? `HTTP ${result.status}` : 'ok')) : (result.error || 'down'),
    });
  };
  const probe = async (name, category, access, fn) => {
    if (seen.has(name)) return;
    seen.add(name);
    try { note(name, category, access, await fn()); }
    catch (e) { note(name, category, access, { ok: false, error: e.message }); }
  };

  // 1. RPC chain (infra)
  await probe('Magic Router devnet RPC', 'rpc', 'infra', () => probeRpc(conn, 'getIdentity'));

  // 2. On-chain account inventory (infra) — each resolves an address creation
  const accountProbe = (label, address) => async () => {
    const start = Date.now();
    try {
      const info = await conn.getAccountInfo(new PublicKey(address));
      return { ok: !!info, latencyMs: Date.now() - start, detail: info ? `${info.lamports / 1e9} SOL rent` : 'account not found' };
    } catch (e) {
      // A delegated ER account answers getAccountInfo with
      // "account has been delegated to unknown ER node" — that IS the healthy
      // state for an account living on the rollup, not a failure.
      if (/delegated to unknown ER node/i.test(e.message || '')) {
        return { ok: true, latencyMs: Date.now() - start, detail: 'delegated to ER (expected)' };
      }
      throw e;
    }
  };
  await probe('gfg-dice program deployed', 'accounts', 'infra', accountProbe('gfg', INVENTORY.gfgDiceProgram));
  await probe('Delegation program deployed', 'accounts', 'infra', accountProbe('delegation', INVENTORY.delegationProgram));
  await probe('ER VRF queue (free)', 'accounts', 'infra', accountProbe('er-vrf', INVENTORY.erVrfQueue));
  await probe('Base VRF queue (paid)', 'accounts', 'infra', accountProbe('base-vrf', INVENTORY.baseVrfQueue));
  await probe('ER validator (AS - relay pins new accounts here)', 'accounts', 'infra', accountProbe('er-validator', INVENTORY.erValidator));

  // 3. ER RPC (infra) — probe EVERY public ER region with a real JSON-RPC call
  //    (an HTTP GET can answer 200 while the endpoint bans POST RPCs), plus
  //    report which region the client rotation currently targets.
  for (const ep of ER_REGIONS) {
    await probe(`ER RPC (${ep.region} region)`, 'rpc', 'infra', () =>
      probeRpc(createConnection(ep.url, 'confirmed', 15000), 'getLatestBlockhash', [{ commitment: 'confirmed' }]));
  }
  await probe('ER RPC preferred (rotation target)', 'rpc', 'infra', () =>
    probeRpc(createConnection(pickErRpcUrl(), 'confirmed', 15000), 'getLatestBlockhash', [{ commitment: 'confirmed' }]));

  // 4. Supabase (infra)
  await probe('Supabase (profiles store)', 'db', 'infra', () => probeHttp('https://ywrgxynjjgdicdzizpue.supabase.co'));

  // ---- Ops panel ----
  let sponsor = null;
  try {
    const pubkey = loadSponsorPubkey();
    const start = Date.now();
    const balance = await conn.getBalance(new PublicKey(pubkey));
    sponsor = { pubkey, balanceSol: +(balance / 1e9).toFixed(4), latencyMs: Date.now() - start };
  } catch (e) {
    sponsor = { pubkey: null, balanceSol: null, error: e.message };
  }

  let ledger = null;
  try {
    const caps = spendCaps();
    const totals = spendTotals();
    const all = loadLedger();
    const players = Object.entries(all.players || {})
      .map(([pubkey, v]) => ({ pubkey, spentSol: +((v.spent || 0) / 1e9).toFixed(5), lastSpentAt: v.lastSpentAt || null }))
      .sort((a, b) => b.spentSol - a.spentSol);

    // Gas analytics over the spend-event log: period buckets, categories
    // (what activity burns the reserve), top consumers, forecasts.
    const analytics = spendAnalytics();
    const bankSol = sponsor && sponsor.balanceSol != null ? sponsor.balanceSol : null;
    const tankSol = +(analytics.tank.tankLamports / 1e9).toFixed(2);
    const batteryPct = bankSol != null && tankSol > 0 ? Math.max(0, Math.min(100, Math.round(100 * bankSol / tankSol))) : null;
    const forecast1 = gasForecast(1 * 1e9);
    const forecast5 = gasForecast(5 * 1e9);
    const forecast25 = gasForecast(25 * 1e9);

    ledger = {
      playersCount: totals.players,
      globalSpentSol: totals.globalSpentSol,
      perPlayerCapSol: +(caps.perPlayerLamports / 1e9).toFixed(3),
      globalCapSol: +(caps.globalLamports / 1e9).toFixed(3),
      reserveSol: +(caps.reserveLamports / 1e9).toFixed(3),
      players,
      analytics: {
        periods: analytics.periods,
        categories: analytics.categories,
        topPlayers: analytics.topPlayers,
        avgOnboardingSol: analytics.avgOnboardingSol,
        playersPerSol: analytics.playersPerSol,
        burnPerDaySol: analytics.burnPerDaySol,
        battery: {
          balanceSol: bankSol != null ? +(bankSol).toFixed(3) : null,
          tankSol,
          pct: batteryPct,
          tier: bankSol == null ? 'unknown' : batteryPct >= 50 ? 'full' : batteryPct >= 25 ? 'low' : 'critical',
        },
        cap: {
          spentLamports: totals.globalSpentLamports,
          limitLamports: caps.globalLamports,
          spentSol: +(totals.globalSpentLamports / 1e9).toFixed(4),
          limitSol: +(caps.globalLamports / 1e9).toFixed(2),
          pct: caps.globalLamports > 0 ? Math.round(100 * totals.globalSpentLamports / caps.globalLamports) : 0,
          tier: caps.globalLamports > 0 && totals.globalSpentLamports / caps.globalLamports >= 0.8 ? 'critical' : caps.globalLamports > 0 && totals.globalSpentLamports / caps.globalLamports >= 0.5 ? 'low' : 'full',
        },
        forecasts: {
          '1 SOL': { playersFunded: forecast1.playersFunded, runwayMonths: forecast1.runwayMonths },
          '5 SOL': { playersFunded: forecast5.playersFunded, runwayMonths: forecast5.runwayMonths },
          '25 SOL': { playersFunded: forecast25.playersFunded, runwayMonths: forecast25.runwayMonths },
        },
      },
    };
  } catch (e) {
    ledger = { error: e.message };
  }

  const changelog = changelogStats();

  // ---- Wallets & accounts tracker (admin: what each wallet is + latest txs) ----
  let accountsTracker = null;
  try {
    accountsTracker = await buildAccountsTracker();
  } catch (e) {
    accountsTracker = { error: e.message };
  }

  // ---- Competition escrow (S2): live on-chain state for the ops panel ----
  let compState = null;
  try {
    if (sponsor && sponsor.pubkey && compPda) {
      const pda = compPda(sponsor.pubkey);
      const s = await fetchCompState(pda.toBase58());
      compState = { compPda: pda.toBase58(), state: s };
    }
  } catch (e) {
    compState = { error: e.message };
  }

  // ---- Leak scan: findings go to the server log ONLY (never the payload) ----
  logLeakSinks(sponsor, ledger, changelog);

  return {
    generatedAt: new Date().toISOString(),
    environment: process.env.VERCEL ? 'vercel' : 'local',
    watchlist,
    ops: {
      sponsor,
      ledger,
      version: changelog.version,
      roadmapCounts: changelog.roadmapCounts,
      gitRef: gitRef(),
      inventory: INVENTORY,
      erRotation: {
        preferred: pickErRpcUrl(),
        endpoints: erEndpointStates(),
      },
      accounts: accountsTracker,
      compState,
    },
    probeMs: Date.now() - started,
  };
}

// Server-side-only sink for accepted-gap / leak observations. Nothing written
// here may appear in the api/endpoints response payload.
function logLeakSinks(sponsor, ledger, changelog) {
  const lines = [];
  const line = (kind, msg) => lines.push(`${kind}\t${new Date().toISOString()}\t${msg}`);
  line('gap', 'api/endpoints answers anonymous callers (no server-side auth yet; client-side wallet gate only)');
  line('gap', 'admin pages (/dashboard, /changelog/admin.html) are client-gated only — readable via devtools');
  if (sponsor && sponsor.balanceSol != null) {
    line('ops', `sponsor balance ${sponsor.balanceSol} SOL`);
    if (sponsor.balanceSol < 0.5) line('warn', 'sponsor balance LOW (below 0.5 SOL)');
  }
  if (ledger && !ledger.error) {
    line('ops', `ledger: ${ledger.playersCount} player(s), ${ledger.globalSpentSol} SOL spent, caps ${ledger.perPlayerCapSol}/${ledger.globalCapSol}/${ledger.reserveSol}`);
  }
  if (changelog.roadmapCounts && changelog.roadmapCounts.pendingApprovals > 0) {
    line('ops', `${changelog.roadmapCounts.pendingApprovals} roadmap item(s) pending owner approval`);
  }
  try {
    const logFile = join(root, '.gfg-probe-log.jsonl');
    appendFileSync(logFile, lines.map(l => JSON.stringify({ t: new Date().toISOString(), msg: l })).join('\n') + '\n');
  } catch (e) { /* Vercel has no writable fs — skip file sink */ }
  for (const l of lines) console.log(`[probe] ${l}`);
}

// Allow running the probe directly for debugging: `node scripts/endpoints-probe.mjs`
if (process.argv[1] && process.argv[1].endsWith('endpoints-probe.mjs')) {
  runProbe().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => { console.error(e); process.exit(1); });
}