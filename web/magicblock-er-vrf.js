// src/magicblock-er-vrf.js
// Provably-fair, GASLESS dice for the Ludo game via MagicBlock VRF + Ephemeral
// Rollup (Solana devnet).
//
// Why gasless: players are Web2-native and never hold SOL. On their first roll
// the app-sponsored relay (POST config.relayUrl) creates + delegates the
// player's dice PDA to a MagicBlock Ephemeral Rollup (the only base-layer txs,
// paid by us). Every roll then runs on the ER:
//   - the transaction is FREE (ER is gasless for end users),
//   - the VRF request on the ER queue is FREE,
//   - the player's Dynamic session key signs silently (no popup).
//
// Flow (roll()):
//   1. ensure the player's dice PDA exists and is delegated (via the relay),
//   2. send rollDice(clientSeed) on the ER, signed by the session key,
//   3. wait for the VRF program to callback into callback_roll_dice,
//   4. read [last_roll1, last_roll2] from the PDA and return them.
//
// The module ONLY activates once configure() has been called. Until then
// available() returns false and the game keeps using local randomness.

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { getWalletAccounts } from '@dynamic-labs-sdk/client';
import { signTransaction, signAllTransactions } from '@dynamic-labs-sdk/solana';
import {
  getDelegationStatus,
  createConnection,
  pickErRpcUrl,
  markErRpcSuccess,
  markErRpcFailure,
  rotateErRpc,
  regionUrlForFqdn,
  erRpcEndpoints,
  ER_REGION_URLS,
} from './gfg-rpc.js';
import bs58 from 'bs58';
import { BN } from 'bn.js';

const DELEGATION_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const PLAYER_SEED = Buffer.from('gfgplayerd');
const POINTS_SEED = Buffer.from('gfgpoints');
const RESULT_SEED = Buffer.from('gfgresult');
const GLOBAL_TAG = Buffer.from('global');
const PREMIUM_SEED = Buffer.from('gfgprem');
const PREMIUM_PLAN_COST = 5000; // premium spendable required to activate Level 2

// Reasons recorded against a points award (mirrors the program's u8 codes).
export const POINT_REASONS = Object.freeze({
  WIN_1ST: 1,     // first place in a match
  WIN_2ND: 2,     // second place in a match
  WIN_3RD: 3,     // third place in a match
});

// Reasons recorded against a local SPEND (mirrors the program's u8 codes).
export const SPEND_REASONS = Object.freeze({
  SHOP_ITEM: 1,   // in-game purchase from the S3 shop (cosmetics etc.)
});

// M4 record_global_points kind codes (mirrors the program's u8 codes).
export const GLOBAL_KIND = Object.freeze({
  GAME_WIN: 0,     // game win: credits M4a pure + M4b lifetime + M4c spendable
  OTHER: 1,        // other (signup/referral/giveaway/tier_boost): M4b + M4c only
});

// Reasons recorded against a global SPEND (mirrors the program's u8 codes).
export const GLOBAL_SPEND_REASONS = Object.freeze({
  SHOP_ITEM: 1,
  TIER_BUY: 2,
  COMP_ENTRY: 3,
});

const config = {
  baseRpcUrl: 'https://api.devnet.solana.com',
  // Vestigial: the actual ER endpoint is chosen per operation by the rotation
  // registry in src/gfg-rpc.js (pickErRpcUrl, US/AS/EU failover). Kept as a
  // non-banned default (AS) so nothing ever falls back to the region that has
  // been returning "-32005 client temporarily banned".
  erRpcUrl: 'https://devnet-as.magicblock.app/',
  erValidator: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57',
  // Devnet ER VRF queue (free VRF). Base-layer queue: Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh
  oracleQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  relayUrl: '/api/delegate',
  programId: null,   // set by configure()
  idl: null,         // set by configure()
  requestTimeoutMs: 20000,
  erPickupWaitMs: 10000,
};

function getSolanaWalletAccount() {
  try {
    const client = window.dynamicClient;
    if (!client) return null;
    const accounts = getWalletAccounts(client);
    const sol = accounts.find(w => w.chain === 'SOL' && w.address);
    return sol ? { walletAccount: sol, publicKey: new PublicKey(sol.address) } : null;
  } catch (e) {
    console.warn('[ER VRF] Could not read Solana wallet account', e);
    return null;
  }
}

// ---- ER RPC rotation (registry lives in src/gfg-rpc.js) ----
// Connections are cached per endpoint so a session reuses the good one; when an
// endpoint fails we drop its connection and rotate to a fresh region.
const erConns = new Map();
let erCurrentUrl = null;

function currentErUrl() {
  erCurrentUrl = pickErRpcUrl();
  return erCurrentUrl;
}

function erConnFor(url) {
  let conn = erConns.get(url);
  if (!conn) {
    conn = createConnection(url, 'confirmed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] });
    erConns.set(url, conn);
  }
  return conn;
}

// True when an error means the ER endpoint itself is unhealthy (network/HTTP
// transport, rate-limit, gateway) — i.e. we should rotate regions. Program
// revert errors and "account not settled yet" conditions are NOT RPC failures.
function isErNetworkError(e) {
  if (!e || !e.message) return false;
  const m = String(e.message);
  if (/fetch failed|Failed to fetch|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKET|UND_ERR|socket hang up|network error|aborted|timed out|timeout|banned/i.test(m)) return true;
  if (/\b429\b|\b50[0-9]\b|\brate limit|too many requests|service unavailable|bad gateway|internal server error/i.test(m)) return true;
  return false;
}

// ---- Region-aware ER targeting (THE fix for "Timeout waiting for callback") ----
//
// A delegated PDA's ER state lives on ONE region (the validator the relay
// pinned it to via remainingAccounts). Submitting a roll or points write to a
// DIFFERENT region can confirm okay but the VRF callback lands on the hosting
// region, so a poll elsewhere never sees it. Every operation that touches a
// delegated account must therefore resolve WHICH region hosts it (Router
// getDelegationStatus -> fqdn) and submit + poll THERE. Rotation is only a
// fallback for accounts the Router has not reported on yet.
const regionUrlCache = new Map(); // pda base58 -> region URL
let regionBaseConn = null;

async function resolvedRegionUrl(pda) {
  const key = typeof pda === 'string' ? pda : pda.toBase58();
  if (regionUrlCache.has(key)) return regionUrlCache.get(key);
  try {
    if (!regionBaseConn) regionBaseConn = new Connection(config.baseRpcUrl, 'confirmed');
    const st = await getDelegationStatus(regionBaseConn, pda);
    if (st && st.isDelegated) {
      const url = regionUrlForFqdn(st.fqdn);
      if (!url) {
        // Delegated but fqdn not mapped yet: do not cache, so a later poll can
        // re-resolve as the region metadata propagates.
        console.warn(`[ER VRF] ${key.slice(0, 8)}... delegated with unmapped fqdn '${st.fqdn}' - will re-resolve`);
        return null;
      }
      regionUrlCache.set(key, url);
      console.log(`[ER VRF] ${key.slice(0, 8)}... pinned to region ${url}`);
      return url;
    }
  } catch (e) {
    // Router unreachable: caller falls back to rotation for this attempt.
  }
  return null;
}

// Best ER endpoint for `pda`: its hosting region when known, else the current
// rotation pick (fresh/unknown accounts).
async function regionUrlFor(pda) {
  const host = await resolvedRegionUrl(pda);
  return host || currentErUrl();
}

// Ordered list of ER region URLs to TRY for a read of `pda`: the account's
// resolved hosting region first (when the Router reports it), then the rotation
// registry regions (AS/EU), then legacy US (pre-flip accounts may still live
// there). A delegated account's state lives on exactly ONE region, so a read
// must try the host first; when the Router misses (fqdn not mapped / Router
// down) the other regions are tried so a single-region hiccup can NEVER fake a
// "no ledger" zero. Reads swallow "account not found" and move on; the first
// region that answers with real bytes wins.
async function regionCandidatesFor(pda) {
  const list = [];
  const seen = new Set();
  const push = (url) => { if (url && !seen.has(url)) { seen.add(url); list.push(url); } };
  const host = await resolvedRegionUrl(pda);
  push(host);
  erRpcEndpoints().forEach(e => push(e.url));
  push(ER_REGION_URLS.us);
  return list;
}

// Run `fn(ctx)` against the current best ER endpoint; on a network error,
// rotate regions and retry once with a fresh provider. Program-level errors
// bubble up immediately (they are not RPC outages). An optional label logs
// WHICH operation is running and on WHICH region, so the console traces the
// full path: wallet-sign (Dynamic email moment) -> send -> confirm.
//
// When `opts.regionUrl` is set (a delegated account is hosted on exactly that
// region), the write targets ONLY that region and a network error RETRIES THE
// SAME region: the account's state lives there, so rotating elsewhere can
// neither confirm the tx nor ever return the VRF callback.
async function withErRetry(labelOrFn, maybeFn, opts = {}) {
  const label = typeof labelOrFn === 'string' ? labelOrFn : (labelOrFn && labelOrFn.name) || 'op';
  const fn = typeof labelOrFn === 'function' ? labelOrFn : maybeFn;
  const pinnedUrl = opts.regionUrl || null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = pinnedUrl || currentErUrl();
    const ctx = getErProgramFor(url);
    if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');
    console.log(`[ER VRF] ER write '${label}' attempt ${attempt + 1}/2 -> submitting on region ${url}`);
    try {
      const out = await fn(ctx);
      markErRpcSuccess(url);
      console.log(`[ER VRF] ER write '${label}' CONFIRMED on region ${url}:`, (typeof out === 'string') ? out : out);
      return out;
    } catch (e) {
      lastErr = e;
      if (!isErNetworkError(e)) {
        console.error(`[ER VRF] ER write '${label}' failed (NOT an RPC outage - surfaced to the caller):`, e.message);
        throw e;
      }
      if (pinnedUrl) {
        // Account lives on this region: same-region retry only.
        console.warn(`[ER VRF] ER write '${label}' network error on pinned region ${url} (${e.message}) - retrying SAME region.`);
        erConns.delete(url);
        continue;
      }
      console.warn(`[ER VRF] ER write '${label}' network error on region ${url} (${e.message}) - rotating regions.`);
      const next = rotateErRpc(url);
      erConns.delete(url); // drop the dead endpoint's cached connection
      if (attempt === 0 && next !== url) continue;
      throw e;
    }
  }
  throw lastErr;
}

