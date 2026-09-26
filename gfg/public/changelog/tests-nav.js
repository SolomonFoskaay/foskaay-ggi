// public/changelog/tests-nav.js
// Left-rail navigation for the staff Test results workspace. Mirrors
// research-nav.js: a brand + a Workspace section + one entry per test result.
(function () {
  var ITEMS = [
    { key: 'arc-phase1', label: '1 · Arc contracts + one session' },
    { key: 'arc-phase2', label: '2 · PlayerCore + gasless relayer' },
    { key: 'arc-phase3', label: '3 · O(1) batching + TTL' },
    { key: 'arc-window', label: 'W · Settlement window economics' }
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
      brand: '🧪 Test results',
      active: opts.active || activeKey(),
      sections: [
        { heading: 'Workspace', items: [
          { key: 'home', label: '🧪 All results', href: '/changelog/tests.html' }
        ]},
        { heading: 'Arc rail (arcv2m16)', items: ITEMS.map(function (it) {
          return { key: it.key, label: it.label, href: '/changelog/tests.html?r=' + it.key };
        })},
        { heading: 'Related', items: [
          { key: 'research', label: '🔬 Research', href: '/changelog/research.html' },
          { key: 'arch-v2', label: '🚀 Architecture V2', href: '/changelog/architecture-v2.html' }
        ]}
      ]
    });
  }

  window.GFG_TESTS_NAV = { render: render, activeKey: activeKey };
})();
