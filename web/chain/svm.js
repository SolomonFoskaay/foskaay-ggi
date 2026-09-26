// src/chain/svm.js — the Solana rail (what we already run today).
//
// Thin wrapper over the existing client so the adapter interface is uniform.
// It adds nothing new and changes no behavior; the live code keeps calling
// window.magicblockDice directly until Phase 1 decides otherwise.
export const svmAdapter = {
  name: 'solana',
  isReady() {
    return typeof window !== 'undefined' && !!(window.magicblockDice && window.magicblockDice.isConfigured && window.magicblockDice.isConfigured());
  },
  walletAddress() {
    try { return (window.getDynamicSolanaWallet && window.getDynamicSolanaWallet()) || null; } catch (e) { return null; }
  },
  fetchLedger(gameTag = 'ludo') {
    try { return window.magicblockDice.fetchPointsPda(gameTag); } catch (e) { return null; }
  },
  recordPoints(gameTag, points, reason, matchRef) {
    try { return window.magicblockDice.recordPoints(gameTag, points, reason, matchRef); } catch (e) { return null; }
  },
};