// Provider pointed at the Ephemeral Rollup. Transactions here are gasless, so
// the player's wallet (session key) can be the fee payer with zero SOL.
function getErProgramFor(url) {
  if (!config.programId || !config.idl) return null;
  const wallet = getSolanaWalletAccount();
  if (!wallet) return null;

  const connection = erConnFor(url);
  const walletAdapter = {
    publicKey: wallet.publicKey,
    async signTransaction(transaction) {
      console.log(`[ER VRF] Wallet signature REQUESTED (Dynamic 'tx signed' email fires here) for ${wallet.publicKey.toBase58()}`);
      const { signedTransaction } = await signTransaction({
        transaction,
        walletAccount: wallet.walletAccount,
      });
      console.log(`[ER VRF] Wallet signature OK - signed ${signedTransaction.signatures ? signedTransaction.signatures.length : 0} sig(s). Sending to the ER RPC next.`);
      return signedTransaction;
    },
    async signAllTransactions(transactions) {
      const { signedTransactions } = await signAllTransactions({
        transactions,
        walletAccount: wallet.walletAccount,
      });
      return signedTransactions;
    },
  };

  const provider = new AnchorProvider(connection, walletAdapter, {
    commitment: 'confirmed',
    skipPreflight: true,
  });

  return {
    program: new Program(config.idl, provider),
    wallet,
  };
}

// Rotation-picked provider (used when no specific account region applies).
function getErProgram() {
  return getErProgramFor(currentErUrl());
}

// READ-ONLY provider for a given region: like getErProgramFor but takes a
// wallet PUBLIC KEY directly instead of requiring the Dynamic signing session.
// Account.fetch() never signs, so this is enough to read a ledger by address —
// the same path the recovery page uses. signTransaction/signAllTransactions
// are stubs that throw (never called for a plain read).
function getReadErProgramFor(url, publicKey) {
  if (!config.programId || !config.idl) return null;
  const connection = erConnFor(url);
  const readWallet = {
    publicKey,
    async signTransaction() {
      throw new Error('[ER VRF] read-only provider cannot sign transactions');
    },
    async signAllTransactions() {
      throw new Error('[ER VRF] read-only provider cannot sign transactions');
    },
  };
  const provider = new AnchorProvider(connection, readWallet, {
    commitment: 'confirmed',
    skipPreflight: true,
  });
  return { program: new Program(config.idl, provider), wallet: { publicKey } };
}

function decodePlayerPoints(acct) {
  return {
    pureLifetime: Number(acct.localPureLifetime ?? acct.local_pure_lifetime ?? 0),
    spendableBalance: Number(acct.localSpendableBalance ?? acct.local_spendable_balance ?? 0),
    lastPoints: Number(acct.lastPoints ?? acct.last_points ?? 0),
    lastReason: Number(acct.lastReason ?? acct.last_reason ?? 0),
    lastMatchRef: (acct.lastMatchRef ?? acct.last_match_ref)?.toString() ?? '0',
    lastRecordedTs: Number(acct.lastRecordedTs ?? acct.last_recorded_ts ?? 0) * 1000,
    awardCount: Number(acct.awardCount ?? acct.award_count ?? 0),
    lastSpendTs: Number(acct.lastSpendTs ?? acct.last_spend_ts ?? 0) * 1000,
    lastSpendRef: (acct.lastSpendRef ?? acct.last_spend_ref)?.toString() ?? '0',
    lastSpendReason: Number(acct.lastSpendReason ?? acct.last_spend_reason ?? 0),
    spendCount: Number(acct.spendCount ?? acct.spend_count ?? 0),
  };
}

function decodeGlobalPoints(acct) {
  return {
    pureLifetime: Number(acct.globalPureLifetime ?? acct.global_pure_lifetime ?? 0),
    lifetime: Number(acct.globalLifetime ?? acct.global_lifetime ?? 0),
    spendableBalance: Number(acct.globalSpendableBalance ?? acct.global_spendable_balance ?? 0),
    lastSource: Number(acct.lastSource ?? acct.last_source ?? 0),
    lastPoints: Number(acct.lastPoints ?? acct.last_points ?? 0),
    lastReason: Number(acct.lastReason ?? acct.last_reason ?? 0),
    lastMatchRef: (acct.lastMatchRef ?? acct.last_match_ref)?.toString() ?? '0',
    lastRecordedTs: Number(acct.lastRecordedTs ?? acct.last_recorded_ts ?? 0) * 1000,
    awardCount: Number(acct.awardCount ?? acct.award_count ?? 0),
    lastSpendTs: Number(acct.lastSpendTs ?? acct.last_spend_ts ?? 0) * 1000,
    lastSpendRef: (acct.lastSpendRef ?? acct.last_spend_ref)?.toString() ?? '0',
    lastSpendReason: Number(acct.lastSpendReason ?? acct.last_spend_reason ?? 0),
    spendCount: Number(acct.spendCount ?? acct.spend_count ?? 0),
  };
}

// arcv2m3 Player Core raw decode (the SINGLE per-player account). One read
// yields lives + global ledgers + premium + every game bucket. Offsets are the
// frozen layout from architecture.json arcv2m3 (version 1, LEN 784).
function decodeCore(d) {
  const n = d[182];
  const buckets = {};
  for (let i = 0; i < n; i++) {
    const o = 183 + i * 24;
    let tag = '';
    for (let k = 0; k < 8; k++) { const ch = d[o + k]; if (ch === 0) break; tag += String.fromCharCode(ch); }
    buckets[tag] = {
      pureLifetime: Number(d.readBigUInt64LE(o + 8)),
      spendableBalance: Number(d.readBigUInt64LE(o + 16)),
    };
  }
  return {
    lives: {
      day: Number(d.readBigInt64LE(49)),
      used: d.readUInt16LE(57),
      pool: d.readUInt16LE(59),
      unlimitedUntil: Number(d.readBigInt64LE(61)),
      lastRef: Number(d.readBigUInt64LE(69)),
      awardCount: Number(d.readBigUInt64LE(85)),
    },
    global: {
      pureLifetime: Number(d.readBigUInt64LE(93)),
      lifetime: Number(d.readBigUInt64LE(101)),
      spendableBalance: Number(d.readBigUInt64LE(109)),
    },
    premium: {
      lifetime: Number(d.readBigUInt64LE(117)),
      spendable: Number(d.readBigUInt64LE(125)),
      level: d[133],
      activeUntil: Number(d.readBigInt64LE(134)),
      boosterUntil: Number(d.readBigInt64LE(142)),
      lastCreditRef: Number(d.readBigUInt64LE(150)),
    },
    buckets,
  };
}

// Read the Player Core by wallet address over the ER regions (base fallback).
async function readCoreByAddress(walletAddress) {
  const [core] = corePdaFor(new PublicKey(walletAddress));
  const candidates = await regionCandidatesFor(core);
  for (const url of candidates) {
    try {
      const c = createConnection(url, 'confirmed', 8000);
      const info = await c.getAccountInfo(core);
      if (info && info.data && info.data.length >= 8 + 784) return decodeCore(info.data);
    } catch (e) { /* try next region */ }
  }
  try {
    const c = createConnection(baseRpcUrl(), 'confirmed');
    const info = await c.getAccountInfo(core);
    if (info && info.data && info.data.length >= 8 + 784) return decodeCore(info.data);
  } catch (e) { /* no core */ }
  return null;
}

// Shape the core's premium fields like the legacy premium decoder so the
// profile premium card is unchanged.
function premiumViewFromCore(core) {
  if (!core) return null;
  return {
    version: 1,
    adminAuthority: '',
    premiumLifetime: core.premium.lifetime,
    premiumSpendable: core.premium.spendable,
    subscriptionLevel: core.premium.level,
    subscriptionActiveUntil: core.premium.activeUntil * 1000,
    lastCreditTs: 0,
    lastCreditPoints: 0,
    lastCreditRef: String(core.premium.lastCreditRef || '0'),
    lastSpendTs: 0,
    lastSpendRef: '0',
    lastSpendReason: 0,
    spendCount: 0,
    lastCreditReason: 1,
    boosterActiveUntil: core.premium.boosterUntil * 1000,
  };
}

