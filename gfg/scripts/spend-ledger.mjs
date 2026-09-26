// scripts/spend-ledger.mjs
// Sponsor spend ledger + caps for the delegate relay.
//
// The app pays for every player's onboarding (initialize + delegate, ~0.0013
// SOL). Without limits, a bad actor who can mint fresh wallet keys could drain
// the sponsor wallet (each key costs the sponsor ~1 onboarding). This module
// keeps a durable record of how much the sponsor has spent per player and in
// total, and REFUSES to sponsor work that would exceed the configured caps.
//
// SERVER-SIDE ONLY. Never import from client code. On Vercel this runs per
// serverless instance; the default JSON-file store is scoped to the instance,
// which is fine on devnet. Locking this to a real durable store (Supabase KV
// / Postgres) is listed in the security queue before mainnet.
//
// Env config (all optional):
//   GFG_SPEND_CAP_PER_PLAYER_SOL  max sponsor spend per player pubkey  (default 0.005)
//   GFG_SPEND_CAP_GLOBAL_SOL      max sponsor spend across all players (default 1.0)
//   GFG_SPEND_RESERVE_SOL         sponsor balance floor to keep         (default 0.3)
//   GFG_GAS_TANK_SOL              gas reserve "full tank" reference for the
//                                 dashboard battery meter               (default 100)
//   SPEND_LEDGER_PATH             ledger file path                       (default .gfg-spend-ledger.json)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export const DEFAULT_LEDGER_PATH = '.gfg-spend-ledger.json';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class SpendCapExceeded extends Error {
  constructor(message, kind, limitLamports, usedLamports) {
    super(message);
    this.name = 'SpendCapExceeded';
    this.kind = kind;
    this.limitLamports = limitLamports;
    this.usedLamports = usedLamports;
  }
}

export function spendCaps() {
  return {
    // Per-player default sized for the FULL first-time onboarding: dice +
    // points + result + global + premium + lives, each ~0.0042 SOL fresh
    // init+delegate (measured live ~0.018 for all six); 0.025 leaves margin and
    // stays far under the total / tank. Env-tunable.
    perPlayerLamports: Math.round(envNumber('GFG_SPEND_CAP_PER_PLAYER_SOL', 0.025) * LAMPORTS_PER_SOL),
    // Global default 10 SOL on devnet: at ~0.0084 SOL/player it funds the
    // first ~1,000 fresh players without an onboarding pause. It is a safety
    // tripwire against a drained sponsor wallet, NOT a subscription meter, so it
    // is sized generously while devnet SOL is free. Env-tunable.
    globalLamports: Math.round(envNumber('GFG_SPEND_CAP_GLOBAL_SOL', 10.0) * LAMPORTS_PER_SOL),
    reserveLamports: Math.round(envNumber('GFG_SPEND_RESERVE_SOL', 0.3) * LAMPORTS_PER_SOL),
  };
}

export function ledgerPath() {
  return process.env.SPEND_LEDGER_PATH || DEFAULT_LEDGER_PATH;
}

function emptyLedger() {
  return { players: {}, globalSpent: 0, events: [], updatedAt: null };
}

// Migration for pre-analytics ledgers (no `events` log). Each existing player
// row becomes one spend event tagged `category: 'onboarding'` at lastSpentAt,
// so period/forecast analytics still work on old data. The players map stays
// authoritative for caps; events are only for analytics.
function migrateEvents(raw) {
  if (!raw || Array.isArray(raw.events)) return raw && raw.events ? raw.events : [];
  const events = [];
  for (const [pubkey, v] of Object.entries(raw.players || {})) {
    const spent = v.spent || 0;
    if (spent <= 0) continue;
    events.push({
      ts: v.lastSpentAt || raw.updatedAt || new Date().toISOString(),
      player: pubkey,
      lamports: spent,
      category: 'onboarding',
      steps: 1,
    });
  }
  return events.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export function loadLedger(path = ledgerPath()) {
  if (!existsSync(path)) return emptyLedger();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
return {
      players: raw.players || {},
      globalSpent: typeof raw.globalSpent === 'number' ? raw.globalSpent : 0,
      events: migrateEvents(raw),
      updatedAt: raw.updatedAt || null,
    };
  } catch (e) {
    throw new Error(`spend ledger unreadable at ${path}: ${e.message}`);
  }
}

function persistLedger(ledger, path = ledgerPath()) {
  writeFileSync(path, JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2));
}

// Per-player + global totals (the player may have re-delegated in the past).
function usage(ledger, player) {
  return {
    perPlayer: ledger.players[player]?.spent || 0,
    global: ledger.globalSpent || 0,
  };
}

