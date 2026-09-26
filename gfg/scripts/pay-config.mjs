// scripts/pay-config.mjs — PAYMENT + MINT NETWORK config (single switch point).
//
// One env decides the cluster for ALL value flows (premium-point auto-pay,
// NFT mint guidance):
//   GFG_PAY_NETWORK = 'mainnet' (default for launch) | 'devnet' (preserved for
//                    the admin 'Payment auto Tests' submenu).
//
// The config is served to the client via /api/pay-config (a tiny endpoint) and
// read server-side by verify-and-credit, so the running site can move between
// mainnet and devnet without a rebuild - and the devnet copy stays usable under
// the admin tests while the user-facing pages run mainnet.
//
// NOTE (owner-verified): the Early Backer collection (Hj6EU...) is a creator
// wallet + LaunchMyNFT-hosted config; on-site mint is NOT possible without
// LaunchMyNFT's authority. The mint therefore stays on their page (connected
// wallet receives it). This config governs the premium-point USDC payment flow.

import { createRequire } from 'module';

function envOr(keys) {
  for (const k of keys) {
    try { if (process.env[k]) return process.env[k]; } catch (e) {}
  }
  return null;
}

export const PAY_NETWORK = (envOr(['GFG_PAY_NETWORK']) || 'mainnet').toLowerCase();

// --- mainnet (launch) -------------------------------------------------------
// Real Solana USDC; funds land in the NFT/creator wallet.
const MAINNET = {
  rpc: ['https://api.mainnet-beta.solana.com'],
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // real USDC
  treasury: 'Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3', // NFT wallet (all funds here)
  acceptedDest: ['Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3'],
};

// --- devnet (preserved for admin tests) -------------------------------------
const DEVNET = {
  rpc: ['https://api.devnet.solana.com', 'https://solana-devnet.api.onfinality.io/public'],
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Circle faucet USDC
  treasury: 'Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3',
  acceptedDest: ['Hj6EUEF2mNqe1cRTYQLzURaarD5RXF6WoKMWPne1YzH3'],
};

const NET = PAY_NETWORK === 'devnet' ? DEVNET : MAINNET;

export const PAY_TREASURY_PUBKEY = NET.treasury;
export const PAY_ACCEPTED_DESTINATIONS = NET.acceptedDest;
export const USDC_MINT = NET.usdcMint;
export const USDC_DECIMALS = 6;

// Points credited per paid plan/booster (mirrors the on-chain ladder at
// 500 pts = $1, based on the ACTUAL price, never the discount).
// DIRECT ACTIVATION (M5 spec): the paid plan/booster is written to the Player
// Core in ONE admin instruction right after the payment is verified, so the
// purchase flow no longer relies on premium points. `points` is kept for the
// optional promo/admin credit path and for the legacy cards; `level`/`days`
// and `hours` are the direct-activation targets.
export const PAY_PLANS = {
  l1: { points: 5000,  usdCents: 500,  kind: 'plan',  reason: 1, level: 1, days: 30 }, // Level 1, 30 days
  l2: { points: 10000, usdCents: 1000, kind: 'plan',  reason: 1, level: 2, days: 30 }, // Level 2, 30 days
  l3: { points: 15000, usdCents: 1500, kind: 'plan',  reason: 1, level: 3, days: 30 }, // Level 3, 30 days
  b24: { points: 500,   usdCents: 100, kind: 'booster', reason: 4, hours: 24 }, // 24h unlimited lives
  b72: { points: 1500,  usdCents: 200, kind: 'booster', reason: 4, hours: 72 }, // 72h unlimited lives
};

export function payPlan(key) {
  return PAY_PLANS[key] || null;
}

// RPC endpoints the VERIFIER uses to read the payment transaction on the pay
// cluster. IMPORTANT: must be a REAL base RPC (the MagicBlock devnet router
// cannot serve getTransaction). Server env GFG_DEVNET_RPC (Alchemy) is used
// when present and the cluster is devnet; mainnet uses public mainnet RPC.
export function payRpcEndpoints() {
  if (PAY_NETWORK === 'devnet') {
    const out = [];
    try {
      if (typeof process !== 'undefined' && process.env?.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
    } catch (e) { /* not a node env */ }
    out.push(...DEVNET.rpc);
    return out;
  }
  return [...MAINNET.rpc];
}

// USDC base units for a price in USD cents ($1 = 1_000_000 base).
export function usdcBaseForCents(usdCents) {
  return Math.round(usdCents * 10000);
}

// Public-safe client config (served by /api/pay-config). No secrets.
export function publicPayConfig() {
  return {
    network: PAY_NETWORK,
    rpc: NET.rpc[0],
    usdcMint: NET.usdcMint,
    usdcDecimals: USDC_DECIMALS,
    treasury: NET.treasury,
    plans: PAY_PLANS,
  };
}