// M3/M4 READ STABILITY FIX (2026-08-19, mirrors the recovery page EXACTLY):
// fetch *BY WALLET ADDRESS* over the ER using the SAME raw `getAccountInfo` +
// byte-offset decode the working recovery page (dashboard/recovery.html) uses
// (recovery fetchM3/fetchM4). The Anchor typed `.fetch()` is NOT used for
// reads here — the raw path is what provably returns 100/100 on every ER
// region and the base RPC. A ledger is PUBLIC data (the PDA derives from the
// wallet address), so a read never needs the Dynamic signing session.
// Region order = recovery's: AS first, then EU, then US LAST (legacy fallback,
// never US-first — devnet-us is the banned/throttled endpoint). If every ER
// region returns nothing, the base RPC is tried last, exactly like recovery.
async function readPdaByAddressRaw(pda, kindLabel) {
  // Ordered like recovery's ER_REGIONS + BASE_RPC fallback (AS, EU, US, base).
  // IMPORTANT: a delegated account's truth lives on its HOSTING ER region, so we
  // prefer ER and only trust base as a LAST resort. A single transient AS hiccup
  // used to fall all the way to base and read a STALE committed snapshot (e.g. a
  // pre-activation level 0), which poisoned the wallet cache and made the tier
  // badge / lives / daily differ page to page. We now retry the ER regions twice
  // before ever reading base.
  const candidates = ['https://devnet-as.magicblock.app/', 'https://devnet-eu.magicblock.app/', ER_REGION_URLS.us];
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of candidates) {
      try {
        const info = await erConnFor(url).getAccountInfo(pda, 'confirmed');
        if (info && info.data && info.data.length >= 8) {
          markErRpcSuccess(url);
          return { data: info.data, url };
        }
      } catch (e) {
        lastErr = e;
        markErRpcFailure(url);
      }
    }
  }
  // Base RPC last (only for genuinely base-only accounts; never the ER truth).
  try {
    const baseConn = new Connection(config.baseRpcUrl, 'confirmed');
    const info = await baseConn.getAccountInfo(pda, 'confirmed');
    if (info && info.data && info.data.length >= 8) {
      return { data: info.data, url: config.baseRpcUrl };
    }
  } catch (e) {
    lastErr = e;
  }
  if (lastErr) console.warn(`[M3/M4] ${kindLabel} raw read failed on all regions (last: ${lastErr.message})`);
  return null;
}

// Byte-offset decode of the PlayerPoints PDA — mirrors recovery fetchM3 EXACTLY.
// Struct (no version field; 8-byte Anchor discriminator first, fields at 8+):
//   8-15: local_pure_lifetime (u64)   16-23: local_spendable_balance (u64)
//  24-31: last_points (u64)            32:   last_reason (u8)
//  33-40: last_match_ref (u64)        41-48: last_recorded_ts (i64)
//  49-56: award_count (u64)           57-64: last_spend_ts (i64)
//  65-72: last_spend_ref (u64)         73:   last_spend_reason (u8)
//  74-81: spend_count (u64)
function decodePlayerPointsRaw(d) {
  return {
    pureLifetime: d.length >= 16 ? Number(d.readBigUInt64LE(8)) : 0,
    spendableBalance: d.length >= 24 ? Number(d.readBigUInt64LE(16)) : 0,
    lastPoints: d.length >= 32 ? Number(d.readBigUInt64LE(24)) : 0,
    lastReason: d.length >= 33 ? d[32] : 0,
    lastMatchRef: d.length >= 41 ? String(d.readBigUInt64LE(33)) : '0',
    lastRecordedTs: d.length >= 49 ? Number(d.readBigInt64LE(41)) * 1000 : 0,
    awardCount: d.length >= 57 ? Number(d.readBigUInt64LE(49)) : 0,
    lastSpendTs: d.length >= 65 ? Number(d.readBigInt64LE(57)) * 1000 : 0,
    lastSpendRef: d.length >= 73 ? String(d.readBigUInt64LE(65)) : '0',
    lastSpendReason: d.length >= 74 ? d[73] : 0,
    spendCount: d.length >= 82 ? Number(d.readBigUInt64LE(74)) : 0,
  };
}

// Byte-offset decode of the GlobalPoints PDA — mirrors recovery fetchM4 EXACTLY.
// Struct (no version field; 8-byte Anchor discriminator first, fields at 8+):
//   8-15:  global_pure_lifetime (u64)  16-23: global_lifetime (u64)
//  24-31:  global_spendable_balance    32:   last_source (u8)
//  33-40:  last_points (u64)           41:   last_reason (u8)
//  42-49:  last_match_ref (u64)        50-57: last_recorded_ts (i64)
//  58-65:  award_count (u64)           66-73: last_spend_ts (i64)
//  74-81:  last_spend_ref (u64)        82:   last_spend_reason (u8)
//  83-90:  spend_count (u64)
function decodeGlobalPointsRaw(d) {
  return {
    pureLifetime: d.length >= 16 ? Number(d.readBigUInt64LE(8)) : 0,
    lifetime: d.length >= 24 ? Number(d.readBigUInt64LE(16)) : 0,
    spendableBalance: d.length >= 32 ? Number(d.readBigUInt64LE(24)) : 0,
    lastSource: d.length >= 33 ? d[32] : 0,
    lastPoints: d.length >= 41 ? Number(d.readBigUInt64LE(33)) : 0,
    lastReason: d.length >= 42 ? d[41] : 0,
    lastMatchRef: d.length >= 50 ? String(d.readBigUInt64LE(42)) : '0',
    lastRecordedTs: d.length >= 58 ? Number(d.readBigInt64LE(50)) * 1000 : 0,
    awardCount: d.length >= 66 ? Number(d.readBigUInt64LE(58)) : 0,
    lastSpendTs: d.length >= 74 ? Number(d.readBigInt64LE(66)) * 1000 : 0,
    lastSpendRef: d.length >= 82 ? String(d.readBigUInt64LE(74)) : '0',
    lastSpendReason: d.length >= 83 ? d[82] : 0,
    spendCount: d.length >= 91 ? Number(d.readBigUInt64LE(83)) : 0,
  };
}

// Byte-offset decode of the PremiumPoints PDA ([gfgprem, player], M5 buy-only
// premium ledger). Mirrors decodeGlobalPointsRaw: 8-byte Anchor discriminator
// first, then the versioned struct fields at 8+:
//   8:    version (u8)                9-40:  admin_authority (pubkey)
//  41-48: premium_lifetime (u64)     49-56: premium_spendable (u64)
//  57:    subscription_level (u8)     58-65: subscription_active_until (i64)
//  66-73: last_credit_ts (i64)       74-81: last_credit_points (u64)
//  82-89: last_credit_ref (u64)      90-97: last_spend_ts (i64)
//  98-105: last_spend_ref (u64)     106:    last_spend_reason (u8)
// 107-114: spend_count (u64)
function decodePremiumPointsRaw(d) {
  const adminOffset = 9;
  // v2 layout (>= 116 bytes) has last_credit_reason at offset 115 (M3/M4-style reason).
  // v1 accounts default reason to 1 (subscription_payment) so reads stay valid.
  const version = d.length >= 9 ? d[8] : 0;
  return {
    version,
    adminAuthority: d.length >= 41 ? bs58.encode(d.subarray(adminOffset, adminOffset + 32)) : '',
    premiumLifetime: d.length >= 49 ? Number(d.readBigUInt64LE(41)) : 0,
    premiumSpendable: d.length >= 57 ? Number(d.readBigUInt64LE(49)) : 0,
    subscriptionLevel: d.length >= 58 ? d[57] : 0,
    subscriptionActiveUntil: d.length >= 66 ? Number(d.readBigInt64LE(58)) * 1000 : 0,
    lastCreditTs: d.length >= 74 ? Number(d.readBigInt64LE(66)) * 1000 : 0,
    lastCreditPoints: d.length >= 82 ? Number(d.readBigUInt64LE(74)) : 0,
    lastCreditRef: d.length >= 90 ? String(d.readBigUInt64LE(82)) : '0',
    lastSpendTs: d.length >= 98 ? Number(d.readBigInt64LE(90)) * 1000 : 0,
    lastSpendRef: d.length >= 106 ? String(d.readBigUInt64LE(98)) : '0',
    lastSpendReason: d.length >= 107 ? d[106] : 0,
    spendCount: d.length >= 115 ? Number(d.readBigUInt64LE(107)) : 0,
    lastCreditReason: version >= 2 && d.length >= 116 ? d[115] : 1,
    // M5 v3: booster_active_until (i64 secs) at 116-123. Present on v3 (132-byte)
    // accounts; v1/v2 default to 0.
    boosterActiveUntil: (version >= 3 && d.length >= 124) ? Number(d.readBigInt64LE(116)) * 1000 : 0,
  };
}

