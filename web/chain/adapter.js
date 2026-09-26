// src/chain/adapter.js — arcv2m16 (EVM rail) Phase 0. INERT by design.
//
// ONE interface, TWO rails. Nothing imports this yet: Phase 1 wires it into the
// pages. The default is 'svm' (Solana), so the live flow can never be affected
// by accident. Switch with the build-time env var VITE_GFG_CHAIN=svm|evm.
//
// Contract every rail implementation must satisfy:
//   walletAddress()            -> string | null   (the player's address)
//   fetchLedger(gameTag)       -> { pureLifetime, spendableBalance, ... } | null
//   recordPoints(gameTag, ...) -> receipt | null   (soft-fail, never blocks UX)
//   rollDice(gameTag?, ...)    -> { roll1, roll2, ... } | null
//   isReady()                  -> boolean
export const CHAIN = (import.meta && import.meta.env && import.meta.env.VITE_GFG_CHAIN) || 'svm';

export function chainName() {
  return CHAIN === 'evm' ? 'arc' : 'solana';
}

export async function loadAdapter() {
  if (CHAIN === 'evm') return (await import('./arc.js')).arcAdapter;
  return (await import('./svm.js')).svmAdapter;
}
