// public/global_header.js
// Minimal Foskaay GGI header. Loads the Dynamic auth bootstrap (/web/main.js)
// and renders a small top bar with a Sign in / account button. No GFG modules.
(function () {
  'use strict';

  // Load the auth bootstrap once (module).
  if (!document.querySelector('script[data-ggi-main]')) {
    var s = document.createElement('script');
    s.type = 'module';
    s.src = '/web/main.js';
    s.setAttribute('data-ggi-main', '1');
    document.head.appendChild(s);
  }

  function render() {
    if (document.getElementById('ggi-header')) return;
    var bar = document.createElement('div');
    bar.id = 'ggi-header';
    bar.style.cssText = 'position:sticky;top:0;z-index:900;display:flex;align-items:center;gap:18px;padding:10px 16px;background:rgba(10,10,10,.92);border-bottom:1px solid #222;font-family:inherit;';
    bar.innerHTML =
      '<a href="/" style="color:#f39c12;font-weight:800;text-decoration:none">Foskaay GGI</a>' +
      '<nav style="display:flex;gap:16px;flex:1;font-size:.92rem">' +
      '<a href="/demos/" style="color:#ddd;text-decoration:none">Demos</a>' +
      '<a href="/demos/board/ludo/" style="color:#ddd;text-decoration:none">Ludo</a>' +
      '<a href="/docs/" style="color:#ddd;text-decoration:none">Docs</a>' +
      '<a href="/explorer/" style="color:#ddd;text-decoration:none">Explorer</a>' +
      '</nav>' +
      '<button id="ggi-auth-btn" style="padding:8px 14px;border:0;border-radius:999px;background:#f39c12;color:#111;font-weight:700;cursor:pointer">Sign in</button>';
    document.body.insertBefore(bar, document.body.firstChild);

    document.getElementById('ggi-auth-btn').onclick = function () {
      if (window.currentUser) { if (window.logoutDynamic) window.logoutDynamic(); }
      else if (window.openDynamicLogin) window.openDynamicLogin();
    };

    window.refreshAuthHeader = function () {
      var b = document.getElementById('ggi-auth-btn');
      if (!b) return;
      var evm = window.getDynamicEvmWallet && window.getDynamicEvmWallet();
      if (window.currentUser || evm) {
        b.textContent = evm ? (evm.slice(0, 6) + '...' + evm.slice(-4)) : 'Account';
      } else {
        b.textContent = 'Sign in';
      }
    };
    window.refreshAuthHeader();

    // Keep the button in sync when auth changes.
    try { window.addEventListener('gfg:auth-changed', function () { window.refreshAuthHeader(); }); } catch (e) {}
  }

  if (document.readyState !== 'loading') render();
  else document.addEventListener('DOMContentLoaded', render);
})();