// Throw SpendCapExceeded if running `spendLamports` more would breach a cap. A
// spend must FIRST be authorized (with the same value) before the relay acts.
export function authorizeSpend(player, spendLamports, path = ledgerPath()) {
  const caps = spendCaps();
  const ledger = loadLedger(path);
  const { perPlayer, global } = usage(ledger, player);

  const playerNext = perPlayer + spendLamports;
  if (playerNext > caps.perPlayerLamports) {
    throw new SpendCapExceeded(
      `per-player sponsor cap exceeded for ${player}: would spend ${(playerNext / LAMPORTS_PER_SOL).toFixed(5)} SOL (cap ${(caps.perPlayerLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`,
      'perPlayer', caps.perPlayerLamports, perPlayer
    );
  }
  const globalNext = global + spendLamports;
  if (globalNext > caps.globalLamports) {
    throw new SpendCapExceeded(
      `global sponsor cap exceeded: would spend ${(globalNext / LAMPORTS_PER_SOL).toFixed(5)} SOL total (cap ${(caps.globalLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`,
      'global', caps.globalLamports, global
    );
  }
  return caps;
}

// Reserve check: never let a spend push the sponsor balance below the reserve
// floor (protects the wallet itself even if caps are misconfigured).
export function assertSponsorReserve(balanceLamports, spendLamports, path = ledgerPath()) {
  const caps = spendCaps();
  if (balanceLamports - spendLamports < caps.reserveLamports) {
    throw new SpendCapExceeded(
      `sponsor reserve would be breached: balance ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`,
      'reserve', caps.reserveLamports, balanceLamports
    );
  }
  return caps;
}

// Successful spend lands into the ledger. Idempotent enough for our purposes:
// the relay never spends for a player twice in one happy path, and duplicate
// records are bounded by the per-player cap.
//
// opts (optional):
//   category: string   what the spend was for ('onboarding' | 'house' | ...)
//   steps:    number   how many base-layer tx steps produced this delta
//   extra:    object   optional tags to store on the event (e.g. kind)
//   capExempt:boolean  record analytics + globalSpent but DO NOT bump the
//                      per-player cap map (a maintenance/ops cost like a
//                      region re-pin should never consume a player's
//                      onboarding budget). Default false.
export function recordSpend(player, spendLamports, opts = {}, path = ledgerPath()) {
  if (spendLamports <= 0) return;
  const ledger = loadLedger(path);
  const ts = new Date().toISOString();
  if (!opts.capExempt) {
    const prior = ledger.players[player]?.spent || 0;
    ledger.players[player] = { spent: prior + spendLamports, lastSpentAt: ts };
  }
  ledger.globalSpent = (ledger.globalSpent || 0) + spendLamports;
  ledger.events = ledger.events || [];
  ledger.events.push({
    ts,
    player,
    lamports: spendLamports,
    category: opts.category || 'onboarding',
    steps: opts.steps || 1,
    ...(opts.extra || {}),
  });
  persistLedger(ledger, path);
}

// Gas reserve "battery" reference: the tank is the amount of sponsor SOL we
// treat as a full reserve (default 100). On devnet this is free money; the
// meter exists so ops can see at a glance whether the reserve needs a manual
// top-up from the deployer wallet before it hits the critical floor.
export function gasTank(path = ledgerPath()) {
  const caps = spendCaps();
  return {
    tankLamports: Math.round(envNumber('GFG_GAS_TANK_SOL', 100) * LAMPORTS_PER_SOL),
    reserveLamports: caps.reserveLamports,
  };
}

function buckets(events, start, unit, keyFn, labelFn) {
  const by = new Map();
  const cur = new Date(start);
  for (let i = 0; i < 30; i++) {
    const key = keyFn(cur);
    by.set(key, { key, label: labelFn(cur), lamports: 0 });
    cur.setTime(cur.getTime() + unit);
  }
  for (const ev of events) {
    const d = new Date(ev.ts);
    if (d < new Date(start)) continue;
    const key = keyFn(d);
    const bucket = by.get(key);
    if (bucket) bucket.lamports += ev.lamports;
  }
  return [...by.values()];
}

function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekStart(date) {
  const d = dayStart(date);
  const day = (d.getDay() + 6) % 7; // Monday=0
  d.setDate(d.getDate() - day);
  return d;
}

