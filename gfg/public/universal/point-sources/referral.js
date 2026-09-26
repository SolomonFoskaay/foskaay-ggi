// public/universal/point-sources/referral.js
// M6 — REFERRAL + AFFILIATE CLIENT (universal, game-agnostic).
//
// Public identity is a HANDLE (GFG-XXXXXX) derived deterministically from Dynamic's
// stable user id (see public/universal/identity/handle.js) — never an email or a
// wallet. Shareable link: /?ref=<handle>. When a friend subscribes, the referrer
// earns 15% of that subscription (USD cents) for up to 12 months, recorded on-chain.
//
// Exposes:
//   window.gfgReferral = {
//     handle()                 -> GFG-XXXXXX (from Dynamic id, stable) or null
//     shareLink()              -> https://<origin>/?ref=<handle>
//     claimSignupBonus()       -> POST /api/signup {wallet, handle, refHandle}
//     getLedger()              -> Promise<{lifetimeUsdCents,...} or null
//   }
(function () {
  if (window.gfgReferral) return;

  function wallet() {
    try {
      var w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
      if (!w && window.currentProfile && window.currentProfile.solana_wallet) w = window.currentProfile.solana_wallet;
      if (!w) return null;
      return (typeof w === 'string') ? w : (w.address || String(w));
    } catch (e) { return null; }
  }

  var cachedHandle = null;
  function dynamicId() {
    try {
      var u = window.getDynamicUser ? window.getDynamicUser() : null;
      if (u) {
        var id = u.id || u.userId || u.dynamicId || (u.user && (u.user.id || u.user.userId)) || null;
        if (id) return id;
      }
    } catch (e) {}
    try { if (window.currentProfile && window.currentProfile.dynamic_id) return window.currentProfile.dynamic_id; } catch (e) {}
    return null;
  }
  function handle() {
    if (cachedHandle) return cachedHandle;
    // 1) fall back to a per-wallet cached handle once we know it (from the server or a derive)
    var w = wallet();
    if (w) { try { var saved = localStorage.getItem('gfg_handle_' + w); if (saved && window.isValidProfileHandle && window.isValidProfileHandle(saved)) { cachedHandle = saved; return saved; } } catch (e) {} }
    // 2) derive from Dynamic's stable user id, never email/wallet
    var id = dynamicId();
    var h = (window.deriveProfileHandle && id) ? window.deriveProfileHandle(id) : null;
    cachedHandle = h;
    if (h && w) { try { localStorage.setItem('gfg_handle_' + w, h); } catch (e) {} }
    return h;
  }

  // Remember an invite handle from the URL (?ref=GFG-...) for the claim flow.
  var pendingRef = null;
  function pendingRefHandle() {
    if (pendingRef != null) return pendingRef;
    try {
      var q = new URLSearchParams(location.search).get('ref');
      if (q && window.isValidProfileHandle && window.isValidProfileHandle(q)) pendingRef = q.toUpperCase();
    } catch (e) {}
    if (!pendingRef) { try { pendingRef = localStorage.getItem('gfg_pending_ref') || null; } catch (e) {} }
    return pendingRef;
  }

  var cachedLedger = null, ledgerAt = 0;

  // ---- lifetime signup-bonus claim flag (ONE per wallet, ever) -------------
  // Persisted per-wallet in localStorage and mirrored by the server map
  // (gfg-signups.json -> /api/affiliate signupClaimed). The on-chain duplicate
  // guard is the real fence; this just makes the button honest everywhere.
  var CLAIM_KEY = 'gfg_signup_claimed_v1';
  function claimedWallet() { var w = wallet(); return w ? w.toLowerCase() : null; }
  function markClaimed() {
    var wk = claimedWallet(); if (!wk) return;
    try { localStorage.setItem(CLAIM_KEY + '_' + wk, '1'); } catch (e) {}
  }
  function signupClaimed() {
    var wk = claimedWallet(); if (!wk) return false;
    try { if (localStorage.getItem(CLAIM_KEY + '_' + wk)) return true; } catch (e) {}
    if (cachedLedger && cachedLedger.signupClaimed) { markClaimed(); return true; }
    return false;
  }

  function getLedger(force) {
    var w = wallet();
    if (!w) return Promise.resolve(null);
    if (!force && cachedLedger && Date.now() - ledgerAt < 120000) return Promise.resolve(cachedLedger);
    return fetch('/api/affiliate?wallet=' + encodeURIComponent(w), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        cachedLedger = j; ledgerAt = Date.now();
        if (j && j.handle && window.isValidProfileHandle && window.isValidProfileHandle(j.handle)) {
          cachedHandle = j.handle;
          try { localStorage.setItem('gfg_handle_' + w, j.handle); } catch (e) {}
        }
        if (j && j.signupClaimed) markClaimed();
        return j;
      })
      .catch(function () { return null; });
  }

  function claimSignupBonus() {
    var w = wallet();
    if (!w) return Promise.resolve({ ok: false, error: 'signin' });
    var body = { wallet: w, handle: handle() };
    var ref = pendingRefHandle() || handle();
    if (ref) body.refHandle = ref;
    try { if (ref) localStorage.setItem('gfg_pending_ref', ref); } catch (e) {}
    return fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // A claim credits the GLOBAL ledger server-side (relay-signed). The
        // header pill reads the global ledger cache, so refresh JUST that
        // module. Deliberately NOT window.pointsStore.refresh(): that entry
        // point wipes all cached ledgers sitewide, and if the wallet read is
        // momentarily unavailable it clears caches with NO refetch scheduled,
        // which froze every points display until the next real login/logout.
        try {
          if (window.globalLedger && typeof window.globalLedger.fetch === 'function') window.globalLedger.fetch();
        } catch (e) { /* cache-only display is fine */ }
        if (j && j.handle && window.isValidProfileHandle && window.isValidProfileHandle(j.handle)) {
          cachedHandle = j.handle;
          var wk = wallet(); if (wk) { try { localStorage.setItem('gfg_handle_' + wk, j.handle); } catch (e2) {} }
        }
        if (j && (j.signupClaimed || j.alreadyClaimed)) markClaimed();
        cachedLedger = null; ledgerAt = 0;
        fillSlots(null);
        return j;
      })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  function shareLink() {
    var h = handle();
    if (!h) return null;
    return (location.origin || '') + '/?ref=' + encodeURIComponent(h);
  }

  function fillSlots(ledger) {
    var h = handle();
    var els = document.querySelectorAll('[data-ref-code]');
    for (var i = 0; i < els.length; i++) els[i].textContent = h ? h : 'Sign in to get your code';
    var linkEls = document.querySelectorAll('[data-ref-link]');
    for (var j = 0; j < linkEls.length; j++) linkEls[j].textContent = h ? shareLink() : '';
    var earned = document.querySelectorAll('[data-ref-earned]');
    for (var k = 0; k < earned.length; k++) earned[k].textContent = ledger ? ('$' + ((ledger.lifetimeUsdCents || 0) / 100).toFixed(2)) : '--';
    var pend = document.querySelectorAll('[data-ref-pending]');
    for (var m = 0; m < pend.length; m++) pend[m].textContent = ledger ? ('$' + ((ledger.pendingUsdCents || 0) / 100).toFixed(2)) : '--';
  }

  function refresh() {
    getLedger().then(function (l) { if (l && l.account) fillSlots(l); });
    fillSlots(null);
  }

  window.gfgReferral = { handle, shareLink, claimSignupBonus, getLedger, refresh, signupClaimed, markClaimed };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(refresh, 800); });
  else setTimeout(refresh, 800);
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('gfg:auth-changed', function () { cachedHandle = null; cachedLedger = null; setTimeout(refresh, 300); });
  }
})();