// public/global_header.js
// Foskaay GGI header with a GFG-style hamburger drawer: the bar only shows the
// brand, an account button and the 3-bar button; every menu item lives inside
// the drawer. Loads the auth bootstrap (/web/main.js).
(function () {
  'use strict';

  if (!document.querySelector('script[data-ggi-main]')) {
    var s = document.createElement('script');
    s.type = 'module';
    s.src = '/web/main.js';
    s.setAttribute('data-ggi-main', '1');
    document.head.appendChild(s);
  }

  var CSS = ''
    + '.ggi-h{position:sticky;top:0;z-index:900;background:rgba(12,12,16,.94);border-bottom:1px solid rgba(255,255,255,.08);backdrop-filter:blur(8px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}'
    + '.ggi-h-in{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:10px 14px;}'
    + '.ggi-brand{color:#f39c12;font-weight:900;text-decoration:none;font-size:1.02rem;letter-spacing:.02em;flex:1;}'
    + '.ggi-acct-btn{display:inline-flex;align-items:center;padding:6px 14px 6px 8px;border:0;border-radius:999px;background:rgba(255,255,255,.08);color:#fff;font-weight:700;cursor:pointer;font-family:inherit;font-size:.88rem;white-space:nowrap;}'
    + '.ggi-acct-btn:hover{background:rgba(255,255,255,.14);}'
    + '.ggi-avatar{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#f39c12,#9b59b6);color:#111;font-weight:900;font-size:.76rem;margin-right:8px;flex:0 0 auto;}'
    + '.ggi-burger{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;cursor:pointer;flex-direction:column;gap:5px;}'
    + '.ggi-burger i{display:block;width:20px;height:2px;background:#eee;border-radius:2px;}'
    + '.ggi-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:990;opacity:0;pointer-events:none;transition:opacity .2s;}'
    + '.ggi-scrim.show{opacity:1;pointer-events:auto;}'
    + '.ggi-draw{position:fixed;top:0;right:0;bottom:0;width:min(86vw,330px);background:#101016;border-left:1px solid rgba(255,255,255,.1);z-index:995;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}'
    + '.ggi-draw.open{transform:translateX(0);}'
    + '.ggi-draw-head{display:flex;align-items:center;justify-content:space-between;padding:16px 16px;border-bottom:1px solid rgba(255,255,255,.08);}'
    + '.ggi-draw-head .ggi-brand{flex:1;}'
    + '.ggi-draw-x{width:34px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#eee;font-size:1.1rem;cursor:pointer;}'
    + '.ggi-draw-acct{padding:16px;border-bottom:1px solid rgba(255,255,255,.08);}'
    + '.ggi-acct-line{display:flex;align-items:center;gap:10px;}'
    + '.ggi-acct-email{color:#ddd;font-size:.88rem;font-weight:700;}'
    + '.ggi-acct-wallets{color:#8f8fa0;font-size:.76rem;margin-top:2px;word-break:break-all;}'
    + '.ggi-draw-nav{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:2px;}'
    + '.ggi-item{display:block;text-decoration:none;color:#e4e4ec;font-size:.94rem;font-weight:600;padding:12px 12px;border-radius:10px;}'
    + '.ggi-item:hover{background:rgba(255,255,255,.07);color:#fff;}'
    + '.ggi-item.sub{padding:3px 12px 3px 26px;font-size:.86rem;color:#b9b9c6;}'
    + '.ggi-item.hire{background:linear-gradient(135deg,#f39c12,#e67e22);color:#111 !important;}'
    + '.ggi-btn{width:100%;padding:12px;border:0;border-radius:12px;font-weight:800;cursor:pointer;font-family:inherit;font-size:.92rem;}'
    + '.ggi-btn.sign{background:linear-gradient(135deg,#f39c12,#e67e22);color:#111;}'
    + '.ggi-btn.out{margin-top:10px;background:rgba(231,76,60,.15);color:#e74c3c;border:1px solid rgba(231,76,60,.4);}'
    + '.ggi-ft{border-top:1px solid rgba(255,255,255,.08);background:#0c0c10;margin-top:40px;}'
    + '.ggi-ft-in{max-width:1080px;margin:0 auto;padding:26px 16px;display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;}'
    + '.ggi-ft a{color:#b9b9c6;text-decoration:none;font-size:.86rem;margin-right:16px;}'
    + '.ggi-ft a:hover{color:#fff;}'
    + '.ggi-ft-c{color:#7d7d8c;font-size:.8rem;}'
    + '.ggi-mbtn{display:inline-block;padding:9px 16px;border-radius:999px;background:linear-gradient(135deg,#f39c12,#e67e22);color:#111;font-weight:800;text-decoration:none;font-size:.86rem;}';

  function render() {
    if (document.getElementById('ggi-header')) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    var path = location.pathname;
    function act(p) { return path === p || (p !== '/' && path.indexOf(p) === 0) ? ' style="background:rgba(255,255,255,.06);color:#fff"' : ''; }

    var scrim = document.createElement('div');
    scrim.className = 'ggi-scrim';
    scrim.id = 'ggi-scrim';

    var draw = document.createElement('div');
    draw.id = 'ggi-draw';
    draw.className = 'ggi-draw';
    draw.innerHTML = ''
      + '<div class="ggi-draw-head"><a class="ggi-brand" href="/">Foskaay GGI</a>'
      + '<button class="ggi-draw-x" id="ggi-draw-x" aria-label="Close menu">&times;</button></div>'
      + '<div class="ggi-draw-acct" id="ggi-draw-acct">'
      + '  <span id="ggi-draw-acct-inner" style="color:#8f8fa0;font-size:.84rem">Signed out</span>'
      + '</div>'
      + '<nav class="ggi-draw-nav">'
      + '  <a class="ggi-item" href="/" ' + act('/') + '>Home</a>'
      + '  <a class="ggi-item" href="/demos/">Demos</a>'
      + '  <a class="ggi-item sub" href="/demos/board/ludo/">Ludo demo</a>'
      + '  <a class="ggi-item sub" href="/demos/board/ludo/">Ludo demo</a>'
      + '  <a class="ggi-item" href="/docs/" ' + act('/docs') + '>Docs</a>'
      + '  <a class="ggi-item" href="/explorer/" ' + act('/explorer') + '>Explorer</a>'
      + '  <a class="ggi-item" href="/about/" ' + act('/about') + '>About</a>'
      + '  <a class="ggi-item" href="/contact/" ' + act('/contact') + '>Contact</a>'
      + '  <a class="ggi-item" href="/profile/" ' + act('/profile') + '>Wallets / Profile</a>'
      + '  <a class="ggi-item hire" href="/hire/">Hire me</a>'
      + '</nav>';

    var bar = document.createElement('div');
    bar.id = 'ggi-header';
    bar.className = 'ggi-h';
    bar.innerHTML = '<div class="ggi-h-in">'
      + '<a class="ggi-brand" href="/">Foskaay GGI</a>'
      + '<button class="ggi-acct-btn" id="ggi-auth-btn">Sign in</button>'
      + '<button class="ggi-burger" id="ggi-burger" aria-label="Open menu"><i></i><i></i><i></i></button>'
      + '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.appendChild(scrim);
    document.body.appendChild(draw);

    function openDrawer() { draw.classList.add('open'); scrim.classList.add('show'); }
    function closeDrawer() { draw.classList.remove('open'); scrim.classList.remove('show'); }
    document.getElementById('ggi-burger').onclick = openDrawer;
    document.getElementById('ggi-draw-x').onclick = closeDrawer;
    scrim.onclick = closeDrawer;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    // Sign out confirmation popup (never instant).
    function confirmSignout() {
      closeDrawer();
      var m = document.createElement('div');
      m.id = 'ggi-confirm';
      m.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:10002;';
      m.innerHTML = '<div style="background:#15151c;border:1px solid #333;border-radius:14px;padding:22px;width:min(92vw,340px);color:#eee;text-align:center;font-family:inherit">'
        + '<div style="font-weight:800;font-size:1.05rem;margin-bottom:8px">Sign out of Foskaay GGI?</div>'
        + '<div style="color:#b9b9c6;font-size:.86rem;margin-bottom:16px">You can sign back in any time with your email.</div>'
        + '<div style="display:flex;gap:10px;justify-content:center">'
        + '<button id="ggi-so-cancel" style="padding:10px 16px;border-radius:999px;border:1px solid #444;background:transparent;color:#ddd;cursor:pointer;font-weight:700">Cancel</button>'
        + '<button id="ggi-so-yes" style="padding:10px 16px;border-radius:999px;border:0;background:#e74c3c;color:#fff;cursor:pointer;font-weight:800">Sign out</button>'
        + '</div></div>';
      document.body.appendChild(m);
      document.getElementById('ggi-so-cancel').onclick = function () { m.remove(); };
      document.getElementById('ggi-so-yes').onclick = function () { m.remove(); if (window.logoutDynamic) window.logoutDynamic(); };
      m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    }

    function short(a) { return a ? (a.slice(0, 6) + '...' + a.slice(-4)) : null; }

    function renderAccount() {
      var btn = document.getElementById('ggi-auth-btn');
      var acct = document.getElementById('ggi-draw-acct-inner');
      var evm = window.getDynamicEvmWallet && window.getDynamicEvmWallet();
      var sol = window.getDynamicSolanaWallet && window.getDynamicSolanaWallet();
      var email = window.getDynamicEmail && window.getDynamicEmail();
      var signed = !!(window.currentUser || evm);
      if (!signed) {
        if (btn) { btn.textContent = 'Sign in'; }
        if (acct) {
          acct.innerHTML = '<button class="ggi-btn sign" id="ggi-signin">Sign in</button>';
          var b = document.getElementById('ggi-signin');
          if (b) b.onclick = function () { closeDrawer(); if (window.openDynamicLogin) window.openDynamicLogin(); };
        }
        return;
      }
      var initial = (email && email[0]) ? email[0].toUpperCase() : (evm ? evm.slice(2, 3).toUpperCase() : 'W');
      var label = short(evm) || 'Account';
      if (btn) btn.innerHTML = '<span class="ggi-avatar">' + initial + '</span>' + label;
      if (acct) {
        acct.innerHTML = '<div class="ggi-acct-line" style="margin-bottom:10px">'
          + '<span class="ggi-avatar" style="width:38px;height:38px;font-size:1rem">' + initial + '</span>'
          + '<div><div class="ggi-acct-email">' + (email || 'Signed in with a wallet') + '</div>'
          + '<div class="ggi-acct-wallets">' + (evm ? 'EVM ' + short(evm) : '') + (evm && sol ? ' &middot; ' : '') + (sol ? 'SOL ' + short(sol) : '') + '</div></div>'
          + '</div>'
          + '<a class="ggi-item" href="/profile/" style="padding:10px 12px">My wallets and profile</a>'
          + '<button class="ggi-btn out" id="ggi-signout">Sign out</button>';
        var so = document.getElementById('ggi-signout');
        if (so) so.onclick = function (e) { e.preventDefault(); confirmSignout(); };
      }
      var drawerAcct = document.getElementById('ggi-draw-acct');
      if (drawerAcct) {
        var avatar = drawerAcct.querySelector('.ggi-avatar');
        drawerAcct.querySelectorAll('.ggi-item').forEach(function () {});
        if (avatar) avatar.onclick = function () { window.location.href = '/profile/'; };
      }
    }

    // Account button: signed in -> profile; signed out -> login.
    document.getElementById('ggi-auth-btn').onclick = function () {
      var evm = window.getDynamicEvmWallet && window.getDynamicEvmWallet();
      if (window.currentUser || evm) window.location.href = '/profile/';
      else if (window.openDynamicLogin) window.openDynamicLogin();
    };

    window.refreshAuthHeader = function () { renderAccount(); };
    window.refreshAuthHeader();
    try { window.addEventListener('gfg:auth-changed', function () { window.refreshAuthHeader(); }); } catch (e) {}

    renderFooter();
  }

  function renderFooter() {
    if (document.getElementById('ggi-footer')) return;
    var f = document.createElement('footer');
    f.id = 'ggi-footer';
    f.className = 'ggi-ft';
    f.innerHTML = '<div class="ggi-ft-in">'
      + '<div><a href="/docs/">Docs</a><a href="/demos/">Demos</a><a href="/explorer/">Explorer</a><a href="/about/">About</a><a href="/contact/">Contact</a><a href="/hire/">Hire me</a></div>'
      + '<div style="display:flex;align-items:center;gap:14px"><span class="ggi-ft-c">&copy; 2026 Foskaay GGI</span><a class="ggi-mbtn" href="mailto:hellofoskaay@gmail.com">Email me</a></div>'
      + '</div>';
    document.body.appendChild(f);
  }

  if (document.readyState !== 'loading') render();
  else document.addEventListener('DOMContentLoaded', render);
})();