function monthStart(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const fmtDay = d => d.toISOString().slice(5, 10);
const fmtMonth = d => d.toISOString().slice(0, 7);

// Analytics over the spend event log: period buckets (day/week/month), spend
// categories ("what aspect of the chain costs the most"), top players, and
// forecasts (players funded per SOL, runway at current burn rate). Server-side
// only; the probe folds this into the ops payload for the dashboard.
export function spendAnalytics(path = ledgerPath()) {
  const ledger = loadLedger(path);
  const events = (ledger.events || []).slice().sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const now = new Date();

  const byDay = buckets(events, dayStart(now).getTime() - 13 * 86400000, 86400000, d => fmtDay(d), d => fmtDay(d));
  const byWeek = buckets(events, weekStart(now).getTime() - 7 * 7 * 86400000, 7 * 86400000, d => fmtDay(weekStart(d)), d => fmtDay(weekStart(d)));
  const byMonth = buckets(events, monthStart(now).getTime() - 5 * 31 * 86400000, 31 * 86400000, d => fmtMonth(d), d => fmtMonth(d));

  // Spend by category: which on-chain activity consumes the most sponsor SOL.
  const byCategory = new Map();
  for (const ev of events) {
    byCategory.set(ev.category || 'onboarding', (byCategory.get(ev.category || 'onboarding') || 0) + ev.lamports);
  }

  // Per-player totals (from events, so a player with multiple sessions sums).
  const byPlayer = new Map();
  for (const ev of events) {
    byPlayer.set(ev.player, (byPlayer.get(ev.player) || 0) + ev.lamports);
  }
  const topPlayers = [...byPlayer.entries()]
    .map(([pubkey, lamports]) => ({ pubkey, lamports, sol: +(lamports / LAMPORTS_PER_SOL).toFixed(5) }))
    .sort((a, b) => b.lamports - a.lamports);

  // Forecast inputs. The dominant cost is per-player onboarding (~0.0042 SOL
  // for dice PDA, ~0.0042 for points PDA on devnet). Rolls are gasless on the
  // ER, so "more games" costs ~nothing; "more players" costs onboarding.
  const totalLamports = ledger.globalSpent || 0;
  const onboardingLamports = [...byCategory.entries()]
    .filter(([cat]) => cat !== 'house')
    .reduce((s, [, v]) => s + v, 0);
  const avgOnboardingLamports = topPlayers.length ? Math.round(onboardingLamports / topPlayers.length) : 0;

  // Burn rate = spend over the last 7 days (avg/day), so cold devnet periods
  // don't make the runway look infinite/zero.
  const weekAgo = now.getTime() - 7 * 86400000;
  const last7 = events.filter(ev => new Date(ev.ts).getTime() >= weekAgo).reduce((s, ev) => s + ev.lamports, 0);
  const burnPerDay = Math.round(last7 / 7);

  const playersPerSol = avgOnboardingLamports > 0 ? Math.floor(LAMPORTS_PER_SOL / avgOnboardingLamports) : 0;
  const tank = gasTank(path);

  return {
    periods: { day: byDay, week: byWeek, month: byMonth },
    categories: [...byCategory.entries()]
      .map(([category, lamports]) => ({ category, lamports, sol: +(lamports / LAMPORTS_PER_SOL).toFixed(5) }))
      .sort((a, b) => b.lamports - a.lamports),
    topPlayers,
    avgOnboardingLamports,
    avgOnboardingSol: +(avgOnboardingLamports / LAMPORTS_PER_SOL).toFixed(5),
    playersPerSol,
    burnPerDayLamports: burnPerDay,
    burnPerDaySol: +(burnPerDay / LAMPORTS_PER_SOL).toFixed(5),
    totalLamports,
    totalSol: +(totalLamports / LAMPORTS_PER_SOL).toFixed(5),
    tank,
  };
}

// Forecast helper: given a hypothetical reserve amount, how far does it go?
// - playersFunded: fresh players the SOL can onboard at the observed avg cost.
// - runwayMonths: how long the reserve lasts at the observed burn rate.
export function gasForecast(spendLamports, path = ledgerPath()) {
  const a = spendAnalytics(path);
  const playersFunded = a.avgOnboardingLamports > 0 ? Math.floor(spendLamports / a.avgOnboardingLamports) : 0;
  let runwayMonths = null;
  if (a.burnPerDayLamports > 0) {
    const days = spendLamports / a.burnPerDayLamports;
    runwayMonths = Math.round(days / 30.44 * 10) / 10;
  }
  return { playersFunded, runwayMonths, avgOnboardingSol: a.avgOnboardingSol, burnPerDaySol: a.burnPerDaySol };
}

export function spendTotals(path = ledgerPath()) {
  const ledger = loadLedger(path);
  return {
    players: Object.keys(ledger.players).length,
    globalSpentLamports: ledger.globalSpent,
    globalSpentSol: +(ledger.globalSpent / LAMPORTS_PER_SOL).toFixed(5),
  };
}