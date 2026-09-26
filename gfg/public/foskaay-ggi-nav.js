// foskaay-ggi-nav.js
// Shared LEFT navigation rail for EVERY Foskaay GGI page (demos + docs).
//
// WHY: the Foskaay GGI section has its own pages (demos, docs, get started, FAQ)
// that should be navigable without cluttering the GlobalFolkGames main drawer.
// This reuses the dashboard's left rail (public/dash-nav.js) so the look and the
// mobile behaviour (hamburger, scrim, Esc) are identical and there is only ONE
// rail implementation to maintain.
//
// Usage (load AFTER /dash-nav.js):
//   window.GFG_GGI_NAV.render({ active: 'docs' });
//
// Keys: 'demos' | 'docs' | 'get-started' | 'faq'.

(function () {
    var PAGES = [
        { key: 'home', label: '⚡ Overview', href: '/foskaay-ggi/' },
        { key: 'demos', label: '🎮 Demos', href: '/foskaay-ggi/demos/' },
        { key: 'explorer', label: '🔎 Explorer', href: '/foskaay-ggi/explorer/' },
        { key: 'docs', label: '📖 Docs', href: '/foskaay-ggi/docs/' },
        { key: 'designing', label: '🧠 Designing a game', href: '/foskaay-ggi/docs/#designing' },
        { key: 'settle-modes', label: '⚖️ Settle modes', href: '/foskaay-ggi/docs/#settle-modes' },
        { key: 'upgradeable', label: '🔧 Upgradeable?', href: '/foskaay-ggi/docs/#upgradeable' },
        { key: 'get-started', label: '🚀 Get started', href: '/foskaay-ggi/docs/#get-started' },
        { key: 'faq', label: '❓ FAQ and fixes', href: '/foskaay-ggi/docs/#faq' }
    ];

    function render(cfg) {
        cfg = cfg || {};
        if (!window.GFG_DASH_NAV || typeof window.GFG_DASH_NAV.render !== 'function') {
            // The rail script is not loaded on this page; fail quietly rather than
            // break the page. The global header still works.
            return;
        }
        window.GFG_DASH_NAV.render({
            brand: '⚡ Foskaay GGI',
            active: cfg.active || '',
            sections: [{ heading: 'Foskaay GGI', items: PAGES }]
        });
    }

    window.GFG_GGI_NAV = { render: render, pages: PAGES };
})();
