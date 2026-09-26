// scripts/competitions-wins.mjs — COMPETITION WIN/ENTRY LEDGER (server-side,
// file-based - NOT Supabase; per-rule R13 the competition lifecycle stays
// on-chain for winners + paid status and this ledger only reconstructs the
// window-fresh tally the admin settles from). Proof signatures are on-chain
// roll sigs, so every row is verifiable via the receipt explorer.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { PublicKey } from '@solana/web3.js';
import { baseRpcUrl, createConnection } from '../src/gfg-rpc.js';

const WINS_FILE = new URL('./gfg-comp-wins.json', import.meta.url).pathname;
const ENTRIES_FILE = new URL('./gfg-comp-entries.json', import.meta.url).pathname;

function readJson(file, fallback) {
  try { if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { /* ignore */ }
  return fallback;
}
function writeJson(file, data) {
  try { writeFileSync(file, JSON.stringify(data)); } catch (e) { /* fail-open */ }
}

// ---- entries (one per wallet per competition) ------------------------------
export function addEntry({ compCreator, seq, wallet }) {
  const key = compCreator + ':' + seq;
  const list = readJson(ENTRIES_FILE, []);
  if (!list.some(e => e.comp === key && e.wallet === wallet)) {
    list.push({ comp: key, wallet, at: Date.now() });
    writeJson(ENTRIES_FILE, list);
    return true;
  }
  return false;
}
export function hasEntry({ compCreator, seq, wallet }) {
  const key = compCreator + ':' + seq;
  return readJson(ENTRIES_FILE, []).some(e => e.comp === key && e.wallet === wallet);
}
export function listEntries({ compCreator, seq }) {
  const key = compCreator + ':' + seq;
  return readJson(ENTRIES_FILE, []).filter(e => e.comp === key).map(e => e.wallet);
}

// ---- in-window wins ---------------------------------------------------------
const MAX_WINS = 50000;
export function addWin({ compCreator, seq, wallet, ts, proofSig, game }) {
  const key = compCreator + ':' + seq;
  const list = readJson(WINS_FILE, []);
  if (list.length >= MAX_WINS) throw new Error('win ledger full');
  if (list.some(w => w.comp === key && w.wallet === wallet && w.proofSig === proofSig)) return false; // dedupe
  list.push({ comp: key, wallet, ts: Number(ts), proofSig, game, at: Date.now() });
  writeJson(WINS_FILE, list);
  return true;
}
export function tallyFor({ compCreator, seq, wallet }) {
  const key = compCreator + ':' + seq;
  return readJson(WINS_FILE, []).filter(w => w.comp === key && w.wallet === wallet);
}

// ---- live tier read (has to survive regions like the affiliate reader) ------
const TIER_REGIONS = [baseRpcUrl(), 'https://api.devnet.solana.com', 'https://devnet-as.magicblock.app/', 'https://devnet-eu.magicblock.app/'];
const tierConn = createConnection(baseRpcUrl(), 'confirmed');
let tierCache = new Map();
export function clearTierCache() { tierCache.clear(); }
export async function readTierFor(wallet) {
  const cached = tierCache.get(wallet);
  if (cached && Date.now() - cached.at < 8000) return cached.level;
  let level = 0, until = 0, found = false;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('gfgprem'), new PublicKey(wallet).toBytes()], new PublicKey('CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ'));

  // 1) Preferred: the same Connection that reads PDAs reliably throughout the codebase.
  try {
    const info = await tierConn.getAccountInfo(pda);
    if (info && info.data && info.data.length >= 66) {
      level = info.data[57]; until = Number(info.data.readBigInt64LE(58)); found = true;
    }
  } catch (e) { /* fall through */ }

  // 2) Fallback: raw RPC pass over the region registry (aliases other readers).
  if (!found) {
    for (const url of TIER_REGIONS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] }) });
        const j = await r.json();
        const v = j && j.result && j.result.value;
        if (!v || !v.data) continue;
        const d = Buffer.from(v.data[0], 'base64');
        if (d.length >= 66) { level = d[57]; until = Number(d.readBigInt64LE(58)); found = true; }
        break;
      } catch (e) { /* next */ }
    }
  }
  // A transient miss must NOT cache a fake '0' for 30s.
  if (!found) { tierCache.delete(wallet); return 0; }
  tierCache.set(wallet, { level, at: Date.now() });
  return (level > 0 && until * 1000 > Date.now()) ? level : 0;
}

// Final Points: Total Wins x live plan boost from the config ladder
// (L2 1.25x, L3 1.5x, L1 1.0x); a level not in tierBits => hidden (excluded
// from ranking, not removed).
export function boostFor(level, comp, planBoosts) {
  if (level <= 0) return null;
  if (!(comp.tierBits & (1 << level))) return null;
  if (planBoosts && planBoosts[level]) return planBoosts[level];
  return level >= 3 ? 1.5 : (level === 2 ? 1.25 : 1.0);
}