// Typed Anchor decode (used by the sign-in-scoped fetch path).
function decodePremiumPoints(acct) {
  return {
    version: Number(acct.version ?? 0),
    adminAuthority: (acct.adminAuthority ?? acct.admin_authority)?.toBase58?.() ?? '',
    premiumLifetime: Number(acct.premiumLifetime ?? acct.premium_lifetime ?? 0),
    premiumSpendable: Number(acct.premiumSpendable ?? acct.premium_spendable ?? 0),
    subscriptionLevel: Number(acct.subscriptionLevel ?? acct.subscription_level ?? 0),
    subscriptionActiveUntil: Number(acct.subscriptionActiveUntil ?? acct.subscription_active_until ?? 0) * 1000,
    lastCreditTs: Number(acct.lastCreditTs ?? acct.last_credit_ts ?? 0) * 1000,
    lastCreditPoints: Number(acct.lastCreditPoints ?? acct.last_credit_points ?? 0),
    lastCreditRef: (acct.lastCreditRef ?? acct.last_credit_ref)?.toString() ?? '0',
    lastSpendTs: Number(acct.lastSpendTs ?? acct.last_spend_ts ?? 0) * 1000,
    lastSpendRef: (acct.lastSpendRef ?? acct.last_spend_ref)?.toString() ?? '0',
    lastSpendReason: Number(acct.lastSpendReason ?? acct.last_spend_reason ?? 0),
    spendCount: Number(acct.spendCount ?? acct.spend_count ?? 0),
    lastCreditReason: Number(acct.lastCreditReason ?? acct.last_credit_reason ?? 1),
    boosterActiveUntil: Number(acct.boosterActiveUntil ?? acct.booster_active_until ?? 0) * 1000,
  };
}

async function readPlayerPointsByAddress(gameTag, walletAddress) {
  let pubkey;
  try { pubkey = new PublicKey(walletAddress); } catch (e) { return null; }
  const [pointsPda] = pointsPdaFor(gameTag, pubkey);
  console.log(`[M3] reading Ludo local points PDA ${pointsPda.toBase58()} for wallet ${walletAddress}`);
  const found = await readPdaByAddressRaw(pointsPda, 'M3');
  if (!found) return null;
  const ledger = decodePlayerPointsRaw(found.data);
  console.log(`[M3] wallet ${walletAddress} -> pure ${ledger.pureLifetime} spendable ${ledger.spendableBalance} (from ${found.url})`);
  return ledger;
}

async function readGlobalPointsByAddress(walletAddress) {
  let pubkey;
  try { pubkey = new PublicKey(walletAddress); } catch (e) { return null; }
  const [globalPda] = globalPointsPdaFor(pubkey);
  console.log(`[M4] reading Global points PDA ${globalPda.toBase58()} for wallet ${walletAddress}`);
  const found = await readPdaByAddressRaw(globalPda, 'M4');
  if (!found) return null;
  const ledger = decodeGlobalPointsRaw(found.data);
  console.log(`[M4] wallet ${walletAddress} -> pure ${ledger.pureLifetime} lifetime ${ledger.lifetime} spendable ${ledger.spendableBalance} (from ${found.url})`);
  return ledger;
}

// M5 — read the PREMIUM points PDA ([gfgprem, player]) BY WALLET ADDRESS, no
// Dynamic signing session needed. Mirrors readGlobalPointsByAddress + the
// recovery page's raw byte-offset decode path.
async function readPremiumPointsByAddress(walletAddress) {
  let pubkey;
  try { pubkey = new PublicKey(walletAddress); } catch (e) { return null; }
  const [premiumPda] = premiumPointsPdaFor(pubkey);
  console.log(`[M5] reading Premium points PDA ${premiumPda.toBase58()} for wallet ${walletAddress}`);
  const found = await readPdaByAddressRaw(premiumPda, 'M5');
  if (!found) return null;
  const ledger = decodePremiumPointsRaw(found.data);
  console.log(`[M5] wallet ${walletAddress} -> lifetime ${ledger.premiumLifetime} spendable ${ledger.premiumSpendable} level ${ledger.subscriptionLevel} (from ${found.url})`);
  return ledger;
}

function playerPda(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [PLAYER_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Signature of the most recent on-chain proof roll. Consumed by the Ludo reward
// logic (win-detection.js) so a 1st-place user finish can reference the tx.
let lastProofRollSignature = null;

// True once the ER validator has the delegated account in its state.
// The ER hosts the account under its ORIGINAL program owner (getAccountInfo on
// the ER RPC returns owner=our program once picked up), so existence of the
// account with data on the ER RPC is the correct "picked up" signal — NOT
// owner===DELEGATION_PROGRAM (that would never match on an ER RPC).
async function waitForErPickup(pda) {
  const deadline = Date.now() + config.erPickupWaitMs;
  let url = currentErUrl();
  while (Date.now() < deadline) {
    // Fresh delegations take a beat to report their region fqdn; re-resolve on
    // each pass so the poll converges onto the region that hosts the account.
    const host = await resolvedRegionUrl(pda);
    if (host) url = host;
    try {
      const info = await erConnFor(url).getAccountInfo(pda);
      if (info && info.owner.toBase58() === config.programId && info.data.length > 0) {
        markErRpcSuccess(url);
        return true;
      }
    } catch (e) {
      if (isErNetworkError(e)) {
        // Endpoint down: drop it and try the rotation; the resolve loop above
        // re-locks the poll onto the account's real region on the next pass.
        markErRpcFailure(url);
        erConns.delete(url);
        url = currentErUrl();
      }
      // Else: account not picked up by the ER validator yet; keep polling.
    }
    await sleep(650);
  }
  return false;
}

// App-sponsored onboarding: creates the PDA + delegates it to the ER. The
// relay holds our devnet sponsor key, so the player never needs SOL.
// Delegation is checked via the Magic Router's getDelegationStatus (not
// getAccountInfo.owner): with the Router as the base RPC, getAccountInfo
// returns the ER-side view where the account is owned by OUR program, so the
// owner can never equal the delegation program even when delegated.
async function ensureDelegated(pda, playerPubkey) {
  const baseConn = new Connection(config.baseRpcUrl, 'confirmed');
  try {
    const status = await getDelegationStatus(baseConn, pda);
    if (status && status.isDelegated) return true;
  } catch (e) {
    // Router not reachable; fall back to the relay (it is idempotent).
  }

  console.log('[ER VRF] Delegating player dice account (sponsored by GlobalFolkGames)...');
  const res = await fetch(config.relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: playerPubkey.toString() }),
  });
  if (!res.ok) {
    let msg = `relay error ${res.status}`;
    try { msg += ': ' + (await res.text()); } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.delegated) throw new Error('delegation relay did not delegate the account');

  // Record the base-layer tx signatures the sponsor relay just ran (they ARE
  // explorer-visible, unlike ER txs) so the game can offer real verify links.
  lastDelegateSteps = Array.isArray(data.steps) ? data.steps.slice() : [];

  return waitForErPickup(pda);
}

// Most recent {step, sig} pairs from the sponsor relay. Only refreshed on a
// real (non-idempotent) delegation; empty array once every PDA is delegated.
let lastDelegateSteps = [];

function findLastDelegateSig(stepNames) {
  if (!Array.isArray(lastDelegateSteps)) return null;
  for (let i = lastDelegateSteps.length - 1; i >= 0; i--) {
    const s = lastDelegateSteps[i];
    if (s && s.sig && stepNames.indexOf(s.step) !== -1) return s.sig;
  }
  return null;
}

// Base-layer tx sig for the player's DICE PDA ('initialize'/'delegate' steps).
export function getLastDiceDelegationSignature() {
  return findLastDelegateSig(['delegate', 'initialize']);
}

// Base-layer tx sig for the player's RESULT PDA (Scope C game-record account).
export function getLastResultDelegationSignature() {
  return findLastDelegateSig(['delegate_result', 'initialize_result']);
}

