// public/footer.js — UNIVERSAL FOOTER (mirrors header.js so no page edits).
//
// Injected everywhere the global header loads (header.js ensures this file on
// every page), so the footer never has to be added by hand. Deduplicated by
// id + the gfgFooter flag, styled in the same dark-glass brand look, links to
// the core public pages. In the future the global header/footer boot will be
// refactored onto one shared boot script; until then this is the one place a
// footer change is made sitewide.
(function () {
    'use strict';
    if (window.gfgFooter || document.getElementById('gfg-footer')) return;
    window.gfgFooter = true;

    function inject() {
        if (document.getElementById('gfg-footer')) return;
        var f = document.createElement('footer');
        f.id = 'gfg-footer';
        f.setAttribute('style',
            'position:relative; width:100%; box-sizing:border-box; margin-top:28px; padding:20px 14px 34px;' +
            'background:rgba(15,14,45,0.55); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px);' +
            'border-top:1px solid rgba(255,255,255,0.08); text-align:center; color:#ddd;');
        f.innerHTML =
            '<a href="/" style="font-size:0.95rem; font-weight:800; color:#fff; letter-spacing:0.02em; text-decoration:none;"><span style="color:#f87818;">Global</span><span style="color:#7838f8;">Folk</span><span style="color:#f87818;">Games</span><span style="color:#7838f8;">.</span><span style="color:#f87818;">fun</span></a>' +
            '<div style="margin-top:4px; font-size:0.72rem; color:#bbb;">\u00A9 2026 - Till Date \u00B7 Preserving native games on-chain \u00B7 <span style="color:#f87818; font-weight:800;">Beta</span></div>' +
            '<div style="margin-top:10px; display:flex; gap:14px; flex-wrap:wrap; justify-content:center; font-size:0.78rem;">' +
            '<a href="/about/" style="color:#f87818; text-decoration:none;">About</a>' +
            '<a href="/support/" style="color:#f87818; text-decoration:none;">Support</a>' +
            '<a href="/contact/" style="color:#f87818; text-decoration:none;">Contact</a>' +
            '<a href="/forum/" style="color:#f87818; text-decoration:none;">Forum</a>' +
            '<a href="/changelog/" style="color:#7838f8; text-decoration:none;">What\'s New</a>' +
            '<a href="/games/" style="color:#2ecc71; text-decoration:none;">Play Native Games</a>' +
            '<a href="/privacy.html" style="color:#f87818; text-decoration:none;">Privacy Policy</a>' +
            '</div>';
        document.body.appendChild(f);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();