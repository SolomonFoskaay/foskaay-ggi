// public/global_header.js
// Foskaay GGI header: a compact top bar with a dropdown menu (Demos, Docs,
// Explorer, About, Contact, Hire) and the Dynamic auth button. Loads the auth
// bootstrap (/web/main.js). No GFG modules.
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
    + '.ggi-h-in{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;}'
    + '.ggi-brand{color:#f39c12;font-weight:900;text-decoration:none;font-size:1.02rem;letter-spacing:.02em;margin-right:6px;white-space:nowrap;}'
    + '.ggi-nav{display:flex;align-items:center;gap:2px;flex:1;flex-wrap:wrap;}'
    + '.ggi-item{position:relative;}'
    + '.ggi-link{display:inline-flex;align-items:center;gap:5px;color:#d8d8e0;text-decoration:none;font-size:.9rem;font-weight:600;padding:8px 11px;border-radius:9px;background:none;border:0;cursor:pointer;font-family:inherit;}'
    + '.ggi-link:hover{color:#fff;background:rgba(255,255,255,.06);}'
    + '.ggi-link.active{color:#f39c12;}'
    + '.ggi-caret{font-size:.6rem;opacity:.7;}'
    + '.ggi-drop{position:absolute;top:calc(100% + 6px);left:0;min-width:190px;background:#15151c;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px;display:none;box-shadow:0 18px 40px rgba(0,0,0,.5);z-index:1002;}'
    + '.ggi-item.open .ggi-drop{display:block;}'
    + '.ggi-drop a{display:block;color:#d8d8e0;text-decoration:none;font-size:.87rem;padding:9px 11px;border-radius:8px;}'
    + '.ggi-drop a:hover{background:rgba(255,255,255,.07);color:#fff;}'
    + '.ggi-drop a small{display:block;color:#8f8fa0;font-weight:500;margin-top:2px;}'
    + '.ggi-hire{background:linear-gradient(135deg,#f39c12,#e67e22);color:#111 !important;font-weight:800;}'
    + '.ggi-hire:hover{filter:brightness(1.06);}'
    + '.ggi-account{position:relative;}'
    + '.ggi-acct-btn{padding:8px 15px;border:0;border-radius:999px;background:rgba(255,255,255,.08);color:#fff;font-weight:700;cursor:pointer;font-family:inherit;font-size:.88rem;white-space:nowrap;}'
    + '.ggi-acct-btn:hover{background:rgba(255,255,255,.14);}'
    + '.ggi-account .ggi-drop{right:0;left:auto;min-width:210px;}'
    + '.ggi-acct-mail{display:block;padding:9px 11px;color:#8f8fa0;font-size:.78rem;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:4px;word-break:break-all;}'
    + '.ggi-mbtn{display:inline-block;padding:9px 16px;border-radius:999px;background:linear-gradient(135deg,#f39c12,#e67e22);color:#111;font-weight:800;text-decoration:none;font-size:.86rem;}'
    + '.ggi-ft{border-top:1px solid rgba(255,255,255,.08);background:#0c0c10;margin-top:40px;}'
    + '.ggi-ft-in{max-width:1080px;margin:0 auto;padding:26px 16px;display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;}'
    + '.ggi-ft a{color:#b9b9c6;text-decoration:none;font-size:.86rem;margin-right:16px;}'
    + '.ggi-ft a:hover{color:#fff;}'
    + '.ggi-ft-c{color:#7d7d8c;font-size:.8rem;}'
    + '@media (max-width:720px){.ggi-h-in{flex-wrap:wrap;}.ggi-nav{order:3;width:100%;justify-content:flex-start;}.ggi-brand{flex:1;}}';

  function render() {
    if (document.getElementById('ggi-header')) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    var path = location.pathname;
    function act(p) { return path === p || (p !== '/' && path.indexOf(p) === 0) ? ' active' : ''; }

    var bar = document.createElement('div');
    bar.id = 'ggi-header';
    bar.className = 'ggi-h';
    bar.innerHTML = ''
      + '<div class="ggi-h-in">'
      + '<a class="ggi-brand" href="/">Foskaay GGI</a>'
      + '<nav class="ggi-nav">'
      + '  <div class="ggi-item" id="ggi-m-demos"><button class="ggi-link' + act('/demos') + '">Demos <span class="ggi-caret">v</span></button>'
      + '    <div class="ggi-drop"><a href="/demos/">All demos<small>Idle, casual, PvP, board</small></a><a href="/demos/board/ludo/">Ludo demo<small>Full on-chain match</small></a></div></div>'
      + '  <div class="ggi-item"><a class="ggi-link' + act('/docs') + '" href="/docs/">Docs</a></div>'
      + '  <div class="ggi-item"><a class="ggi-link' + act('/explorer') + '" href="/explorer/">Explorer</a></div>'
      + '  <div class="ggi-item"><a class="ggi-link' + act('/about') + '" href="/about/">About</a></div>'
      + '  <div class="ggi-item"><a class="ggi-link' + act('/contact') + '" href="/contact/">Contact</a></div>'
      + '  <div class="ggi-item"><a class="ggi-link ggi-hire" href="/hire/">Hire us</a></div>'
      + '</nav>'
      + '<div class="ggi-account" id="ggi-acct">'
      + '  <button class="ggi-acct-btn" id="ggi-auth-btn">Sign in</button>'
      + '  <div class="ggi-drop" id="ggi-acct-drop"></div>'
      + '</div>'
      + '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    // Dropdown toggles (click to open; click away to close).
    var demos = document.getElementById('ggi-m-demos');
    demos.querySelector('.ggi-link').addEventListener('click', function (e) {
      e.preventDefault();
      demos.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!demos.contains(e.target)) demos.classList.remove('open');
      if (!document.getElementById('ggi-acct').contains(e.target)) document.getElementById('ggi-acct').classList.remove('open');
    });

    document.getElementById('ggi-auth-btn').addEventListener('click', function (e) {
      e.preventDefault();
      var acct = document.getElementById('ggi-acct');
      var evm = window.getDynamicEvmWallet && window.getDynamicEvmWallet();
      if (!(window.currentUser || evm)) { if (window.openDynamicLogin) window.openDynamicLogin(); return; }
      var drop = document.getElementById('ggi-acct-drop');
      drop.innerHTML = '<span class="ggi-acct-mail">' + (evm || 'Signed in') + '</span>'
        + '<a href="/explorer/" target="_blank" rel="noopener">Explorer</a>'
        + '<a href="#" id="ggi-signout">Sign out</a>';
      acct.classList.toggle('open');
      var so = document.getElementById('ggi-signout');
      if (so) so.onclick = function (ev) { ev.preventDefault(); if (window.logoutDynamic) window.logoutDynamic(); acct.classList.remove('open'); };
    });

    window.refreshAuthHeader = function () {
      var b = document.getElementById('ggi-auth-btn');
      if (!b) return;
      var evm = window.getDynamicEvmWallet && window.getDynamicEvmWallet();
      if (window.currentUser || evm) b.textContent = evm ? (evm.slice(0, 6) + '...' + evm.slice(-4)) : 'Account';
      else b.textContent = 'Sign in';
    };
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
      + '<div><a href="/docs/">Docs</a><a href="/demos/">Demos</a><a href="/explorer/">Explorer</a><a href="/about/">About</a><a href="/contact/">Contact</a><a href="/hire/">Hire us</a></div>'
      + '<div style="display:flex;align-items:center;gap:14px"><span class="ggi-ft-c">&copy; 2026 Foskaay GGI</span><a class="ggi-mbtn" href="mailto:hellofoskaay@gmail.com">Email us</a></div>'
      + '</div>';
    document.body.appendChild(f);
  }

  if (document.readyState !== 'loading') render();
  else document.addEventListener('DOMContentLoaded', render);
})();
