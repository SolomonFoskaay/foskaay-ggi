// src/gfg-pay.js — AUTOMATED USDC PAYMENT + BALANCE PRE-CHECK (browser).
//
// HOW IT WORKS (plain words):
//   The player pays USDC from their own embedded wallet to the platform's
//   USDC address. This is a REAL payment on the base Solana network - it is
//   NOT the gasless MagicBlock ER (the rail free game moves use). That is
//   deliberate: a payment must be provable on the base chain so the server
//   can independently verify it before crediting points. The player signs it
//   with their Dynamic session key (may prompt an email) and pays a tiny
//   network fee from their SOL - fractions of a cent.
//
//   The cluster (mainnet by default, devnet for admin tests) comes from
//   /api/pay-config, so the running site matches the server without a rebuild.
//
//   The app PRE-CHECKS the wallet balance before enabling the Pay button: it
//   needs enough SOL (fee) AND enough USDC (plan). If either is missing the
//   button stays off and says why.
//
//   After the transfer the signature goes to /api/verify-and-credit, which
//   re-reads the tx, checks sender = this wallet, destination = treasury,
//   USDC mint, amount, freshness - and ONLY then credits premium points
//   (sponsor-signed, gasless on the ER). Effort fails, credits never fire.
//
// Exposes window.gfgPay = { pay, verify, payAndVerify, plans, connectedWallet,
//                           balances, enoughFor, lastTx, saveTx, network }.

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getWalletAccounts } from '@dynamic-labs-sdk/client';
import { signTransaction } from '@dynamic-labs-sdk/solana';

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOL_FEE_LAMPORTS = 10000; // ~0.00001 SOL reserve for the transfer fee

// Client-side plan mapper (mirrors /api/pay-config plans). The SERVER is the
// authority on points; this only builds the transfer amount and shows prices.
const PAY_PLANS = {
  l1: { points: 5000,  usdCents: 500,  kind: 'plan',    label: 'Level 1' },
  l2: { points: 10000, usdCents: 1000, kind: 'plan',    label: 'Level 2' },
  l3: { points: 15000, usdCents: 1500, kind: 'plan',    label: 'Level 3' },
  b24: { points: 500,   usdCents: 100,  kind: 'booster', label: '24h Unlimited Lives' },
  b72: { points: 1500,  usdCents: 200,  kind: 'booster', label: '72h Unlimited Lives' },
};

let CFG = null;
const FALLBACK_CFG = {
  network: 'devnet',
  rpc: 'https://api.devnet.solana.com',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  usdcDecimals: 6,
  treasury: 'Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3',
};

const DEVNET_CFG = {
  network: 'devnet',
  rpc: 'https://api.devnet.solana.com',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  usdcDecimals: 6,
  treasury: 'Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3',
};

// Force devnet (admin test pages / ?net=devnet). Pass a boolean or 'devnet'.
function forceDevnet() {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get('net') === 'devnet';
  } catch (e) { return false; }
}

// Fetch the runtime payment config once (mainnet by default). Never throws:
// falls back to devnet so the module is always usable.
export async function payConfig() {
  if (CFG) return CFG;
  if (forceDevnet()) { CFG = Object.assign({}, DEVNET_CFG, { _forcedDevnet: true }); return CFG; }
  CFG = Object.assign({}, FALLBACK_CFG);
  try {
    const r = await fetch('/api/pay-config', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.rpc) CFG = Object.assign({}, FALLBACK_CFG, j);
    }
  } catch (e) { /* fallback */ }
  return CFG;
}

let connCache = null;
function payConnection(cfg) {
  if (!connCache) connCache = new Connection(cfg.rpc, 'confirmed');
  return connCache;
}

function walletAccount() {
  try {
    const client = window.dynamicClient;
    if (!client) return null;
    const accounts = getWalletAccounts(client);
    const sol = accounts.find((w) => w.chain === 'SOL' && w.address);
    return sol ? { walletAccount: sol, publicKey: new PublicKey(sol.address) } : null;
  } catch (e) {
    console.warn('[gfg-pay] could not read wallet account', e);
    return null;
  }
}

export function connectedWallet() {
  const w = walletAccount();
  return w ? w.publicKey.toBase58() : null;
}

function usdcAta(ownerKey, cfg) {
  const mint = new PublicKey(cfg.usdcMint);
  return PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID.toBase58()).toBuffer(), mint.toBuffer()],
    new PublicKey(ATA_PROGRAM)
  )[0];
}

// Read SOL + USDC balances of the embedded wallet. Pure reads, no signing.
export async function balances() {
  const cfg = await payConfig();
  const wallet = walletAccount();
  if (!wallet) return { sol: null, usdc: null, ata: null };
  const conn = payConnection(cfg);
  let sol = null, usdc = null, ataAddr = null;
  try {
    const bal = await conn.getBalance(wallet.publicKey, 'confirmed');
    sol = bal; // lamports
  } catch (e) { sol = null; }
  const ata = usdcAta(wallet.publicKey, cfg);
  ataAddr = ata.toBase58();
  try {
    const acct = await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID);
    usdc = Number(acct.amount);
  } catch (e) { usdc = 0; } // no USDC ATA yet => 0
  return { sol, usdc, ata: ataAddr, solLamports: sol };
}

