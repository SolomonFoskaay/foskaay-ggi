// dash-nav.js
// Shared LEFT navigation rail for the dashboard / profile page groups.
// Opposite of the global header drawer (which opens from the right): this one
// sits on the left and is used to hop between the pages of a single area
// (e.g. dashboard home, ops, endpoints, activity, accounts, release).
//
// Usage:
//   window.GFG_DASH_NAV.render({
//     brand: '🛡 Dashboard',             // short area label
//     active: 'home',                     // key of the current page
//     onClose: null,                      // optional callback after open/close
//     sections: [
//       { heading: 'Overview', items: [
//           { key: 'home', label: '🏠 Home', href: '/dashboard/' },
//       ]},
//       { heading: 'Detail', items: [
//           { key: 'ops', label: '⚙️ Ops', href: '/dashboard/ops.html' },
//       ]},
//     ]
//   });
//
// On wide screens the rail is always open; on phones it slides in from the
// left via a hamburger and closes on scrim/✕/Esc. The global header and its
// right-side drawer are NOT touched.

(function () {

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function close() {
        document.getElementById('dash-rail-scrim')?.classList.remove('show');
        document.getElementById('dash-rail')?.classList.remove('open');
        document.getElementById('dash-rail-btn')?.classList.remove('hide');
    }

    function open() {
        document.getElementById('dash-rail-scrim')?.classList.add('show');
        document.getElementById('dash-rail')?.classList.add('open');
        document.getElementById('dash-rail-btn')?.classList.add('hide');
    }

    function render(cfg) {
        cfg = cfg || {};
        const brand = cfg.brand || '📌';
        const sections = Array.isArray(cfg.sections) ? cfg.sections.slice() : [];
        // Universal Tools section so the launch run sheet is reachable from every
        // dashboard page's own menu (single place).
        if (!sections.some(sec => (sec.items || []).some(it => it.href === '/changelog/architecture-v2.html'))) {
            sections.push({ heading: 'Architecture', items: [
                { key: 'arch-v1', label: '📐 Architecture V1', href: '/changelog/architecture.html' },
                { key: 'arch-v2', label: '🚀 Architecture V2', href: '/changelog/architecture-v2.html' }
            ] });
        }
        if (!sections.some(sec => (sec.items || []).some(it => it.href === '/dashboard/arc.html'))) {
            sections.push({ heading: 'On-chain rails', items: [
                { key: 'arc-rail', label: '🔷 Arc rail (EVM)', href: '/dashboard/arc.html' }
            ] });
        }
        if (!sections.some(sec => (sec.items || []).some(it => it.href === '/changelog/tests.html'))) {
            sections.push({ heading: 'Test results', items: [
                { key: 'tests', label: '🧪 Test results (built + measured)', href: '/changelog/tests.html' }
            ] });
        }
        if (!sections.some(sec => (sec.items || []).some(it => it.key === 'research'))) {
            sections.push({ heading: 'Research', items: [
                { key: 'research', label: '🔬 Research (pre-architecture)', href: '/changelog/research.html' }
            ] });
        }
        if (!sections.some(sec => (sec.items || []).some(it => it.key === 'run-sheet'))) {
            sections.push({ heading: 'Tools', items: [
                { key: 'run-sheet', label: '🧾 Launch run sheet', href: '/dashboard/run-sheet.md' }
            ] });
        }
        if (!sections.some(sec => (sec.items || []).some(it => it.key === 'todo'))) {
            sections.push({ heading: 'Todo', items: [
                { key: 'todo', label: '📋 Live todo list', href: '/dashboard/todo.html' }
            ] });
        }
        const active = cfg.active || '';
        if (document.getElementById('dash-rail')) return; // already rendered

        const railHTML = `
            <div id="dash-rail-scrim" class="dash-rail-scrim"></div>
            <aside id="dash-rail" class="dash-rail" aria-label="Page navigation">
                <div class="dash-rail-head">
                    <span class="dash-rail-brand">${esc(brand)}</span>
                    <button id="dash-rail-close" class="dash-rail-close" aria-label="Close page menu">×</button>
                </div>
                ${sections.map(sec => `
                    <div class="dash-rail-section">
                        <div class="dash-rail-heading">${esc(sec.heading)}</div>
                        <ul>
                            ${(sec.items || []).map(it => `
                                <li><a href="${esc(it.href)}" class="${it.key === active ? 'active' : ''}">${esc(it.label)}</a></li>
                            `).join('')}
                        </ul>
                    </div>
                `).join('')}
            </aside>
        `;
        document.body.insertAdjacentHTML('beforeend', railHTML);

        const btn = document.createElement('button');
        btn.id = 'dash-rail-btn';
        btn.className = 'dash-rail-btn';
        btn.setAttribute('aria-label', 'Open page menu');
        btn.textContent = '☰';
        document.body.insertBefore(btn, document.body.firstChild);

        // Always-open on wide screens: body class nudges content right.
        if (window.matchMedia('(min-width: 900px)').matches) {
            document.body.classList.add('dash-rail-on');
        }

        document.getElementById('dash-rail-btn').addEventListener('click', open);
        document.getElementById('dash-rail-close').addEventListener('click', close);
        document.getElementById('dash-rail-scrim').addEventListener('click', close);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });

        // Slide the rail back in if the window crosses the wide-screen breakpoint.
        window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => {
            if (e.matches) {
                document.body.classList.add('dash-rail-on');
                close();
            } else {
                document.body.classList.remove('dash-rail-on');
            }
        });

        if (typeof cfg.onClose === 'function') {
            document.addEventListener('dashnav-closed', cfg.onClose);
        }
    }

    window.GFG_DASH_NAV = { render, open, close };

})();
