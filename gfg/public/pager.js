// pager.js
// Shared, dependency-free pagination for list content on the dashboard and
// profile pages. Splits a list of items into pages with a Prev / numbered /
// Next pager, and (on dedicated detail pages) a "show per page" selector
// (10/20/50/100). On the homepage sections (inside main.dash-home) it uses a
// small fixed page size and no selector, so every card stays a similar height.
//
// Usage:
//   GFG_Pager.paginate(el, {
//     items,                        // array of anything
//     render: (item) => 'html',     // one item -> one html string
//     wrap:   (pageHtml) => 'html', // optional wrapping (e.g. build a <table>)
//     empty:  '<p class="empty">…</p>',
//     header: '',                   // static html kept above the paged list
//     footer: '',                   // static html kept below the pager
//     homePer: 5,                   // page size used on homepage cards
//     per: 10,                      // default page size on detail pages
//     sizes: [10,20,50,100],        // selector options (null = no selector)
//   });

(function () {
    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Is this element inside a homepage overview (main.dash-home)?
    function isHome(el) {
        return !!(el && el.closest && el.closest('.dash-home'));
    }

    function pageButtons(page, total) {
        const out = [];
        for (let i = 1; i <= total; i++) {
            if (i === 1 || i === total || Math.abs(i - page) <= 1) {
                out.push(`<button type="button" class="pager-btn ${i === page ? 'active' : ''}" data-pager-page="${i}">${i}</button>`);
            } else if (out[out.length - 1] !== '…') {
                out.push('<span class="pager-ellipsis">…</span>');
            }
        }
        return out.join('');
    }

    function paginate(el, opts) {
        if (!el) return;
        opts = opts || {};
        const items = opts.items || [];
        const render = opts.render || (x => '');
        const wrap = opts.wrap || null;
        const empty = opts.empty || '<p class="empty">Nothing here yet.</p>';
        const home = isHome(el);
        const sizes = opts.sizes !== undefined ? opts.sizes : (home ? null : [10, 20, 50, 100]);
        const defPer = opts.per != null ? opts.per : (home ? (opts.homePer || 5) : 10);

        // Remember user choices across re-renders (stored on the element).
        let per = defPer;
        if (el.dataset.pagerPer) {
            const stored = Number(el.dataset.pagerPer);
            if (!isNaN(stored) && stored > 0 && (!sizes || sizes.includes(stored))) per = stored;
        }
        let page = 1;
        if (el.dataset.pagerPage) {
            const stored = Number(el.dataset.pagerPage);
            if (!isNaN(stored) && stored > 0) page = stored;
        }

        const total = Math.max(1, Math.ceil(items.length / per));
        if (page > total) page = total;

        if (!items.length) {
            el.innerHTML = empty;
            el.dataset.pagerLoaded = '1';
            return;
        }

        const start = (page - 1) * per;
        const body = items.slice(start, start + per).map(render).join('');
        const mainHtml = wrap ? wrap(body) : body;

        let sizeHtml = '';
        if (sizes && sizes.length && items.length > defPer && items.length > 1) {
            sizeHtml = `<div class="pager-sizes"><span class="pager-sizes-label">Show</span>${sizes.map(s =>
                `<button type="button" class="pager-size ${s === per ? 'active' : ''}" data-pager-size="${s}">${s}</button>`).join('')}</div>`;
        }

        let navHtml = '';
        if (total > 1) {
            navHtml = `<div class="pager-nav">` +
                `<button type="button" class="pager-btn" data-pager-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>‹ Prev</button>` +
                pageButtons(page, total) +
                `<button type="button" class="pager-btn" data-pager-page="${page + 1}"${page >= total ? ' disabled' : ''}>Next ›</button>` +
                `</div>`;
        }

        el.innerHTML = (opts.header || '') + mainHtml + sizeHtml + navHtml + (opts.footer || '');
        el.dataset.pagerLoaded = '1';
        el.dataset.pagerPage = String(page);
        el.dataset.pagerPer = String(per);
        el.__pagerOpts = opts;

        if (!el.__pagerBound) {
            el.__pagerBound = true;
            el.addEventListener('click', function (ev) {
                const sizeBtn = ev.target.closest('.pager-size');
                if (sizeBtn) {
                    const size = Number(sizeBtn.getAttribute('data-pager-size'));
                    el.dataset.pagerPer = String(size);
                    el.dataset.pagerPage = '1';
                    paginate(el, el.__pagerOpts);
                    return;
                }
                const pageBtn = ev.target.closest('.pager-btn');
                if (!pageBtn || pageBtn.disabled) return;
                const pg = Number(pageBtn.getAttribute('data-pager-page'));
                if (isNaN(pg) || pg < 1) return;
                el.dataset.pagerPage = String(pg);
                paginate(el, el.__pagerOpts);
            });
        }
    }

    window.GFG_Pager = { paginate };
})();