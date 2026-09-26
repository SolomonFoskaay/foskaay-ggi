// public/changelog/arch-nav.js
// Left-rail navigation for the Architecture workspace, version-aware.
//
// v2 pages (body[data-arch="v2"]) use the live arcv2m1..arcv2m14 modules and the
// architecture-v2-* pages. v1 pages (no data-arch) use the frozen arcv1m1..
// arcv1m11 record and the architecture-arcv1m* pages. The two never mix, so
// "arcv2m1" can never be confused with "arcv1m1".
(function () {
  var V2 = [
    { key: 'arcv2m1', label: 'arcv2m1 · Game core' },
    { key: 'arcv2m2', label: 'arcv2m2 · Result seam' },
    { key: 'arcv2m3', label: 'arcv2m3 · Local points' },
    { key: 'arcv2m4', label: 'arcv2m4 · Global ledgers' },
    { key: 'arcv2m5', label: 'arcv2m5 · Subscription' },
    { key: 'arcv2m6', label: 'arcv2m6 · Point sources' },
    { key: 'arcv2m7', label: 'arcv2m7 · Competitions' },
    { key: 'arcv2m8', label: 'arcv2m8 · Sponsor escrow' },
    { key: 'arcv2m9', label: 'arcv2m9 · Player inventory' },
    { key: 'arcv2m10', label: 'arcv2m10 · Lives + daily' },
    { key: 'arcv2m11', label: 'arcv2m11 · Community' },
    { key: 'arcv2m12', label: 'arcv2m12 · Multiplayer' },
    { key: 'arcv2m13', label: 'arcv2m13 · Academy' },
    { key: 'arcv2m14', label: 'arcv2m14 · AGM' },
    { key: 'arcv2m15', label: 'arcv2m15 · Revenue splitter' },
    { key: 'arcv2m16', label: 'arcv2m16 · EVM rail (Arc)' },
    { key: 'arcv2m17', label: 'arcv2m17 · Batched Settlement (GFG-BS)' }
  ];
  var V1 = [];
  for (var i = 1; i <= 11; i++) V1.push({ key: 'arcv1m' + i, label: 'arcv1m' + i + ' · record' });

  function pageFile() {
    var p = location.pathname || '';
    return p.substring(p.lastIndexOf('/') + 1) || 'architecture.html';
  }
  function isV2() {
    return !!(document.body && document.body.dataset && document.body.dataset.arch === 'v2') || pageFile() === 'architecture-v2.html';
  }
  function activeKey() {
    var m = (document.body && document.body.dataset && document.body.dataset.module) || '';
    if (m) return String(m).toLowerCase();
    return isV2() ? 'v2home' : 'v1home';
  }
  function render(opts) {
    if (!window.GFG_DASH_NAV) return;
    opts = opts || {};
    var v2 = isV2();
    var homeHref = v2 ? '/changelog/architecture-v2.html' : '/changelog/architecture.html';
    var homeLabel = v2 ? '🚀 Overview (arcv2)' : '📐 Overview (arcv1 record)';
    window.GFG_DASH_NAV.render({
      brand: v2 ? '🚀 Architecture arcv2' : '📐 Architecture arcv1 (record)',
      active: opts.active || activeKey(),
      sections: [
        { heading: 'Workspace', items: [
          { key: v2 ? 'v2home' : 'v1home', label: homeLabel, href: homeHref }
        ]},
        { heading: v2 ? 'Modules (arcv2)' : 'Modules (arcv1 record)', items: (v2 ? V2 : V1).map(function (mo) {
          return { key: mo.key, label: mo.label, href: v2 ? ('/changelog/architecture-v2-' + mo.key + '.html') : ('/changelog/architecture-' + mo.key + '.html') };
        })},
        { heading: 'Versions', items: [
          { key: 'v2', label: '🚀 arcv2 (current)', href: '/changelog/architecture-v2.html' },
          { key: 'v1', label: '📐 arcv1 (record)', href: '/changelog/architecture.html' }
        ]}
      ]
    });
  }
  window.GFG_ARCH_NAV = { render: render, activeKey: activeKey, pageFile: pageFile };
})();
