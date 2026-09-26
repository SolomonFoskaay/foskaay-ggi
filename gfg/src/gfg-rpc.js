// src/gfg-rpc.js
// Devnet Solana base-layer RPC resolution + MagicBlock Router helpers.
//
// ARCHITECTURE (MagicBlock-first): the single Magic Router endpoint
// (devnet-router.magicblock.app) is the PRIMARY connection for every base-layer
// RPC call AND transaction. The Router inspects each tx's writable accounts:
// delegated PDAs are auto-routed to the Ephemeral Rollup (gasless, ~10 ms
// blocks), everything else goes to Solana devnet. We only fall back to a
// third-party provider key / public RPCs when the Router is unreachable.
//
// Consumers:
//   - the gfg-dice client (src/magicblock-er-vrf.js, src/gfg-dice-config.js)
//   - the sponsor relay (scripts/delegate-relay.mjs)
//   - the lab harnesses (scripts/lab/*, er-test.mjs)
//
// Exports:
//   - routerUrl()          -> the Magic Router devnet endpoint
//   - baseRpcEndpoints()   -> priority-ordered failover chain (Router first)
//   - baseRpcUrl()         -> first usable endpoint (primary)
//   - createConnection(url)-> Connection whose confirmTransaction polls
//                             getSignatureStatuses (MagicBlock's own confirm
//                             strategy; also the only way to confirm on RPCs
//                             that lack the signatureSubscribe WS method).
//   - closestValidatorCn() -> Router getIdentity helper for delegating a PDA
//                             to the nearest ER validator.
//   - sendMagicTx()        -> getBlockhashForAccounts-aware send for txs that
//                             touch delegated accounts (standard getLatestBlockhash
//                             is WRONG there: blockhash progression differs per layer).
//
// See: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router

import { Connection, PublicKey } from '@solana/web3.js';

// Magic Router (the recommended single endpoint for devnet dApps).
export const ROUTER_DEVNET = 'https://devnet-router.magicblock.app';

export function routerUrl() {
  return ROUTER_DEVNET;
}

// Failover chain: Magic Router first; provider-key override (relay/server) or
// build-time VITE key (browser) next; keyless public endpoints last-resort.
const PUBLIC_ENDPOINTS = [
  'https://solana-devnet.api.onfinality.io/public',
  'https://api.devnet.solana.com',
];

function envEndpoints() {
  const out = [];
  try {
    if (typeof process !== 'undefined' && process.env?.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
  } catch (e) { /* not a node env */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEVNET_RPC) out.push(import.meta.env.VITE_DEVNET_RPC);
  } catch (e) { /* no build-time env */ }
  return out;
}

export function baseRpcEndpoints() {
  return [ROUTER_DEVNET, ...envEndpoints(), ...PUBLIC_ENDPOINTS];
}

export function baseRpcUrl() {
  return baseRpcEndpoints()[0];
}

// ---- Ephemeral Rollup (ER) RPC registry + failover rotation ----
//
// The ER RPC is the gasless execution layer every dice roll and on-chain points
// write runs on. A single hardcoded endpoint makes one regional outage or
// rate-limit a platform-wide outage. HARDENING (2026-08-18): this registry lists
// every public MagicBlock devnet ER endpoint and rotates with exponential
// backoff (TEE is excluded because it requires an auth token):
//   - pickErRpcUrl()     -> best current endpoint (prefers the last-known-good,
//                           else any endpoint not in cooldown, else the one that
//                           recovers first).
//   - markErRpcSuccess/  -> call around each network op so a failing endpoint
//     markErRpcFailure      goes to cooldown (5s -> 10s -> 20s -> 40s -> 60s).
// Consumers must call pickErRpcUrl() per operation, never cache the URL.
// US is EXCLUDED (2026-08-18): devnet-us.magicblock.app answers "-32005 client
// temporarily banned", so only AS + EU are rotated.
export const ER_ENDPOINTS = [
  { url: 'https://devnet-as.magicblock.app/', region: 'AS' },
  { url: 'https://devnet-eu.magicblock.app/', region: 'EU' },
];

const ER_STATE = new Map(ER_ENDPOINTS.map(e => [e.url, { failures: 0, cooldownUntil: 0 }]));
let erPreferredUrl = null; // last endpoint that answered; preferred while healthy
let erStartIdx = 0;        // rotates the tie-break start so fresh sessions don't all land on one region

