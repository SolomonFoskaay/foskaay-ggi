// scripts/handle.mjs — server-side identity handle derivation + registry helpers.
// Mirrors public/universal/identity/handle.js so client and server agree.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import bs58 from 'bs58';
import './load-env.mjs';

export const HANDLE_SEED = Buffer.from('gfghandle');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function deriveProfileHandle(dynamicId, salt) {
  if (!dynamicId) return null;
  salt = salt || '';
  const s = 'gfd:' + String(dynamicId) + (salt ? ':' + salt : '');
  let h1 = fnv1a(s, 0x811c9dc5);
  let h2 = fnv1a(s, 0x01000193);
  let out = '';
  for (let i = 0; i < 6; i++) {
    h1 = Math.imul(h1, 2654435761) >>> 0;
    h1 = (h1 ^ h2) >>> 0;
    h2 = Math.imul(h2, 1597334677) >>> 0;
    out += B32[h1 % 32];
  }
  return 'GFG-' + out;
}

export function isValidProfileHandle(h) {
  return /^GFG-[0-9A-Z]{6}$/i.test(h || '');
}

export function handleAccountPda(handle) {
  return PublicKey.findProgramAddressSync([HANDLE_SEED, Buffer.from(handle, 'utf8')], new PublicKey(requireProgramId()))[0];
}
function requireProgramId() {
  const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
  return idl.address || idl.metadata?.address;
}
const PROGRAM = new PublicKey(requireProgramId());
const BASE = baseRpcUrl();

function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t)=>{ t.partialSign(kp); return t; }, signAllTransactions: async (ts)=>{ ts.forEach(t=>t.partialSign(kp)); return ts; } };
}

// Register a handle for a wallet on-chain (relay/sponsor pays rent, owner = wallet).
export async function registerProfileHandle(wallet, handle) {
  if (!isValidProfileHandle(handle)) throw new Error('invalid handle: expected GFG-XXXXXX');
  const w = new PublicKey(wallet);
  const pda = handleAccountPda(handle);
  const sponsor = loadSponsor();
  const conn = createConnection(BASE, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
  const program = new Program(idl, provider);
  const tx = await program.methods.registerProfileHandle(handle)
    .accounts({ payer: sponsor.publicKey, playerAuthority: w, handleAccount: pda, systemProgram: SystemProgram.programId })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log(`[handle] registered ${handle} -> ${w.toBase58()} sig=${String(sig).slice(0, 24)}`);
  return { handle, wallet: w.toBase58(), sig, account: pda.toBase58() };
}

// wallet -> handle map (durable local ledger, gitignored; Supabase registered
// profiles used when available). Needed because the handle is the PDA seed and
// cannot be reverse-derived from the wallet on-chain.
import { writeFileSync, existsSync } from 'fs';
const HANDLES_FILE = new URL('./gfg-handles.json', import.meta.url).pathname;
export function persistHandle(wallet, handle) {
  if (!wallet || !handle) return;
  try {
    const map = existsSync(HANDLES_FILE) ? JSON.parse(readFileSync(HANDLES_FILE, 'utf8')) : {};
    map[wallet] = handle;
    writeFileSync(HANDLES_FILE, JSON.stringify(map, null, 2));
  } catch (e) { /* fail-open */ }
  try { void persistHandleSupabase(wallet, handle); } catch (e) { /* fail-open */ }
}
export function getHandleForWallet(wallet) {
  try {
    if (existsSync(HANDLES_FILE)) {
      const map = JSON.parse(readFileSync(HANDLES_FILE, 'utf8'));
      if (map[wallet]) return map[wallet];
    }
  } catch (e) { /* ignore */ }
  return null;
}
async function persistHandleSupabase(wallet, handle) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  // update the profiles row for this wallet's embedded Dynamic profile
  await fetch(url + '/rest/v1/profiles?solana_wallet=eq.' + encodeURIComponent(wallet), {
    method: 'PATCH', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ handle }),
  }).catch(() => {});
}

const REGIONS = ['https://devnet-as.magicblock.app/', 'https://devnet-eu.magicblock.app/', 'https://api.devnet.solana.com'];
// Resolve a handle to its owner wallet by reading the on-chain registry.
export async function resolveHandleToWallet(handle) {
  if (!isValidProfileHandle(handle)) return null;
  const [pda] = PublicKey.findProgramAddressSync([HANDLE_SEED, Buffer.from(handle, 'utf8')], PROGRAM);
  for (const url of REGIONS) {
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const v = j && j.result && j.result.value;
      if (!v || !v.data) continue;
      const d = Buffer.from(v.data[0], 'base64');
      // 8-byte disc, owner @8..40, created_ts @40..48
      if (d.length < 48) continue;
      const owner = bs58.encode(d.subarray(8, 40));
      if (owner && owner !== bs58.encode(new Uint8Array(32))) return owner;
    } catch (e) { /* next region */ }
  }
  return null;
}