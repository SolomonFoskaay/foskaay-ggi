// public/universal/points/points-store.js
// M3+M4 — THE CENTRAL POINTS STORE (universal, loaded on every page).
//
// Single source of truth for WHEN the RPC is consulted for the M3 (local,
// per-game) and M4 (global) point ledgers. All DISPLAY surfaces (the global
// header pill, ludo/ludo-lab ceremonies, profile/points, dashboards) read
// through window.localPoints.get() / window.globalLedger.get(), which are pure
// localStorage reads and NEVER hit the RPC themselves. That means the only
// place on-chain reads can originate is this store's refresh window — a fresh
// sign-in — plus the module-internal refresh after a win/spend. A plain page
// load NEVER consults the RPC.
//
// Policy (owner contract, 2026-08-19):
//   1. PAGE LOAD       -> show the last-known localStorage snapshot, no RPC.
//   2. FRESH AUTH      -> RESET the stored points, then fetch fresh from the
//                         RPC, save, and instantly render. This is what makes
//                         a login always show current numbers (a stale cached
//                         ledger used to survive repeated logins until a win).
//   3. GAME WIN        -> handled inside the modules (bank/credit -> refresh);
//                         the written ledger replaces the cache in the same
//                         step. No extra store work needed.
//   4. SIGN-OUT        -> clear the wallet's slice so the next visitor on a
//                         shared browser never sees the previous user's points.
//
// The store rides the global header (header.js ensures this file on every
// page right after the two point modules) but binds ONLY to gfg:auth-changed,
// so opening the header on any number of pages costs zero RPC. The address for
// the on-chain read comes from the LIVE session (Dynamic wallet, else profile)
// exactly like the modules — never from a persisted "last wallet" hint.
(function () {
  'use strict';

  if (window.pointsStore) return; // idempotent (header may ensure it repeatedly)

  // Exact (case-sensitive) wallet address for the on-chain read, or null.
  function readAddress() {
    var addr = null;
    try {
      if (window.getDynamicSolanaWallet) {
        var w = window.getDynamicSolanaWallet();
        if (w && typeof w === 'string') addr = w;
        else if (w && w.address) addr = String(w.address);
      }
    } catch (e) { /* ignore */ }
    if (!addr) {
      try {
        if (window.currentProfile && window.currentProfile.solana_wallet) addr = String(window.currentProfile.solana_wallet);
      } catch (e) { /* ignore */ }
    }
    return addr;
  }

  function hasRealWallet() {
    return readAddress() !== null;
  }

  // Clear both cached slices and re-render ("loading" until the fresh fetch
  // lands). Pure local operation — no RPC.
  function resetCached() {
    try {
      if (window.localPoints && typeof window.localPoints.reset === 'function') window.localPoints.reset();
    } catch (e) { /* ignore */ }
    try {
      if (window.globalLedger && typeof window.globalLedger.reset === 'function') window.globalLedger.reset();
    } catch (e) { /* ignore */ }
    try {
      if (window.premiumPoints && typeof window.premiumPoints.reset === 'function') window.premiumPoints.reset();
    } catch (e) { /* ignore */ }
  }

  function fetchOnce(sdk) {
    var lp = window.localPoints;
    var gl = window.globalLedger;
    var pp = window.premiumPoints;
    if (lp && typeof lp.fetch === 'function') {
      try { lp.fetch(); } catch (e) { /* ignore */ }
    }
    if (gl && typeof gl.fetch === 'function') {
      try { gl.fetch(); } catch (e) { /* ignore */ }
    }
    if (pp && typeof pp.fetch === 'function') {
      try { pp.fetch(); } catch (e) { /* ignore */ }
    }
  }

  // Bounded wait for the Dynamic/VRF module to be configured, then refresh.
  // Only ever called from the auth-changed branch (a fresh sign-in) — never
  // from a page load.
  function refreshAfterAuth() {
    if (!hasRealWallet()) { resetCached(); return; }
    resetCached();
    var deadline = Date.now() + 15000;
    (function wait() {
      var sdk = window.magicblockDice;
      if (sdk && typeof sdk.isConfigured === 'function' && sdk.isConfigured()) {
        fetchOnce(sdk);
        return;
      }
      if (Date.now() < deadline) setTimeout(wait, 700);
      else fetchOnce(sdk); // last attempt anyway; failure just leaves "loading"
    })();
  }

  // ---- seam subscription (the one plug) -------------------------------
  // Auth always runs through here. bindAuth is called from the DOMContentLoaded
  // boot below so a gfg:auth-changed fired before this script ran is not lost.
  var bound = false;
  function bindAuth() {
    if (bound || typeof window.addEventListener !== 'function') return;
    bound = true;
    window.addEventListener('gfg:auth-changed', refreshAfterAuth);
  }

  window.pointsStore = {
    // Pure cache reads — thin delegation to the modules (single source of
    // truth). NULL means "no snapshot for this wallet yet".
    getLocal: function (gameTag) {
      return window.localPoints && typeof window.localPoints.get === 'function'
        ? window.localPoints.get(gameTag) : null;
    },
    getGlobal: function () {
      return window.globalLedger && typeof window.globalLedger.get === 'function'
        ? window.globalLedger.get() : null;
    },
    // Public reset + refetch entry point (e.g. debugging / a manual refresh).
    // Also the ONLY caller of the fetch path besides the module win path.
    refresh: refreshAfterAuth,
    hasWallet: hasRealWallet,
  };

  function boot() {
    bindAuth();
    // A wallet already live when this script loads (silent restore) still waits
    // for the SDK; the fetch is the "fresh auth" case and a page-load boot here
    // does NOT qualify, so we only bind here, never auto-fetch.
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();