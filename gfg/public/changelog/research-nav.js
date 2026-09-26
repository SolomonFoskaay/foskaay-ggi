// public/changelog/research-nav.js
// Left-rail navigation for the admin Research workspace. Mirrors arch-nav.js:
// a brand + a Workspace section (Overview) + one entry per research item, so the
// owner can jump straight to a topic on mobile.
(function () {
  var ITEMS = [
    { key: 'arc', label: '🔎 Arc mainnet migration' },
    { key: 'cards', label: '🃏 Earned trading cards' }
  ];

  function activeKey() {
    try {
      var r = new URLSearchParams(location.search).get('r');
      return r ? String(r).toLowerCase() : 'home';
    } catch (e) { return 'home'; }
  }

  function render(opts) {
    if (!window.GFG_DASH_NAV) return;
    opts = opts || {};
    window.GFG_DASH_NAV.render({
      brand: '🔬 Research',
      active: opts.active || activeKey(),
      sections: [
        { heading: 'Workspace', items: [
          { key: 'home', label: '🔬 All research', href: '/changelog/research.html' }
        ]},
        { heading: 'Researching', items: ITEMS.map(function (it) {
          return { key: it.key, label: it.label, href: '/changelog/research.html?r=' + it.key };
        })},
        { heading: 'Related', items: [
          { key: 'arch-v2', label: '🚀 Architecture V2', href: '/changelog/architecture-v2.html' },
          { key: 'economics', label: '📈 Game Economics', href: '/changelog/economics.html' }
        ]}
      ]
    });
  }

  window.GFG_RESEARCH_NAV = { render: render, activeKey: activeKey };
})();