async function rollOnce() {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  const [pda] = playerPda(wallet.publicKey);

  await ensureDelegated(pda, wallet.publicKey);

  // The ER validator may need a moment to include the freshly delegated PDA.
  await waitForErPickup(pda);

  // THE fix: submit the roll AND poll its callback on the region that actually
  // hosts the dice PDA. Rolling on a rotated-but-wrong region confirms ok yet
  // the VRF callback lands on the hosting region, so the poll never sees it.
  const regionUrl = await regionUrlFor(pda);

  console.log(`[ER VRF] Dice PDA ready (${pda.toBase58()}). Requesting the VRF roll - signing + submitting on region ${regionUrl}. If Dynamic emails you, that is the signature step below working; the failure (if any) is next, in submission/confirmation.`);

  // Unique entropy commitment for this roll (included in the VRF proof).
  // Generated fresh per attempt so a region-rotated retry never reuses a seed
  // that could confuse the callback check.
  let clientSeed = Math.floor(Math.random() * 256);

  const proofResult = await withErRetry('roll_dice VRF request', async (ctx) => {
    clientSeed = Math.floor(Math.random() * 256);
    return ctx.program.methods
      .rollDice(clientSeed)
      .accounts({
        player: pda,
        payer: wallet.publicKey,
        playerAuthority: wallet.publicKey,
        oracleQueue: new PublicKey(config.oracleQueue),
      })
      .rpc();
  }, { regionUrl });
  lastProofRollSignature = (typeof proofResult === 'string' && proofResult)
    ? proofResult
    : (proofResult && (proofResult.signature || proofResult.txSig)) || null;

  // Wait for the VRF oracle to fulfill and callback into our program. Poll the
  // SAME region the roll was submitted to (that is where the account lives).
  const deadline = Date.now() + config.requestTimeoutMs;
  let pollCtx = getErProgramFor(regionUrl);
  let pollUrl = regionUrl;
  while (Date.now() < deadline) {
    await sleep(800);
    try {
      const account = await pollCtx.program.account.playerDice.fetch(pda);
      if (account.lastClientSeed === clientSeed) {
        markErRpcSuccess(pollUrl);
        return [Number(account.lastRoll1), Number(account.lastRoll2)];
      }
    } catch (e) {
      if (isErNetworkError(e)) {
        // Endpoint died mid-wait: retry the poll on the SAME region (the
        // account's state lives there; another region can't answer it).
        markErRpcFailure(pollUrl);
        erConns.delete(pollUrl);
        pollUrl = regionUrl;
        pollCtx = getErProgramFor(pollUrl);
      }
      // Account not settled yet; keep polling.
    }
  }

  console.warn('[ER VRF] Timeout waiting for callback result');
  throw new Error('VRF request timed out. Please try again.');
}

