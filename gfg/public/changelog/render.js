// public/changelog/render.js
// Shared renderer for both changelog pages.
//   - mode 'user'  : watered-down summaries, always readable.
//   - mode 'admin' : raw details (numbered DEV Plan bullets, git refs, dates),
//     for staff use.
// Content is organized by 3 status tabs (Planned / In progress / Shipped) and
// paginated per tab so long lists break into pages (Prev / pages / Next).
(function () {
  const CHANGELOG_JSON = '/changelog/changelog.json';
  const ROLES_JSON = '/changelog/roles.json';
  const PAGE_SIZE = 6;

  const TAB_ORDER = ['planned', 'in-progress', 'shipped'];
  const TAB_LABEL = {
    'planned': 'Planned',
    'in-progress': 'In progress',
    'shipped': 'Shipped'
  };

  // Current view state: which tab + which page within that tab.
  // User mode lands on "Planned" (the forward-looking roadmap the owner has
  // approved for players); admins see the full pipeline from "In progress".
  let state = { mode: 'user', tab: 'planned', page: 1 };
  let cache = null; // parsed changelog.json
  let renderedFingerprint = null; // what the current screen actually shows
  const POLL_MS = 45000;

  function qs(sel) { return document.querySelector(sel); }

  // Resolve the connected user's Solana wallet. Prefers the Dynamic SDK path
  // used across the app; falls back to the cached profile wallet.
  function currentWallet() {
    try {
      if (window.getDynamicSolanaWallet) {
        const w = window.getDynamicSolanaWallet();
        if (w) return w;
      }
      if (window.currentProfile && window.currentProfile.solana_wallet) {
        return window.currentProfile.solana_wallet;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }

  async function loadRoles() {
    try { return await loadJson(ROLES_JSON); } catch (e) { return { admin: [], moderator: [] }; }
  }

  function roleForWallet(wallet, roles) {
    if (!wallet || !roles) return 'user';
    const w = wallet.toLowerCase();
    // Lowercase role lists too — Solana base58 addresses are case-sensitive on
    // chain but we normalize for matching (mirrors the .equals() gotcha: never
    // compare raw strings of different cases).
    const norm = list => Array.isArray(list) ? list.map(a => String(a).toLowerCase()) : [];
    if (norm(roles.admin).includes(w)) return 'admin';
    if (norm(roles.moderator).includes(w)) return 'moderator';
    return 'user';
  }

  // Ranks so moderator inherits access to pages that only need >= moderator.
  const RANK = { user: 0, moderator: 1, admin: 2 };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function typeBadge(type) {
    const label = { major: 'Major', minor: 'Minor', patch: 'Patch' }[type] || 'Update';
    const cls = { major: 'b-major', minor: 'b-minor', patch: 'b-patch' }[type] || 'b-minor';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function statusBadge(status) {
    const s = status === 'in-progress' ? 'in-progress' : 'planned';
    const label = s === 'in-progress' ? 'In progress' : 'Planned';
    return `<span class="badge b-status ${s}">${label}</span>`;
  }

  // Admin (dev) view: the technical plan renders as a numbered list (1. 2. 3.)
  // instead of bullet dots — easier to scan point by point.
  function devPlan(details) {
    if (!Array.isArray(details) || !details.length) return '';
    return `
      <div class="entry-details">
        <h4>DEV Plan</h4>
        <ol class="dev-plan-list">
          ${details.map(d => `<li>${esc(d)}</li>`).join('')}
        </ol>
      </div>`;
  }

  // Roadmap (Feature Tracker) item — planned or in-progress.
  // On the admin page, unapproved items get a "pending approval" badge so the
  // owner instantly sees what's in the technical pipeline but not yet public.
  function renderRoadmapItem(e, mode) {
    const extra = mode === 'admin' ? devPlan(e.details) : '';
    const pending = mode === 'admin' && e.approved !== true
      ? `<span class="badge b-status pending">Pending approval</span>`
      : '';
    return `
      <article class="entry roadmap-entry ${e.status === 'in-progress' ? 'entry-in-progress' : ''}">
        <div class="entry-head">
          <span class="entry-version">Next</span>
          ${statusBadge(e.status)}
          ${pending}
          <span class="entry-date">added ${esc(e.added || '')}</span>
        </div>
        <h3>${esc(e.title)}</h3>
        <p class="entry-summary">${esc(e.summary) || '<em>(no user summary yet — approve to publish)</em>'}</p>
        ${extra}
      </article>`;
  }

  // Shipped changelog entry.
  function renderEntry(e, mode) {
    const extra = mode === 'admin' ? devPlan(e.details) : '';
    let git = '';
    if (mode === 'admin' && e.git) {
      git = `<div class="entry-git">git ${esc(e.git.head || '')} — ${esc(e.git.message || '')}</div>`;
    }
    return `
      <article class="entry ${e.type === 'major' ? 'entry-major' : ''}">
        <div class="entry-head">
          <span class="entry-version">v${esc(e.version)}</span>
          ${typeBadge(e.type)}
          <span class="entry-date">${esc(e.date)}</span>
        </div>
        <h3>${esc(e.title)}</h3>
        <p class="entry-summary">${esc(e.summary) || '<em>(no summary)</em>'}</p>
        ${extra}
        ${git}
      </article>`;
  }

  // ---- tabs ----
  function renderTabs(activeTab) {
    return `
      <nav class="changelog-tabs" role="tablist" aria-label="Filter changelog by status">
        ${TAB_ORDER.map(tab => `
          <button class="changelog-tab ${tab === activeTab ? 'active' : ''}"
            role="tab" aria-selected="${tab === activeTab}"
            data-tab="${tab}">${TAB_LABEL[tab]}</button>
        `).join('')}
      </nav>`;
  }

  // ---- pagination ----
  function renderPagination(page, totalPages) {
    if (totalPages <= 1) return '';
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(`<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}" aria-label="Page ${i}">${i}</button>`);
    }
    return `
      <nav class="changelog-pagination" aria-label="Pagination">
        <button class="page-btn" data-nav="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹ Prev</button>
        ${pages.join('')}
        <button class="page-btn" data-nav="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Next page">Next ›</button>
      </nav>`;
  }

  // Filter changelog data by the active tab.
  // Everything in this payload is user-safe by construction: unfixed security
  // work is never stored in changelog.json (client-served data), so there is
  // nothing to hide at render time. Beyond that, user mode only shows roadmap
  // items explicitly APPROVED by the owner — unapproved items are admin-only.
  function itemsFor(data, tab, mode) {
    if (tab === 'shipped') return Array.isArray(data.entries) ? data.entries.slice() : [];
    const roadmap = Array.isArray(data.roadmap) ? data.roadmap : [];
    if (mode === 'admin') return roadmap.filter(r => r.status === tab);
    return roadmap.filter(r => r.status === tab && r.approved === true);
  }

  // Fingerprint the data so we can detect updates without a full diff.
  // Includes the version, the shipped entries (count + newest date) and the
  // roadmap (count + newest `added` date). Polling compares this — when it
  // changes we show a "new update" pill instead of silently clobbering what
  // the reader is currently looking at.
  function fingerprint(data) {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const roadmap = Array.isArray(data.roadmap) ? data.roadmap : [];
    return [
      data.current || '',
      entries.length,
      entries[0] && entries[0].date ? entries[0].date : '',
      roadmap.length,
      roadmap.reduce((m, r) => (r.added && r.added > m ? r.added : m), '')
    ].join('|');
  }

  // --- new-update pill (click to refresh — never yanks the page out from
  // under a reader, honours the running tab + page they've picked) ---
  function showUpdatePill() {
    let pill = document.getElementById('changelog-update-pill');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'changelog-update-pill';
      pill.className = 'changelog-update-pill';
      pill.type = 'button';
      pill.setAttribute('aria-live', 'polite');
      pill.addEventListener('click', () => {
        cache = null; // force a fresh fetch on next paint
        paint();
      });
      const tabsHost = document.querySelector('.changelog-tabs');
      const entriesEl = document.getElementById('changelog-entries');
      if (tabsHost && entriesEl && entriesEl.parentNode) {
        entriesEl.parentNode.insertBefore(pill, tabsHost);
      } else if (entriesEl && entriesEl.parentNode) {
        entriesEl.parentNode.insertBefore(pill, entriesEl);
      }
    }
    pill.textContent = '🔔 1 new update — refresh';
    pill.classList.add('show');
  }

  function hideUpdatePill() {
    const pill = document.getElementById('changelog-update-pill');
    if (pill) pill.classList.remove('show');
  }

  // Poll for a fresh changelog.json; if the payload changed since the last
  // render, surface a refresh pill. The reader chooses when to apply it.
  async function startPoller() {
    try {
      if (!cache) return;
      const fresh = await loadJson(CHANGELOG_JSON);
      if (renderedFingerprint && fingerprint(fresh) !== renderedFingerprint) {
        showUpdatePill();
      }
    } catch (e) { /* network blip — keep current view */ }
  }

  async function paint() {
    const out = qs('#changelog-entries');
    const verEl = qs('#changelog-version');
    const whoEl = qs('#changelog-role');
    if (!out) return;

    try {
      if (!cache) cache = await loadJson(CHANGELOG_JSON);
      const data = cache;
      const mode = state.mode;
      renderedFingerprint = fingerprint(data);
      hideUpdatePill();
      if (verEl) verEl.textContent = data.current || '';
      whoEl.textContent = esc(mode === 'admin' ? 'Admin view' : 'Public changelog');

      const all = itemsFor(data, state.tab, mode);
      const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      // Clamp page so navigation never lands past the end of a tab.
      if (state.page > totalPages) state.page = totalPages;

      const pageItems = all.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((e, i) => e.status
            ? renderRoadmapItem(e, mode)
            : renderEntry(e, mode)).join('')
        : `<p class="empty">Nothing ${esc(TAB_LABEL[state.tab].toLowerCase())} right now.</p>`;

      // On the admin page, a one-line note above the list (staff-only reminder).
      let note = '';
      if (mode === 'admin') {
        const where = data.entries[0] && data.entries[0].version
          ? `This page shows engineer-facing details for v${esc(data.entries[0].version)} and earlier.`
          : 'This page shows engineer-facing details only staff can see.';
        note = `<p class="admin-note">${esc(where)}</p>`;
      }

      out.innerHTML = `
        ${renderTabs(state.tab)}
        ${note}
        ${list}
        ${renderPagination(state.page, totalPages)}`;
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the changelog (${esc(e.message)}). Try the <a href="/">homepage</a>.</p>`;
    }
  }

  // Single delegated click handler for tabs + pagination (works on both pages).
  function bindControls() {
    const out = qs('#changelog-entries');
    if (!out || out.dataset.bound) return;
    out.dataset.bound = '1';
    out.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        state.tab = tabBtn.dataset.tab;
        state.page = 1;
        paint();
        return;
      }
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn) {
        state.page = Number(pageBtn.dataset.page);
        paint();
        return;
      }
      const navBtn = e.target.closest('[data-nav]');
      if (navBtn) {
        const tabItems = cache ? itemsFor(cache, state.tab, state.mode).length : 0;
        const lastPage = Math.max(1, Math.ceil(tabItems / PAGE_SIZE));
        if (navBtn.dataset.nav === 'prev' && state.page > 1) state.page -= 1;
        if (navBtn.dataset.nav === 'next' && state.page < lastPage) state.page += 1;
        paint();
      }
    });
  }

  async function render(mode) {
    state.mode = mode;
    // Land visitors on the "Planned" tab (the owner-approved roadmap of what's
    // coming), keeping "Shipped" a click away for the release history. Admin
    // mode shows the full pipeline from the same default.
    bindControls();
    await paint();
    // Check periodically for new updates; if found, show a refresh pill.
    setInterval(startPoller, POLL_MS);
  }

  // Admin gate: staff only (admin/moderator). Fixed 2026-08-24: waits up to 10s
  // for the wallet to restore and NEVER redirects on an unresolved wallet (a slow
  // session used to bounce real admins). Only a positively-confirmed non-staff
  // wallet redirects home.
  async function requireStaff() {
    const roles = await loadRoles();

    function handleStaffCheck(w, r) {
      const role = roleForWallet(w, r);
      const badge = qs('#changelog-role');
      if (badge && w) badge.textContent = typeof role === 'string' ? w.slice(0, 4) + '…' + w.slice(-4) + ' · ' + role : '';
      return (role && RANK[role] >= RANK.moderator) ? role : null;
    }

    let wallet = currentWallet();
    for (let i = 0; i < 20; i++) {
      if (wallet) break;
      await new Promise(r => setTimeout(r, 500));
      wallet = currentWallet();
    }
    // Give the header a chance to hydrate the wallet from a restored session.
    if (!wallet && window.refreshAuthHeader) {
      try { await window.refreshAuthHeader(); } catch (e) { /* ignore */ }
      wallet = currentWallet();
    }

    const role = handleStaffCheck(wallet, roles);
    if (wallet) {
      // Known wallet: bounce only if it is genuinely not staff.
      if (!(role && RANK[role] >= RANK.moderator)) {
        window.location.replace('/');
        return null;
      }
      // Post-verify once after full settle to refresh the badge.
      setTimeout(() => {
        const w = currentWallet();
        if (w) { const fr = roleForWallet(w, roles); const b = qs('#changelog-role'); if (b) b.textContent = w.slice(0, 4) + '…' + w.slice(-4) + ' · ' + (typeof fr === 'string' ? fr : 'guest'); }
      }, 2500);
      return role;
    }
    // Wallet never resolved this load: keep the page (no bounce); re-check later.
    setTimeout(() => {
      const w = currentWallet();
      if (w && roleForWallet(w, roles)) { window.location.reload(); }
      else if (w && !roleForWallet(w, roles)) { window.location.replace('/'); }
    }, 4000);
    return null;
  }

  // Non-bouncing role lookup for the public page (shows the staff link).
  async function getRole() {
    const roles = await loadRoles();
    let wallet = currentWallet();
    if (!wallet && window.refreshAuthHeader) {
      try { await window.refreshAuthHeader(); } catch (e) { /* ignore */ }
      wallet = currentWallet() || wallet;
    }
    return roleForWallet(wallet, roles);
  }

  window.renderChangelog = render;
  window.requireStaffAccess = requireStaff;
  window.getChangelogRole = getRole;
})();