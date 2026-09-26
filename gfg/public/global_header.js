// global_header.js
// The ONE file a page needs to show the full shared GlobalFolkGames header:
// brand/logo, the global spendable points pill (M4 ledger ONLY), sign in /
// sign out, and the menu. It loads, in the exact order the homepage uses,
// every script the header depends on:
//
//   supabase CDN -> auth.js -> tamper-guard.js -> profiles.js ->
//   tiers.js -> header.js  (classic, ordered, synchronous chain)
//   src/main.js            (ES module, Dynamic client + VRF bootstrap)
//
// Then it waits for the Dynamic module to be ready and auto-calls
// window.initGlobalHeader(). This is the single source of truth for the
// global header: every page loads THIS file and nothing else header-related,
// so a change in this file (or in header.js / profiles.js) lands identically
// on every page. There are NO per-page header display options: the header is
// uniform everywhere.
//
// DISPLAY RULE (owner-locked): the pill shows ONLY the M4 global spendable
// ledger. M3 local (per-game) points are game-specific and are NEVER rendered
// in the global header. The global spendable balance already aggregates every
// source (local game wins, referrals, buy-ins), so a separate local points
// chip must never be added here.
//
// FUNCTIONAL module override: every page boots the Dynamic client via
// /src/main.js. A page whose game requires a different SDK bootstrap may set
// window.GFG_HEADER_MODULE before including this file (ludo-lab uses
// /src/main-lab.js for the ER VRF SDK). This is a functional requirement, not
// a display override, and only ludo-lab uses it today.
//
// HOW THE STACK LOADS:
// The header stack MUST finish executing before the page scripts below this
// file run (page scripts at their own DOMContentLoaded read window.supabase,
// window.currentUser, window.refreshAuthHeader, etc.). To guarantee that, this
// file writes the stack with document.write during the initial parse: it
// blocks the parser exactly like the plain <script> tags it replaces, and the
// scripts execute in order before parsing continues. (Dynamic appendChild
// scripts with async=false would NOT block the parser, so page handlers could
// run before the header globals exist and admin gates / role checks would
// break.) document.write is only ever used from this one loader during the
// initial synchronous parse, which is the one safe place for it.

(function () {
  'use strict';

  var MODULE_SRC = (typeof window.GFG_HEADER_MODULE === 'string' && window.GFG_HEADER_MODULE) ? window.GFG_HEADER_MODULE : '/src/main.js';

  // The exact homepage header stack, in order. The supabase CDN + the classic
  // scripts must load synchronously and in sequence (auth.js needs window
  // .supabase; header.js needs profiles.js's refreshAuthHeader).
  var STACK = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    '/auth.js',
    '/tamper-guard.js',
    '/profiles.js',
    '/tiers.js',
    '/header.js'
  ];

  // Inject the stack synchronously via document.write so it executes before
  // the rest of the page parses, exactly like the old individual <script>
  // tags. Scripts that are already present (e.g. injected by a host page) are
  // skipped to avoid duplicate loads.
  var missing = STACK.filter(function (src) {
    return !document.querySelector('script[src="' + src + '"]');
  });

  // document.write may only be used during the initial parse; if we are ever
  // loaded late (async/defer), fall back to the ordered async injection
  // (works, but page handlers must tolerate a slightly later header).
  if (document.readyState === 'loading') {
    if (missing.length) {
      document.write('<script src="' + missing.join('"></script><script src="') + '"></script>');
    }
  } else {
    // Late-load fallback: inject with async=false (ordered) so the chain order
    // is still preserved even though it no longer blocks the parser.
    missing.forEach(function (src) {
      var el = document.createElement('script');
      el.src = src;
      el.async = false;
      document.head.appendChild(el);
    });
  }

  function scriptPresent(src) {
    return !!document.querySelector('script[src="' + src + '"]');
  }

  function bootAfterModule() {
    function go() {
      if (typeof window.initGlobalHeader === 'function') {
        try { window.initGlobalHeader(); } catch (e) {
          try { console.warn('[global-header] initGlobalHeader failed: ' + e.message); } catch (e2) {}
        }
      } else {
        // initGlobalHeader should exist (header.js is in the stack above, or
        // preloaded by the page); if it somehow is missing, say so quietly.
        try { console.warn('[global-header] initGlobalHeader missing after stack load'); } catch (e) {}
      }
    }

    // The Dynamic module is async: it may not have created window.dynamicClient
    // yet when the classic chain finishes. The module sets window.dynamicClient
    // at top level, so we wait a bounded amount for it before calling
    // initGlobalHeader -> refreshAuthHeader; otherwise a silently restored
    // session would first render as the signed-out "Sign in" pill.
    // profiles.js's own DOMContentLoaded bootliner re-renders on session
    // restore regardless, so even if the deadline passes the pill self-corrects.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitDynamic);
    } else {
      waitDynamic();
    }

    function waitDynamic() {
      var deadline = Date.now() + 4000;
      (function poll() {
        if (window.dynamicClient || window.magicblockDice || Date.now() >= deadline) {
          setTimeout(go, 0);
          return;
        }
        setTimeout(poll, 75);
      })();
    }
  }

  function loadModule() {
    if (scriptPresent(MODULE_SRC)) { bootAfterModule(); return; }
    var m = document.createElement('script');
    m.type = 'module';
    m.src = MODULE_SRC;
    m.onerror = function () {
      // Without the Dynamic module the pill degrades to the logged-out state
      // but sign-in is unavailable; still boot so the rest of the header and
      // the page's own logic run.
      try { console.warn('[global-header] could not load ' + MODULE_SRC); } catch (e) {}
      bootAfterModule();
    };
    // Append the module after the last existing script so it never runs before
    // the classic stack above it has executed.
    var preceders = document.querySelectorAll('script');
    var last = preceders[preceders.length - 1];
    if (last && last.parentNode) last.parentNode.appendChild(m);
    else document.head.appendChild(m);
    bootAfterModule();
  }

  loadModule();
})();