// Does the wallet have enough for a given plan? Returns { ok, missing }.
export async function enoughFor(planKey) {
  const plan = PAY_PLANS[planKey];
  if (!plan) return { ok: false, missing: [], reason: 'unknown plan' };
  const b = await balances();
  const issues = [];
  if (b.sol != null && b.sol < SOL_FEE_LAMPORTS) issues.push('sol');
  const needUsdc = Math.round(plan.usdCents * 10000);
  if (b.usdc != null && b.usdc < needUsdc) issues.push('usdc');
  return {
    ok: issues.length === 0,
    missing: issues,
    sol: b.sol, usdc: b.usdc,
    needUsdc, feeLamports: SOL_FEE_LAMPORTS,
    planLabel: plan.label,
  };
}

async function signWithDynamic(tx) {
  const w = walletAccount();
  if (!w) throw new Error('no embedded wallet connected');
  const { signedTransaction } = await signTransaction({ transaction: tx, walletAccount: w.walletAccount });
  return signedTransaction;
}

export async function pay(planKey) {
  const plan = PAY_PLANS[planKey];
  if (!plan) throw new Error('unknown plan "' + planKey + '"');
  const cfg = await payConfig();
  const wallet = walletAccount();
  if (!wallet) throw new Error('no embedded wallet connected - sign in first');
  const conn = payConnection(cfg);

  const ata = usdcAta(wallet.publicKey, cfg);
  const treasuryAta = usdcAta(new PublicKey(cfg.treasury), cfg);

  let ataExists = false;
  try { await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID); ataExists = true; } catch (e) { ataExists = false; }

  let treasuryExists = false;
  try { await getAccount(conn, treasuryAta, 'confirmed', TOKEN_PROGRAM_ID); treasuryExists = true; } catch (e) { treasuryExists = false; }
  if (!treasuryExists) {
    throw new Error('the platform payment wallet is still being prepared. Try again in a minute, or use the manual form so support can credit you.');
  }

  const amountBase = BigInt(Math.round(plan.usdCents * 10000));
  const tx = new Transaction();

  if (!ataExists) {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, // payer
      ata,              // associated token account
      wallet.publicKey, // owner
      new PublicKey(cfg.usdcMint),
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }
  tx.add(
    createTransferCheckedInstruction(
      ata, new PublicKey(cfg.usdcMint), treasuryAta, wallet.publicKey,
      amountBase, cfg.usdcDecimals || 6
    )
  );
  tx.feePayer = wallet.publicKey;
  const bh = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = bh.blockhash;

  const signed = await signWithDynamic(tx);
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  let failedOnChain = false;
  try {
    const conf = await conn.confirmTransaction(signature, 'confirmed');
    if (conf && conf.value && conf.value.err) failedOnChain = true;
  } catch (e) {
    failedOnChain = true;
  }
  saveTx({ plan: planKey, signature, at: Date.now(), points: plan.points, kind: plan.kind, failed: failedOnChain });
  if (failedOnChain) {
    throw new Error('the transfer was sent but failed on-chain. Your signature: ' + signature + '. Use the manual form (or Verify payment + credit) with this signature so support can help.');
  }
  return { signature, amountBase: amountBase.toString(), plan: planKey, points: plan.points };
}

export async function verify(planKey, txSignature) {
  const wallet = connectedWallet();
  let token;
  try { token = new URLSearchParams(window.location.search).get('token') || undefined; } catch (e) { token = undefined; }
  const res = await fetch('/api/verify-and-credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: wallet, plan: planKey, txSignature, token }),
  });
  const data = await res.json().catch(() => ({ error: 'bad response' }));
  if (!res.ok || !data.ok) throw new Error(data.error || 'verification failed');
  return data;
}

export async function payAndVerify(planKey) {
  const { signature } = await pay(planKey);
  return verify(planKey, signature);
}

export function plans() {
  return Object.keys(PAY_PLANS).map((k) => ({ key: k, ...PAY_PLANS[k] }));
}

// Keep the last ~10 payment signatures locally so a user can find their tx.
const LAST_TX_KEY = 'gfg_pay_last_tx_v1';
export function saveTx(entry) {
  try {
    const key = connectedWallet() || 'anon';
    const store = JSON.parse(localStorage.getItem(LAST_TX_KEY) || '{}') || {};
    const arr = Array.isArray(store[key]) ? store[key] : [];
    arr.unshift(entry);
    store[key] = arr.slice(0, 10);
    localStorage.setItem(LAST_TX_KEY, JSON.stringify(store));
  } catch (e) { /* ignore */ }
}
export function lastTx() {
  try {
    const key = connectedWallet() || 'anon';
    const store = JSON.parse(localStorage.getItem(LAST_TX_KEY) || '{}') || {};
    return Array.isArray(store[key]) ? store[key] : [];
  } catch (e) { return []; }
}

export async function network() {
  const c = await payConfig();
  return c.network + (c._forcedDevnet ? '-forced' : '');
}

export function initGfgPay() {
  window.gfgPay = {
    pay, verify, payAndVerify, plans, connectedWallet,
    balances, enoughFor, lastTx, saveTx, network, payConfig,
  };
}