function erCooldownMs(attempt) {
  return Math.min(5000 * 2 ** Math.min(attempt, 4), 60000); // 5s..60s cap
}

export function erEndpointStates() {
  return ER_ENDPOINTS.map(e => ({ url: e.url, region: e.region, ...ER_STATE.get(e.url) }));
}

export function markErRpcSuccess(url) {
  const st = ER_STATE.get(url);
  if (!st) return;
  st.failures = 0;
  st.cooldownUntil = 0;
  erPreferredUrl = url;
}

export function markErRpcFailure(url) {
  const st = ER_STATE.get(url);
  if (!st) return;
  st.failures += 1;
  st.cooldownUntil = Date.now() + erCooldownMs(st.failures);
  if (erPreferredUrl === url) erPreferredUrl = null;
}

export function erRpcEndpoints() {
  return ER_ENDPOINTS.slice();
}

// Region URL a delegated account actually lives on. The Router's
// getDelegationStatus returns an `fqdn` naming the ER region hosting the
// account; every ER write AND its callback poll MUST target that same region
// (a roll submitted to a region that does not host the account can never get
// its callback back - proven by the E1 vs F2 probes). This map also covers
// explicitly targeting an account pinned to US even though US is excluded
// from fresh-connection rotation.
export const ER_REGION_URLS = {
  us: 'https://devnet-us.magicblock.app/',
  as: 'https://devnet-as.magicblock.app/',
  eu: 'https://devnet-eu.magicblock.app/',
};

export function regionUrlForFqdn(fqdn) {
  if (!fqdn) return null;
  const lower = String(fqdn).toLowerCase();
  if (lower.includes('devnet-us') || /(^|[.\-_])us([.\-_]|$)/.test(lower)) return ER_REGION_URLS.us;
  if (lower.includes('devnet-as') || /(^|[.\-_])as([.\-_]|$)/.test(lower)) return ER_REGION_URLS.as;
  if (lower.includes('devnet-eu') || /(^|[.\-_])eu([.\-_]|$)/.test(lower)) return ER_REGION_URLS.eu;
  return null;
}

export function pickErRpcUrl() {
  const now = Date.now();
  if (erPreferredUrl && ER_STATE.get(erPreferredUrl).cooldownUntil <= now) return erPreferredUrl;
  let healthiest = null;
  let healthiestFailures = Infinity;
  let firstToRecover = null;
  let firstRecoverAt = Infinity;
  const n = ER_ENDPOINTS.length;
  const start = erStartIdx % n;
  for (let k = 0; k < n; k++) {
    const e = ER_ENDPOINTS[(start + k) % n];
    const st = ER_STATE.get(e.url);
    if (st.cooldownUntil <= now && st.failures < healthiestFailures) {
      healthiest = e.url;
      healthiestFailures = st.failures;
    }
    if (st.cooldownUntil < firstRecoverAt) {
      firstToRecover = e.url;
      firstRecoverAt = st.cooldownUntil;
    }
  }
  erStartIdx = (erStartIdx + 1) % n; // spread fresh-session first picks across regions
  return healthiest || firstToRecover || ER_ENDPOINTS[start].url;
}

// Mark `failedUrl` down, then hand back the best next endpoint to retry on.
export function rotateErRpc(failedUrl) {
  markErRpcFailure(failedUrl);
  return pickErRpcUrl();
}

// A confirmed/backoff-enabled Connection to the current best ER endpoint.
// ER confirmations poll with an ascending backoff so a hanging tx never
// hammers the RPC; 30s cap matches the legacy confirm timeout.
const ER_CONFIRM_BACKOFF = [400, 800, 1200, 1800, 2500];
export function createErConnection(timeoutMs = 30000) {
  return createConnection(pickErRpcUrl(), 'confirmed', timeoutMs, { backoffMs: ER_CONFIRM_BACKOFF });
}