// scope B: Points recorded on-chain (M3 — per-game local ledger).
//
// The relay's handleDelegate (idempotent) also creates + delegates a second
// player PDA per game (points, seed 'gfgpoints' + game_tag), so recordPoints()
// is a pure gasless ER write signed by the player's session key — no SOL, no
// sponsor step here. The returned transaction signature is the authoritative
// on-chain receipt of the award, and the player's points PDA becomes the
// verifiable two-track ledger of their rewards (local_pure_lifetime,
// local_spendable_balance, award_count, last_*).
//
// `gameTag` selects the per-game ledger (default 'ludo'). `matchRef` = the
// proof-roll signature that earned the reward encoded as a u64 (its first 8
// bytes), matching what the program stores as last_match_ref so the on-chain
// record is traceable back to the exact winning roll.
export async function recordPoints(gameTag = 'ludo', points, reason, matchRef, playerPubkey) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  // A specific player authority (the seat's OWN wallet) can be passed for
  // MULTIPLAYER/overseats crediting: a device that legitimately hosts several
  // user seats banks EACH seat to ITS own wallet. Default = this device's
  // wallet (single-player unchanged).
  const authority = (playerPubkey && playerPubkey.constructor && playerPubkey.constructor.name === 'PublicKey')
    ? playerPubkey
    : (playerPubkey ? new PublicKey(playerPubkey) : wallet.publicKey);
  // arcv2m3: bank the per-game award into the player's CORE bucket (no per-game
  // PDA). ensureDelegated triggers the relay which creates + delegates the core
  // in the same one-time onboarding; the write is gasless ER.
  const [core] = corePdaFor(authority);
  await ensureDelegated(core, authority);
  await waitForErPickup(core);

  const regionUrl = await regionUrlFor(core);

  const sig = await withErRetry('record_core_points', async (ctx) => ctx.program.methods
    .recordCorePoints(gameTag, new BN(points), reason, matchRef instanceof BN ? matchRef : new BN(matchRef.toString()))
    .accounts({
      core,
      payer: wallet.publicKey,
      playerAuthority: authority,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// M3 — local spendable draw-down: spends `amount` of the player's SPENDABLE
// track (never the pure track) for that game's own in-game purchases (S3
// shop). Gasless ER write; `reason` uses the SPEND_REASONS map and `spendRef`
// is the purchase reference that makes the spend replayable.
export async function spendLocal(gameTag = 'ludo', amount, reason, spendRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  // arcv2m3: spend from the player's CORE bucket for this game (the retired
  // per-game points PDA is gone). ensureDelegated triggers the relay which
  // creates + delegates the core in the same one-time onboarding.
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(core);

  const regionUrl = await regionUrlFor(core);

  const sig = await withErRetry('spend_core_local', async (ctx) => ctx.program.methods
    .spendCoreLocal(gameTag, new BN(amount), reason, spendRef instanceof BN ? spendRef : new BN(spendRef.toString()))
    .accounts({
      core,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// ===== M12 — multiplayer match board (gfgboard2) gasless ER writes =====
// The board is created + delegated by the relay (sponsor) at create time, so
// these only resolve the hosting region, wait for pickup, and SUBMIT signed by
// the PLAYER's session key (0 SOL, gasless). Every one is soft-fail by design.
function boardPdaFor(game, matchRef) {
  const refBuf = new BN(String(matchRef)).toArrayLike(Buffer, 'le', 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('gfgboard2'), Buffer.from([Number(game)]), refBuf],
    new PublicKey(config.programId),
  );
}

function toBytes32(a) {
  const out = new Uint8Array(32);
  if (Array.isArray(a)) {
    for (let i = 0; i < 32 && i < a.length; i++) out[i] = Number(a[i]) & 0xff;
  }
  return out;
}

// A player (owner of a seat) registers their wallet + sitewide handle into an
// open seat. Gasless ER write, PLAYER session key signs. Returns {ok, seat}.
export async function joinBoardMatch(game, matchRef, seat, handle) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the join.');
  const { wallet } = ctx;
  const [board] = boardPdaFor(game, matchRef);
  // M10 lives gate: the JOINER's lives ledger must EXIST and pass the on-chain
  // lives check. ensureDelegated triggers the sponsor relay which creates +
  // delegates it (BUNDLED with dice/points/result/global/premium in the SAME
  // first-time onboarding - sponsor pays once per player lifetime, then every
  // lives write is a 0-fee ER tx). The program enforces the gate itself.
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  await withErRetry('join_match', async (eCtx) => eCtx.program.methods
    .joinMatch(game, new BN(matchRef), seat, String(handle || ''))
    .accounts({ signer: wallet.publicKey, board, core })
    .rpc(), { regionUrl });
  return { ok: true, seat };
}

// The HOST begins the live match (status 0 -> 1). Requires the signer to be
// players[0] (seat-authority), so only the host's device can start. Gasless.
// M10 lives gate: the CREATOR's lives ledger is required too (chain-enforced).
export async function beginBoardMatch(game, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign begin.');
  const { wallet } = ctx;
  const [board] = boardPdaFor(game, matchRef);
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('begin_match', async (eCtx) => eCtx.program.methods
    .beginMatch(game, new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board, core })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

// M10 consume a life when a match completes (the M2 seam fires on completion).
// Gasless ER write; idempotent by match_ref in the program. Soft-fail (an
// on-chain lifecycle hiccup never blocks the win UX).
export async function consumeLife(game, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the life.');
  const { wallet } = ctx;
  const [lives] = livesPdaFor(wallet.publicKey);
  await ensureDelegated(lives, wallet.publicKey);
  await waitForErPickup(lives);
  const regionUrl = await regionUrlFor(lives);
  const sig = await withErRetry('consume_life', async (eCtx) => eCtx.program.methods
    .consumeLife(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, lives })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

// Read a wallet's on-chain lives ledger (own or any public address, gasless).
// Returns {ok, day, used, pool, unlimitedUntil, awardCount} or {ok:false}.
export async function readLivesFor(pubkey) {
  const [core] = corePdaFor(pubkey);
  try {
    // Lives now live in the arcv2m3 Player Core account [gfgcore, player]. Read
    // from its HOSTING ER region (fallback base) so the display never drifts.
    let info = null;
    try {
      const url = await regionUrlFor(core);
      const c = createConnection(url, 'confirmed', 8000);
      info = await c.getAccountInfo(core);
    } catch (e) { /* fall back to base */ }
    if (!info) {
      const cb = createConnection(baseRpcUrl(), 'confirmed');
      info = await cb.getAccountInfo(core).catch(() => null);
    }
    if (!info || !info.data) return { ok: false, error: 'player core not found' };
    const d = info.data;
    if (d.length < 8 + 744) return { ok: false, error: 'player core too small' };
    return {
      ok: true,
      day: Number(d.readBigInt64LE(49)),
      used: d.readUInt16LE(57),
      pool: d.readUInt16LE(59),
      unlimitedUntil: Number(d.readBigInt64LE(61)),
      lastRef: Number(d.readBigUInt64LE(69)),
      awardCount: Number(d.readBigUInt64LE(85)),
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

const LivesAccountSize = 1 + 32 + 8 + 2 + 2 + 8 + 8 + 8 + 8; // == LivesAccount::INIT_SPACE

function corePdaFor(pubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('gfgcore'), pubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

function livesPdaFor(pubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('gfglives'), pubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// ===== M1A Chess (single player, fully on-chain) =====
// The relay creates + delegates the board once (sponsor); the player signs the
// start and every move on the ER (gasless, session key). The house signs the
// on-chain AI reply. All soft-fail friendly; the program enforces the rules.

function chessPdaFor(matchRef) {
  const refBuf = new BN(String(matchRef)).toArrayLike(Buffer, 'le', 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('gfgchess'), refBuf],
    new PublicKey(config.programId),
  );
}

async function chessRelay(action, payload) {
  const res = await fetch('/api/chess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action }, payload || {})),
  });
  if (!res.ok) throw new Error('chess relay error ' + res.status);
  return res.json();
}

export async function createChessMatch(matchRef, hostPubkey, timeMs, incrementMs, solo) {
  return chessRelay('create', { matchRef, host: hostPubkey, timeMs, incrementMs, solo: (solo === 0 ? 0 : 1) });
}

// Phase 3 (multiplayer): join an open seat (gasless ER write, lives-gated).
export async function joinChessMatch(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the join.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  await withErRetry('join_chess_match', async (eCtx) => eCtx.program.methods
    .joinChessMatch(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board, core })
    .rpc(), { regionUrl });
  return { ok: true };
}

export async function resignChessMatch(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the resignation.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('resign_chess_match', async (eCtx) => eCtx.program.methods
    .resignChessMatch(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function offerDrawChess(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the draw offer.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('offer_draw_chess', async (eCtx) => eCtx.program.methods
    .offerDrawChess(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function acceptDrawChess(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the draw accept.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('accept_draw_chess', async (eCtx) => eCtx.program.methods
    .acceptDrawChess(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function startChessMatch(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign start.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('start_chess_match', async (eCtx) => eCtx.program.methods
    .startChessMatch(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board, core })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function makeChessMove(matchRef, from, to, promo) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the move.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('make_chess_move', async (eCtx) => eCtx.program.methods
    .makeChessMove(new BN(matchRef), from, to, promo || 0)
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function aiChessMove(matchRef, level) {
  return chessRelay('ai', { matchRef, level: level || 1 });
}

export async function claimChessTimeout(matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the claim.');
  const { wallet } = ctx;
  const [board] = chessPdaFor(matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('claim_chess_timeout', async (eCtx) => eCtx.program.methods
    .claimChessTimeout(new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

export async function readChessBoard(matchRef) {
  return chessRelay('state', { matchRef });
}

// A player commits their seat's move (32-byte commit) gasless. The program
// verifies signer == players[seat], so the wrong device is rejected on-chain.
export async function commitBoardMove(game, matchRef, seat, moveCommit) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the move.');
  const { wallet } = ctx;
  const [board] = boardPdaFor(game, matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const bytes = Array.from(toBytes32(moveCommit));
  const sig = await withErRetry('commit_move', async (eCtx) => eCtx.program.methods
    .commitMove(game, new BN(matchRef), seat, bytes)
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

// A seat holder finalizes the match with a winner seat. Gasless.
export async function finishBoardMatch(game, matchRef, winnerSeat) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign finish.');
  const { wallet } = ctx;
  const [board] = boardPdaFor(game, matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('finish_match', async (eCtx) => eCtx.program.methods
    .finishMatch(game, new BN(matchRef), winnerSeat)
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

// arc2m1 turn timer (Option B): PERMISSIONLESS force-pass when the current
// turn's on-chain deadline has passed. ANY participant device (or a future
// frontend) may call it so a stalled/lapsed turn moves on and the game cannot
// hang. The program verifies the deadline itself - this is just the gasless
// write (session key signs, 0 SOL). Soft-fail: if the deadline hasn't passed,
// the program rejects with StillRunning and nothing changes.
export async function expireBoardTurn(game, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('No connected wallet to sign the turn expiry.');
  const { wallet } = ctx;
  const [board] = boardPdaFor(game, matchRef);
  await waitForErPickup(board);
  const regionUrl = await regionUrlFor(board);
  const sig = await withErRetry('expire_turn', async (eCtx) => eCtx.program.methods
    .expireTurn(game, new BN(matchRef))
    .accounts({ signer: wallet.publicKey, board })
    .rpc(), { regionUrl });
  return { ok: true, sig };
}

function pointsPdaFor(gameTag, payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [POINTS_SEED, Buffer.from(gameTag, 'utf8'), payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

function globalPointsPdaFor(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [POINTS_SEED, GLOBAL_TAG, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// M5 — the player's PREMIUM points PDA ([gfgprem, player], buy-only ledger).
function premiumPointsPdaFor(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [PREMIUM_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// M4 — global points credit: credits the player's GLOBAL POINTS PDA (M4a
// pure + M4b lifetime + M4c spendable for kind=0 game wins; M4b+M4c only
// for kind=1 other credits). Gasless on the ER; `matchRef` guards idempotency.
// `sourceCode` is a u8 enum (1=ludo, 2=ayo_olopon, 10=signup_bonus, etc.).
export async function recordGlobalPoints(kind, sourceCode, points, reason, matchRef, playerPubkey) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  // MULTIPLAYER: credit the seat's OWN wallet (from the on-chain map) when a
  // caller passes it; default = this device's wallet (single-player unchanged).
  const authority = (playerPubkey && playerPubkey.constructor && playerPubkey.constructor.name === 'PublicKey')
    ? playerPubkey
    : (playerPubkey ? new PublicKey(playerPubkey) : wallet.publicKey);
  const [core] = corePdaFor(authority);

  await ensureDelegated(core, authority);
  await waitForErPickup(core);

  const regionUrl = await regionUrlFor(core);

  const sig = await withErRetry('record_core_global', async (ctx) => ctx.program.methods
    .recordCoreGlobal(kind, new BN(points), reason, matchRef instanceof BN ? matchRef : new BN(matchRef.toString()))
    .accounts({
      core,
      payer: wallet.publicKey,
      playerAuthority: authority,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// M4 — global spendable draw-down: spends `amount` of the player's GLOBAL
// spendable balance (M4c). M4a pure and M4b lifetime are never touched.
// Gasless on the ER; `spendRef` is the purchase reference for replayability.
export async function spendGlobal(amount, reason, spendRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  const [core] = corePdaFor(wallet.publicKey);

  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(core);

  const regionUrl = await regionUrlFor(core);

  const sig = await withErRetry('spend_core_global', async (ctx) => ctx.program.methods
    .spendCoreGlobal(new BN(amount), reason, spendRef instanceof BN ? spendRef : new BN(spendRef.toString()))
    .accounts({
      core,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// M5 — premium spendable draw-down on the player's PREMIUM points PDA
// ([gfgprem, player]). Gasless on the ER; `spendRef` guards replayability.
// premium_lifetime is never touched.
export async function spendPremiumPoints(amount, reason, spendRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  // M5: spend from the player's CORE premium spendable (the retired premium
  // PDA is gone). Gasless ER write signed by the player's session key.
  const [core] = corePdaFor(wallet.publicKey);
  await ensureDelegated(core, wallet.publicKey);
  await waitForErPickup(core);

  const regionUrl = await regionUrlFor(core);

  const sig = await withErRetry('spend_core_premium', async (ctx) => ctx.program.methods
    .spendCorePremium(new BN(amount), reason, spendRef instanceof BN ? spendRef : new BN(spendRef.toString()))
    .accounts({
      core,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// M5 — activates the Level-2 Active Tier on-chain: deducts PREMIUM_PLAN_COST
// (5,000) premium spendable and sets subscription_level=2 with a 30-day active
// window (NO auto-renew). Gasless on the ER; the player's session key signs.
export async function activateSubscription() {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  const [premiumPda] = premiumPointsPdaFor(wallet.publicKey);

  await ensureDelegated(premiumPda, wallet.publicKey);
  await waitForErPickup(premiumPda);

  const regionUrl = await regionUrlFor(premiumPda);

  const sig = await withErRetry('activate_subscription', async (ctx) => ctx.program.methods
    .activateSubscription()
    .accounts({
      premiumPoints: premiumPda,
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// M5 — operator-gated PREMIUM credit via the sponsor relay (the sponsor key
// signs base-layer, never the client). The relay is idempotent by credit_ref.
// Posts to /api/credit-premium and resolves the on-chain ledger after.
// Tracer: used by the staff credit UI; never called from game code.
export async function creditPremiumPoints(player, points, creditRef, operatorToken) {
  const res = await fetch('/api/credit-premium', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player, points, creditRef, token: operatorToken }),
  });
  if (!res.ok) {
    let msg = `credit relay error ${res.status}`;
    try { msg += ': ' + (await res.text()); } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'credit relay failed');
  return readPremiumPointsByAddress(player);
}
// (session key signs, 0 SOL), mirroring recordPoints. The relay's handleDelegate
// (idempotent) also creates + delegates the result PDA (seed 'gfgresult'), so
// this write is a pure ER send once onboarded.
//
// `finishOrder` = array of color/seat keys, index 0 = 1st place (maps to the
// program's `finish_order[i]` = seat index that finished in position i+1).
// `points`/`multiplier`/`matchRef` mirror the reward that was banked, tying the
// committed finish to the exact winning roll.
export async function recordResult(finishOrder, points, multiplier, matchRef) {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  const [resultPda] = resultPdaFor(wallet.publicKey);

  // Relay is idempotent per PDA; it creates + delegates the result PDA if
  // missing and is a no-op when already delegated. Then the ER write is free.
  await ensureDelegated(resultPda, wallet.publicKey);
  await waitForErPickup(resultPda);

  const regionUrl = await regionUrlFor(resultPda);

  // Map colors to the canonical seat indexes (green=0, yellow=1, blue=2, red=3).
  const seatIndexes = finishOrder.map(color =>
    typeof color === 'number' ? color : SEAT_INDEX[color] ?? 0,
  );
  const order = Array.from({ length: 4 }, (_, i) => seatIndexes[i] ?? 0);

  const sig = await withErRetry('record_result (Scope C finish order)', async (ctx) => ctx.program.methods
    .recordResult(
      order,
      new BN(points),
      new BN(multiplier),
      matchRef instanceof BN ? matchRef : new BN(matchRef.toString()),
    )
    .accounts({
      payer: wallet.publicKey,
      playerAuthority: wallet.publicKey,
      result: resultPda,
    })
    .rpc(), { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

const SEAT_INDEX = Object.freeze({ green: 0, yellow: 1, blue: 2, red: 3 });

function resultPdaFor(payerPubkey) {
  return PublicKey.findProgramAddressSync(
    [RESULT_SEED, payerPubkey.toBytes()],
    new PublicKey(config.programId),
  );
}

// S2: winner claims their competition allocation. Gasless ER write signed by
// the player's session key (0 SOL), mirroring recordPoints. The relay's
// handleDelegate (idempotent) also creates + delegates the player's points
// PDA, which is what the claim credits.
//
// `compPda` identifies the competition (seed `gfgcomp` + sponsor pubkey, read
// via the relay's GET /api/comp). `winnerIndex` = the player's slot in the
// settled winner table (0, 1, 2). `gameTag` selects which game's points ledger
// receives the prize (default 'ludo'). Returns the claim receipt signature.
export async function claimComp(compPda, winnerIndex, gameTag = 'ludo') {
  const ctx = getErProgram();
  if (!ctx) throw new Error('MagicBlock VRF is not configured or no wallet is connected.');

  const { wallet } = ctx;
  const [pointsPda] = pointsPdaFor(gameTag, wallet.publicKey);

  // The winner's points PDA must exist + be delegated for the claim to credit
  // it. Relay is idempotent: creates + delegates if missing, no-op if done.
  await ensureDelegated(pointsPda, wallet.publicKey);
  await waitForErPickup(pointsPda);

  const regionUrl = await regionUrlFor(pointsPda);

  const sig = await withErRetry('claim_comp (S2 winner claim)', async (ctx) => {
    // Read the sponsor out of the comp account so the PDA seed constraint passes.
    const compAccount = await ctx.program.account.competition.fetch(new PublicKey(compPda));
    const sponsorKey = new PublicKey(compAccount.sponsor);

    return ctx.program.methods
      .claimComp(gameTag, winnerIndex)
      .accounts({
        payer: wallet.publicKey,
        playerAuthority: wallet.publicKey,
        points: pointsPda,
        sponsor: sponsorKey,
        comp: new PublicKey(compPda),
      })
      .rpc();
  }, { regionUrl });

  return (typeof sig === 'string' && sig) ? sig : (sig && (sig.signature || sig.txSig)) || null;
}

// matchRef for a proof-roll signature: first 8 bytes interpreted as a u64.
export function matchRefFromSignature(sig) {
  if (!sig) return new BN(0);
  try {
    const bytes = bs58.decode(sig);
    if (!bytes || bytes.length < 8) return new BN(0);
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) view.setUint8(i, bytes[i]);
    const hex = Buffer.from(new Uint8Array(view.buffer)).toString('hex');
    return new BN(hex, 16);
  } catch (e) {
    return new BN(0);
  }
}

// Bytes 4-11 of the same proof-roll signature as u64 — a distinct ref for the
// M5 tier-boost kind=1 credit so it passes the single last_match_ref dedupe
// guard (the game win already occupies match_ref).
export function boostRefFromSignature(sig) {
  if (!sig) return new BN(0);
  try {
    const bytes = bs58.decode(sig);
    if (!bytes || bytes.length < 12) return new BN(0);
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) view.setUint8(i, bytes[4 + i]);
    const hex = Buffer.from(new Uint8Array(view.buffer)).toString('hex');
    return new BN(hex, 16);
  } catch (e) {
    return new BN(0);
  }
}

export function initMagicBlockDice() {
  // Reason codes for on-chain points records (shared with win-detection.js).
  window.POINT_REASONS = POINT_REASONS;
  window.SPEND_REASONS = SPEND_REASONS;
  window.magicblockDice = {
    configure(opts = {}) {
      if (opts.programId) config.programId = opts.programId;
      if (opts.idl) config.idl = opts.idl;
      if (opts.baseRpcUrl) config.baseRpcUrl = opts.baseRpcUrl;
      if (opts.erRpcUrl) config.erRpcUrl = opts.erRpcUrl;
      if (opts.erValidator) config.erValidator = opts.erValidator;
      if (opts.oracleQueue) config.oracleQueue = opts.oracleQueue;
      if (opts.relayUrl) config.relayUrl = opts.relayUrl;
    },

    isConfigured() {
      return !!(config.programId && config.idl);
    },

    // True only when a deployed program is configured AND a Solana wallet
    // session exists. Game falls back to local randomness otherwise.
    available() {
      return this.isConfigured() && !!getSolanaWalletAccount();
    },

    // Returns a Promise<[d1, d2]>, each 1..=6.
    roll() {
      return rollOnce();
    },

    getLastProofRollSignature() {
      return lastProofRollSignature;
    },

    // Base-layer tx that created + delegated the player's DICE PDA (the sponsor
    // relay runs these once, on devnet). Unlike ER rollup txs, this IS indexed
    // by public explorers, so it is the linkable proof of the dice account.
    getLastDiceDelegationSignature() {
      return getLastDiceDelegationSignature();
    },

    // Base-layer tx that created + delegated the player's RESULT PDA (the
    // Scope C game-record account). Also devnet-visible and linkable.
    getLastResultDelegationSignature() {
      return getLastResultDelegationSignature();
    },

    // Scope B (M3): records the award on the player's on-chain points PDA for
    // `gameTag` (gasless ER write, session key signs). Accepts both
    // (gameTag, points, reason, matchRef) and the legacy (points, reason,
    // matchRef) form (defaults gameTag to 'ludo'). Returns the receipt sig.
    recordPoints(a, b, c, d) {
      if (typeof a === 'string') return recordPoints(a, b, c, d);
      return recordPoints('ludo', a, b, c);
    },

    // M3 — local spendable draw-down for `gameTag` (gasless ER write). Returns
    // the spend receipt signature.
    spendLocal(gameTag, amount, reason, spendRef) {
      return spendLocal(gameTag, amount, reason, spendRef);
    },

    // Scope C: commits the full 1st..4th finish order on-chain (gasless ER
    // write, session key signs). Returns the receipt signature.
    recordResult(finishOrder, points, multiplier, matchRef) {
      return recordResult(finishOrder, points, multiplier, matchRef);
    },

    // S2: winner claims their competition allocation gasless on the ER
    // (session key signs, 0 SOL). `compPda` from the relay, `winnerIndex`
    // from the settled winner table, `gameTag` selects the points ledger that
    // receives the prize. Returns the claim receipt signature.
    claimComp(compPda, winnerIndex, gameTag = 'ludo') {
      return claimComp(compPda, winnerIndex, gameTag);
    },

    // First 8 bytes of a proof-roll signature as u64 — the match_ref the
    // program stores, so the on-chain record traces to the exact winning roll.
    matchRefFromSignature(sig) {
      return matchRefFromSignature(sig);
    },

    boostRefFromSignature(sig) {
      return boostRefFromSignature(sig);
    },

    // M4 — records a global points credit on-chain (gasless ER write).
    // kind: 0 = game win (pure+lifetime+spendable), 1 = other (lifetime+spendable only).
    // sourceCode: u8 enum identifying the game/source. points/reason/matchRef mirror M3.
    async recordGlobalPoints(kind, sourceCode, points, reason, matchRef, playerPubkey) {
      return recordGlobalPoints(kind, sourceCode, points, reason, matchRef, playerPubkey);
    },

    // ===== arc2m1 — multiplayer match board (gasless ER, player session key) =====
    joinBoardMatch(game, matchRef, seat, handle) {
      return joinBoardMatch(game, matchRef, seat, handle);
    },
    beginBoardMatch(game, matchRef) {
      return beginBoardMatch(game, matchRef);
    },
    commitBoardMove(game, matchRef, seat, moveCommit) {
      return commitBoardMove(game, matchRef, seat, moveCommit);
    },
    finishBoardMatch(game, matchRef, winnerSeat) {
      return finishBoardMatch(game, matchRef, winnerSeat);
    },
    // arc2m1 turn timer (Option B): permissionless force-pass of a lapsed turn.
    expireBoardTurn(game, matchRef) {
      return expireBoardTurn(game, matchRef);
    },
    // M10 lives: consume one on completion + read the on-chain lives ledger.
    consumeLife(game, matchRef) {
      return consumeLife(game, matchRef);
    },
    readLivesFor(pubkey) {
      return readLivesFor(pubkey);
    },

    // M1A Chess (single player, fully on-chain): relay-create the board, then
    // start / move / claim on the ER (gasless) and read the board state.
    chess: {
      pda(matchRef) { return chessPdaFor(matchRef); },
      create(matchRef, hostPubkey, timeMs, incrementMs, solo) { return createChessMatch(matchRef, hostPubkey, timeMs, incrementMs, solo); },
      join(matchRef) { return joinChessMatch(matchRef); },
      start(matchRef) { return startChessMatch(matchRef); },
      move(matchRef, from, to, promo) { return makeChessMove(matchRef, from, to, promo); },
      ai(matchRef, level) { return aiChessMove(matchRef, level); },
      claimTimeout(matchRef) { return claimChessTimeout(matchRef); },
      resign(matchRef) { return resignChessMatch(matchRef); },
      offerDraw(matchRef) { return offerDrawChess(matchRef); },
      acceptDraw(matchRef) { return acceptDrawChess(matchRef); },
      read(matchRef) { return readChessBoard(matchRef); },
    },

    // M4 — global spendable draw-down (gasless ER write). Returns the spend receipt sig.
    async spendGlobal(amount, reason, spendRef) {
      return spendGlobal(amount, reason, spendRef);
    },

    // The player's on-chain global points PDA address (own-account profile view).
    globalPointsPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return globalPointsPdaFor(wallet.publicKey)[0].toBase58();
    },

    // The player's arcv2m3 Player Core account address [gfgcore, player]
    // (own-account profile view). Lives, global, premium, and every per-game
    // point bucket live in this ONE account, so the profile cards link here.
    corePda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return corePdaFor(wallet.publicKey)[0].toBase58();
    },

    // The player's on-chain points PDA address for `gameTag` (own-account
    // profile view).
    pointsPda(gameTag = 'ludo') {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return pointsPdaFor(gameTag, wallet.publicKey)[0].toBase58();
    },

    // The player's on-chain game-record (result) PDA address.
    resultPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return resultPdaFor(wallet.publicKey)[0].toBase58();
    },

    // Reads the player's on-chain points ledger for `gameTag` from the ER
    // (gasless, no sign). Returns
    // { pureLifetime, spendableBalance, lastPoints, lastReason, lastMatchRef,
    //   lastRecordedTs, awardCount, lastSpendTs, lastSpendRef, lastSpendReason,
    //   spendCount }
    // or null if the PDA isn't visible yet.
    async fetchPointsPda(gameTag = 'ludo') {
      const ctx = getErProgram();
      if (!ctx) return null;
      const { wallet } = ctx;
      const core = await readCoreByAddress(wallet.publicKey.toBase58());
      const b = core && core.buckets[gameTag];
      if (!b) return null;
      return { pureLifetime: b.pureLifetime, spendableBalance: b.spendableBalance, lastPoints: 0, lastReason: 0, lastMatchRef: '0', lastRecordedTs: 0, awardCount: 0, lastSpendTs: 0, lastSpendRef: '0', lastSpendReason: 0, spendCount: 0 };
    },

    // READ STABILITY (2026-08-19): read the player's per-game points ledger BY
    // WALLET ADDRESS, no Dynamic signing session needed. arcv2m3: reads the
    // bucket inside the Player Core. Falls back to the sign-in-scoped fetch.
    async fetchPointsPdaFor(gameTag = 'ludo', walletAddress) {
      if (!walletAddress) return this.fetchPointsPda(gameTag);
      const core = await readCoreByAddress(String(walletAddress));
      const b = core && core.buckets[gameTag];
      if (!b) return null;
      return { pureLifetime: b.pureLifetime, spendableBalance: b.spendableBalance, lastPoints: 0, lastReason: 0, lastMatchRef: '0', lastRecordedTs: 0, awardCount: 0, lastSpendTs: 0, lastSpendRef: '0', lastSpendReason: 0, spendCount: 0 };
    },

    // M4 — reads the player's on-chain GLOBAL points ledger from the ER
    // (gasless, no sign). Returns
    // { pureLifetime, lifetime, spendableBalance, lastSource, lastPoints,
    //   lastReason, lastMatchRef, lastRecordedTs, awardCount,
    //   lastSpendTs, lastSpendRef, lastSpendReason, spendCount }
    // or null if the PDA isn't visible yet.
    async fetchGlobalPointsPda() {
      const ctx = getErProgram();
      if (!ctx) return null;
      const { wallet } = ctx;
      const core = await readCoreByAddress(wallet.publicKey.toBase58());
      if (!core) return null;
      return { ...core.global, lastSource: 0, lastPoints: 0, lastReason: 0, lastMatchRef: '0', lastRecordedTs: 0, awardCount: 0, lastSpendTs: 0, lastSpendRef: '0', lastSpendReason: 0, spendCount: 0 };
    },

    // READ STABILITY (2026-08-19): read the global ledger BY WALLET ADDRESS, no
    // Dynamic signing session needed. arcv2m3: reads the core's globals.
    async fetchGlobalPointsPdaFor(walletAddress) {
      if (!walletAddress) return this.fetchGlobalPointsPda();
      const core = await readCoreByAddress(String(walletAddress));
      if (!core) return null;
      return { ...core.global, lastSource: 0, lastPoints: 0, lastReason: 0, lastMatchRef: '0', lastRecordedTs: 0, awardCount: 0, lastSpendTs: 0, lastSpendRef: '0', lastSpendReason: 0, spendCount: 0 };
    },

    // M5 — the player's on-chain PREMIUM points PDA address ([gfgprem, player],
    // buy-only ledger).
    premiumPointsPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return premiumPointsPdaFor(wallet.publicKey)[0].toBase58();
    },

    // M5 — reads the player's PREMIUM points ledger from the ER (gasless, no
    // sign). Returns
    // { version, adminAuthority, premiumLifetime, premiumSpendable,
    //   subscriptionLevel, subscriptionActiveUntil, lastCreditTs,
    //   lastCreditPoints, lastCreditRef, lastSpendTs, lastSpendRef,
    //   lastSpendReason, spendCount }
    // or null if the PDA isn't visible yet.
    async fetchPremiumPointsPda() {
      const wallet = getSolanaWalletAccount();
      if (!wallet) return null;
      return premiumViewFromCore(await readCoreByAddress(wallet.publicKey.toBase58()));
    },

    // M5 — read the PREMIUM ledger BY WALLET ADDRESS (now the core's premium
    // fields), no Dynamic signing session needed.
    async fetchPremiumPointsPdaFor(walletAddress) {
      if (!walletAddress) return this.fetchPremiumPointsPda();
      return premiumViewFromCore(await readCoreByAddress(String(walletAddress)));
    },

    // M5 — premium spendable draw-down on the player's PREMIUM points PDA
    // (gasless ER write, session key signs). Returns the spend receipt sig.
    spendPremiumPoints(amount, reason, spendRef) {
      return spendPremiumPoints(amount, reason, spendRef);
    },

    // M5 — activates the Level-2 Active Tier on-chain (deducts 5,000 premium
    // spendable, sets a 30-day sub, NO auto-renew). Gasless ER write.
    activateSubscription() {
      return activateSubscription();
    },

    // M5 (plan ladder) — activates a SPECIFIC plan level (2 = 5,000P,
    // 3 = 10,000P) from premium spendable. Gasless ER write.
    activateSubscriptionLevel(level) {
      return activateSubscriptionLevel(level);
    },

    // M5 — operator-gated PREMIUM credit (staff UI only). The relay calls back
    // with the on-chain ledger after crediting.
    creditPremiumPoints(player, points, creditRef, operatorToken) {
      return creditPremiumPoints(player, points, creditRef, operatorToken);
    },

    // Cheap liveness probe for the on-chain outage monitor. Resolves true when
    // BOTH the base RPC and the ER RPC answer (devnet + the Rollup where rolls
    // execute). Never throws; the monitor treats any failure as "still down".
    ping() {
      return pingOnchainStack();
    },
  };
}

const pingConnCache = new Map();

async function pingOnchainStack() {
  const probe = async (url) => {
    let conn = pingConnCache.get(url);
    if (!conn) {
      conn = createConnection(url, 'confirmed', 15000);
      pingConnCache.set(url, conn);
    }
    let timer;
    try {
      // getLatestBlockhash (not getSlot): every MagicBlock devnet endpoint AND
      // the base devnet RPC answer it, so a healthy stack never pings a method
      // it does not implement.
      const blockhashPromise = conn.getLatestBlockhash('confirmed');
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), 5000);
      });
      await Promise.race([blockhashPromise, timeout]);
      return true;
    } catch (e) {
      console.warn(`[ER VRF] ping failed for ${url}`, e.message || e);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const base = await probe(config.baseRpcUrl);
  const erUrl = currentErUrl();
  const er = await probe(erUrl);
  if (er) markErRpcSuccess(erUrl); else markErRpcFailure(erUrl);
  return base && er;
}