// Create a Solana Connection whose confirmTransaction polls getSignatureStatuses
// instead of subscribing via websocket. This mirrors MagicBlock's own
// confirmMagicTransaction (polling is their documented strategy) and, unlike
// signatureSubscribe, works on EVERY RPC in the failover chain (Alchemy's
// devnet endpoint does not implement the WS method, so web3's default confirm
// would hang even when the tx landed).
export function createConnection(url, commitment = 'confirmed', timeoutMs = 30000, opts = {}) {
  const conn = new Connection(url, commitment);
  // Poll interval for confirmTransaction. Default [500] = one poll every 500ms
  // (unchanged legacy behavior). Pass an ascending array (e.g. ER backoff) so a
  // slow-to-confirm tx stops hammering the RPC as it waits.
  const delays = Array.isArray(opts.backoffMs) && opts.backoffMs.length ? opts.backoffMs : [500];
  conn.confirmTransaction = async (strategy, commit) => {
    const signature = typeof strategy === 'string' ? strategy : strategy.signature;
    const comm = commit || conn.commitment || 'confirmed';
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; Date.now() < deadline; i++) {
      const { value } = await conn.getSignatureStatuses([signature]);
      const status = value && value[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === comm || status.confirmationStatus === 'finalized') {
          return { value: status };
        }
      }
      await new Promise(r => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    }
    throw new Error(`Transaction was not confirmed in ${timeoutMs / 1000}s (${signature})`);
  };
  return conn;
}

// Ask the Magic Router which ER validator is closest to us. The Router inspects
// where our requests land and returns the nearest validator identity + its
// per-region ER base URL. Use the returned validator when delegating a PDA so
// rolls execute on the fastest available Ephemeral Rollup.
export async function closestValidator(connection) {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getIdentity', params: [] }),
  });
  const data = await res.json();
  if (!data.result || !data.result.identity) throw new Error('getIdentity: invalid response from router');
  return { pubkey: new PublicKey(data.result.identity), fqdn: data.result.fqdn || null };
}

// Ask the Magic Router whether an account is currently delegated to an ER, and
// if so WHERE it lives. This is the authoritative delegation check — it must be
// used instead of `getAccountInfo().owner === DELeGG`, because the Router (and
// any ER region endpoint) returns the account as owned by its ORIGINAL program
// (the ER hosts the account's state, so the delegation program is not its
// owner). `getAccountInfo` on the base layer shows the delegation-program owner,
// but after switching to the Router as the primary RPC that view is gone.
// Endpoint is the router's /getDelegationStatus method (their SDK calls it).
export async function getDelegationStatus(connection, account) {
  const accountAddress = typeof account === 'string' ? account : account.toBase58();
  const res = await fetch(`${connection.rpcEndpoint}/getDelegationStatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getDelegationStatus',
      params: [accountAddress],
    }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`getDelegationStatus failed: ${JSON.stringify(data.error || data)}`);
  return data.result; // { isDelegated, fqdn, delegationRecord? }
}

// Correct per-layer blockhash for a transaction: the Router looks at the tx's
// writable accounts and returns the blockhash of whichever layer they live on
// (ER or base). Standard getLatestBlockhash is NOT valid for txs that write
// delegated accounts — blockhash progression differs between the layers.
// `accounts` = the writable account pubkeys of the transaction.
export async function getBlockhashForAccounts(connection, accounts) {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlockhashForAccounts',
      params: [accounts.map(a => (typeof a === 'string' ? a : a.toBase58()))],
    }),
  });
  const data = await res.json();
  const inner = data && data.result ? (data.result.value && data.result.value.blockhash ? data.result.value : data.result) : null;
  if (!inner || !inner.blockhash) throw new Error(`getBlockhashForAccounts failed: ${JSON.stringify(data.error || data)}`);
  return inner; // { blockhash, lastValidBlockHeight }
}

// Collect the writable accounts of a legacy Transaction (fee payer + all
// instruction keys flagged writable). Mirrors MagicBlock's getWritableAccounts.
export function getWritableAccounts(transaction) {
  const writable = new Set();
  if (transaction.feePayer) writable.add(transaction.feePayer.toBase58());
  for (const instruction of transaction.instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) writable.add(key.pubkey.toBase58());
    }
  }
  return Array.from(writable);
}

// MagicBlock-native send for base-layer txs through the Magic Router.
// Standard getLatestBlockhash returns the ROUTER's blockhash (its own layer),
// which base Solana rejects. getBlockhashForAccounts returns the correct
// base-layer blockhash for as-yet-undelivered accounts, so we fetch it, set it
// on the tx, sign, then send raw. Returns the signature.
//
// signers: array of web3 Signer (e.g. [sponsorKeypair] for the relay).
export async function sendMagicTx(connection, transaction, signers = [], sendOptions) {
  const blockhash = await getBlockhashForAccounts(connection, getWritableAccounts(transaction));
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  transaction.partialSign(...signers);
  const wire = transaction.serialize();
  return connection.sendRawTransaction(wire, sendOptions);
}