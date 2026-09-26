// public/changelog/architecture.js
// Admin-only "Architecture (Modules)" workspace renderer.
//
// Two render modes, driven by the page:
//   1. OVERVIEW (default, /changelog/architecture.html): the module list
//      grouped by status tab (Planned / In progress / Shipped) + module rules
//      + implementation order. Each module card links to its own page.
//   2. MODULE PAGE (/changelog/architecture-m1.html ... -m8.html): a single
//      module's full detail + a left-rail navigation (dashboard style).
//      M1 additionally renders a searchable game dropdown: selecting a game
//      shows that game's LOCKED build spec (M1 sub-modules: M1-ludo locked,
//      M1-ayo-olopon planned). These locked specs are the build + test
//      benchmark the agent follows.
//
// Data lives in architecture.json (client-served but admin-gated; no unfixed
// security/anti-exploit details go here, per security-queue.md rules).
(function () {
  const ARCH_JSON_V2 = '/changelog/architecture.json';
  const ARCH_JSON_V1 = '/changelog/architecture-v1.json';
  // v2 pages load the live architecture.json; v1 pages load the frozen record.
  function archJsonUrl() { return isV2Page() ? ARCH_JSON_V2 : ARCH_JSON_V1; }
  const STATUSES = ['planned', 'in-progress', 'shipped'];
  const STATUS_LABEL = {
    'planned': 'Planned',
    'in-progress': 'In progress',
    'shipped': 'Shipped'
  };

  let cache = null;

  function qs(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }

  function statusBadge(status) {
    const label = STATUS_LABEL[status] || status;
    return `<span class="badge b-status ${esc(status)}">${esc(label)}</span>`;
  }

  // Version-aware links. On a v2 page (body[data-arch="v2"]) module cards and
  // the back link point at the v2 module pages; otherwise they stay on the v1
  // pages. Arcv1 and arcv2 never cross-link into each other's pages.
  function isV2Page() {
    return !!(document.body && document.body.dataset && document.body.dataset.arch === 'v2');
  }
  function archPrefix() { return isV2Page() ? 'architecture-v2-' : 'architecture-'; }
  function modHref(id) { return '/changelog/' + archPrefix() + String(id).toLowerCase() + '.html'; }
  function archHomeHref() { return isV2Page() ? '/changelog/architecture-v2.html' : '/changelog/architecture.html'; }

  function detailsHtml(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="entry-details"><h4>Dev notes</h4><ul>${items.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  // Optional structured sections for a module (same shape as the Research
  // library): heading + paragraphs + bullets + a mobile-scrollable table. Used
  // where a module needs tables for clarity (e.g. arcv2m18 findings).
  function tableHtml(t) {
    if (!t || !Array.isArray(t.headers) || !t.headers.length) return '';
    const head = t.headers.map((h) => `<th>${esc(h)}</th>`).join('');
    const body = (t.rows || []).map((row) =>
      `<tr>${(row || []).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
    return `<div class="research-table-wrap"><table class="research-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function sectionsHtml(sections) {
    if (!Array.isArray(sections) || !sections.length) return '';
    const body = sections.map((s) => {
      let html = `<h4 class="research-h4">${esc(s.heading)}</h4>`;
      (s.paragraphs || []).forEach((p) => { html += `<p class="research-p">${esc(p)}</p>`; });
      if (Array.isArray(s.bullets) && s.bullets.length) {
        html += `<ul class="research-list">${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
      }
      html += tableHtml(s.table);
      return html;
    }).join('');
    return `<div class="arch-block"><h3 class="arch-block-title">Findings and tables</h3><div class="research-body">${body}</div></div>`;
  }

  function contractSection(contract, label, icon) {
    if (!contract || !contract.items || !contract.items.length) return '';
    const statusNote = contract.status
      ? `<span class="badge b-status planned" style="margin-left:8px;font-size:0.72rem;">${esc(contract.status)}</span>`
      : '';
    return `
      <div class="arch-contract">
        <h4 class="arch-contract-title">${icon} ${esc(label)}${statusNote}</h4>
        ${contract.summary ? `<p class="arch-contract-summary">${esc(contract.summary)}</p>` : ''}
        <ul class="arch-contract-list">${contract.items.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>`;
  }

  function moduleCard(m) {
    const gameCount = Array.isArray(m.games) && m.games.length
      ? ` <span class="badge b-status in-progress">${m.games.length} game sub-module(s)</span>`
      : '';
    const inputCount = m.expectedInput && m.expectedInput.items ? m.expectedInput.items.length : 0;
    const outputCount = m.expectedOutput && m.expectedOutput.items ? m.expectedOutput.items.length : 0;
    const contractBadge = (inputCount || outputCount)
      ? `<span class="badge b-status in-progress" style="font-size:0.72rem;">⬅️ ${inputCount} in / ➡️ ${outputCount} out</span>`
      : '';
    return `
      <article class="entry roadmap-entry econ-entry">
        <div class="entry-head">
          <a class="entry-version arch-module-link" href="${modHref(m.id)}">${esc(m.id)} →</a>
          ${statusBadge(m.status)}${gameCount}${contractBadge}
        </div>
        <h3>${esc(m.title)}</h3>
        ${m.summary ? `<p class="entry-summary">${esc(m.summary)}</p>` : ''}
        ${detailsHtml(m.details)}
        <p class="entry-git">Module page: <a href="${modHref(m.id)}" style="color:#7838f8;">${esc(m.id)} full detail →</a></p>
      </article>`;
  }

  const OVERVIEW_TABS = [{ key: 'summary', label: 'Summary' }, ...STATUSES.map(s => ({ key: s, label: STATUS_LABEL[s] }))];

  function renderSummaryTab(cache) {
    const ov = cache.overview;
    if (!ov) return `<p class="muted-note" style="color:#888;">No overview data in architecture.json.</p>`;
    const fc = ov.flowChain || [];
    const mods = ov.modules || [];
    const rules = ov.keyRules || [];
    const fd = ov.flowDiagram;
    const infraNotes = ov.infraNotes || [];

    const flowCards = mods.map(m => {
      const badge = (() => {
        const mod = (cache.modules || []).find(x => x.id === m.id);
        return mod ? statusBadge(mod.status) : '';
      })();
      return `
        <div class="ov-card">
          <div class="ov-card-head">
            <span class="entry-version" style="font-size:0.95rem;">${esc(m.id)}</span>
            <span class="ov-card-title">${esc(m.title)}</span>
            ${badge}
          </div>
          <p class="ov-card-body">${esc(m.what)}</p>
        </div>`;
    }).join('');

    const arrows = fc.map(a => `
      <div class="ov-arrow">
        <span class="ov-arrow-from">${esc(a.from)}</span>
        <span class="ov-arrow-label">${esc(a.label)}</span>
        <span class="ov-arrow-to">${esc(a.to)}</span>
      </div>`).join('');

    return `
      <p class="econ-updated" style="margin-bottom:18px;">${esc(ov.subtitle || '')}</p>
      ${infraNotes.length ? `
        <section class="arch-block">
          <h3 class="arch-block-title">Infrastructure notes (MagicBlock ER)</h3>
          <ul class="arch-contract-list">${infraNotes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        </section>` : ''}
      ${fd ? `<div class="ov-flow-diagram"><h4 class="arch-block-title">Data flow</h4><p class="ov-flow-label">${esc(fd.label)}</p><p class="ov-flow-path">${esc(fd.path)}</p></div>` : ''}
      <section class="arch-block">
        <h3 class="arch-block-title">Modules at a glance</h3>
        <div class="ov-cards">${flowCards}</div>
      </section>
      ${arrows.length ? `<section class="arch-block"><h3 class="arch-block-title">How they connect</h3><div class="ov-arrows">${arrows}</div></section>` : ''}
      ${renderUniversalFolder(ov.universalFolder)}
      ${rules.length ? `<section class="arch-block"><h3 class="arch-block-title">Key rules (non-negotiable)</h3><ul>${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}
      <hr class="arch-divider">
      ${renderOrder(cache.implementationOrder)}
    `;
  }

  function renderUniversalFolder(uf) {
    if (!uf) return '';
    var rows = (uf.layout || []).map(function (r) {
      var mod = r.module || '';
      var planned = !r.file || r.file === '(planned)';
      return '<tr' + (planned ? ' class="ov-uf-planned"' : '') + '>'
        + '<td class="ov-uf-folder"><code>' + esc(r.folder) + '</code></td>'
        + '<td class="ov-uf-module"><span class="entry-version" style="font-size:0.82rem;">' + esc(mod) + '</span></td>'
        + '<td class="ov-uf-desc">' + esc(r.desc) + '</td>'
        + '</tr>';
    }).join('');
    return '<section class="arch-block">'
      + '<h3 class="arch-block-title">Codebase layout (universal modules)</h3>'
      + '<p class="muted-note" style="color:#888;font-size:0.82rem;line-height:1.5;margin:0 0 10px;">' + esc(uf.note || '') + '</p>'
      + '<p class="ov-uf-path"><code>' + esc(uf.path || '') + '</code></p>'
      + '<table class="ov-uf-table"><thead><tr><th>Folder</th><th>Module</th><th>What lives here</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '</section>';
  }

  function renderModuleListTab(cache, status) {
    const modules = (cache.modules || []).filter(m => m.status === status);
    return `
      ${modules.length
        ? modules.map(moduleCard).join('')
        : `<p class="empty">No modules in "${esc(STATUS_LABEL[status]).toLowerCase()}" right now.</p>`}
    `;
  }

  // ----- OVERVIEW mode (home: /changelog/architecture.html) -----
  function renderOverview(cache, activeTab) {
    const updated = cache.updated || '';
    return `
      <nav class="changelog-tabs econ-tabs" role="tablist" aria-label="Architecture tabs">
        ${OVERVIEW_TABS.map(t => `
          <button class="changelog-tab econ-tab ${t.key === activeTab ? 'active' : ''}"
            role="tab" aria-selected="${t.key === activeTab}"
            data-ov-tab="${t.key}">${esc(t.label)}</button>
        `).join('')}
      </nav>
      <p class="econ-updated">Workspace last updated: ${esc(updated)}</p>
      <p class="muted-note" style="color:#888;font-size:0.82rem;line-height:1.5;">Each module has its own page with full detail (use the ☰ left rail to navigate). M1 carries a searchable game dropdown with per-game LOCKED build specs. Click a module id to open it.</p>
      ${activeTab === 'summary'
        ? renderSummaryTab(cache)
        : renderModuleListTab(cache, activeTab)}
      ${activeTab !== 'summary' ? `
        <hr class="arch-divider">
        ${renderRules(cache.rules)}
        ${renderOrder(cache.implementationOrder)}
      ` : ''}
    `;
  }

  function renderRules(rules) {
    if (!Array.isArray(rules) || !rules.length) return '';
    return `
      <section class="arch-block">
        <h3 class="arch-block-title">⚙️ Module rules (non-negotiable)</h3>
        <ul>${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </section>`;
  }

  function renderOrder(order) {
    if (!Array.isArray(order) || !order.length) return '';
    return `
      <section class="arch-block">
        <h3 class="arch-block-title">🧭 Implementation order</h3>
        <ol>${order.map(o => `<li>${esc(o)}</li>`).join('')}</ol>
      </section>`;
  }

  // ----- MODULE PAGE mode (/changelog/architecture-mX.html) -----
  function renderModulePage(m) {
    return `
      <section class="changelog-head">
        <a href="${archHomeHref()}" class="changelog-back">← Architecture home</a>
        <div class="entry-head">
          <span class="entry-version">${esc(m.id)}</span>
          ${statusBadge(m.status)}
        </div>
        <h2>${esc(m.title)}</h2>
        ${m.summary ? `<p class="changelog-sub">${esc(m.summary)}</p>` : ''}
        <div class="changelog-meta">
          <span id="changelog-role" class="changelog-role"></span>
          <a href="/changelog/admin.html" class="changelog-admin-link">Raw changelog →</a>
        </div>
      </section>
      <div class="changelog-entries">
        <article class="entry">
          ${contractSection(m.expectedInput, 'Expected Input', '⬅️')}
          ${contractSection(m.expectedOutput, 'Expected Output', '➡️')}
          ${detailsHtml(m.details)}
        </article>
      </div>
      ${sectionsHtml(m.sections)}
      ${Array.isArray(m.games) && m.games.length ? renderGamePicker(m) : ''}
      ${renderRules(cache.rules)}
      ${renderOrder(cache.implementationOrder)}
    `;
  }

  // ----- M1 per-game sub-module picker (searchable dropdown) -----
  function renderGamePicker(m) {
    const games = m.games || [];
    return `
      <section class="arch-block" id="game-picker-block">
        <h3 class="arch-block-title">🎮 ${esc(m.id)} game sub-modules</h3>
        <p class="muted-note" style="color:#888;font-size:0.82rem;line-height:1.5;margin:0 0 10px;">This module covers multiple games. Pick a game to see its LOCKED build spec (the build + test benchmark for that game). Select one from the dropdown.</p>
        <div class="game-picker">
          <input type="text" id="game-search" class="game-search" placeholder="Search games (e.g. Ludo, Ayo Olopon)…" autocomplete="off">
          <div class="game-options" id="game-options" role="listbox" aria-label="Games"></div>
        </div>
        <div id="game-spec" class="game-spec"></div>
      </section>
    `;
  }

  function gameSpecHtml(game, moduleId) {
    const locked = game.status === 'locked';
    const badge = locked
      ? `<span class="badge b-status in-progress">LOCKED ${esc(game.lockedAt || '')}</span>`
      : statusBadge(game.status);
    return `
      <article class="entry ${locked ? 'entry-major' : ''}">
        <div class="entry-head">
          <span class="entry-version">${esc(moduleId)} · ${esc(game.title)}</span>
          ${badge}
        </div>
        <h3>${esc(game.title)}</h3>
        ${game.summary ? `<p class="entry-summary">${esc(game.summary)}</p>` : ''}
        ${detailsHtml(game.details)}
      </article>`;
  }

  function initGamePicker(m) {
    const block = qs('#game-picker-block');
    if (!block) return;
    const games = m.games || [];
    const searchEl = qs('#game-search');
    const optionsEl = qs('#game-options');
    const specEl = qs('#game-spec');

    function renderOptions(filter) {
      const q = (filter || '').trim().toLowerCase();
      const matches = games.filter(g =>
        !q || (g.title || '').toLowerCase().includes(q) || (g.gameKey || g.id || '').toLowerCase().includes(q)
      );
      if (!matches.length) {
        optionsEl.innerHTML = `<div class="game-option game-option-empty">No games match "${esc(filter)}"</div>`;
        return;
      }
      optionsEl.innerHTML = matches.map(g => `
        <button type="button" class="game-option" data-game="${esc(g.gameKey || g.id)}" role="option">
          <span class="game-option-title">${esc(g.title)}</span>
          <span class="badge b-status ${esc(g.status)}">${esc(STATUS_LABEL[g.status] || g.status)}</span>
        </button>
      `).join('');
    }

    function selectGame(gameId) {
      const game = games.find(g => (g.gameKey || g.id) === gameId);
      if (!game) return;
      searchEl.value = game.title;
      specEl.innerHTML = gameSpecHtml(game, m.id);
      optionsEl.classList.remove('open');
      // highlight the active option
      optionsEl.querySelectorAll('.game-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.game === gameId);
      });
    }

    searchEl.addEventListener('focus', () => {
      renderOptions('');
      optionsEl.classList.add('open');
    });
    searchEl.addEventListener('input', () => {
      renderOptions(searchEl.value);
      optionsEl.classList.add('open');
    });
    optionsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-game]');
      if (btn) selectGame(btn.dataset.game);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.game-picker')) optionsEl.classList.remove('open');
    });

    // Default: first locked game (or the first game).
    const preferred = games.find(g => g.status === 'locked') || games[0];
    if (preferred) {
      renderOptions('');
      selectGame(preferred.gameKey || preferred.id);
    }
  }

  async function paintOverview() {
    const out = qs('#architecture-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(archJsonUrl());
      const activeTab = 'summary';
      out.dataset.tab = activeTab;
      out.innerHTML = renderOverview(cache, activeTab);
      out.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ov-tab]');
        if (btn) {
          const tab = btn.dataset.ovTab;
          out.dataset.tab = tab;
          out.innerHTML = renderOverview(cache, tab);
        }
      });
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the architecture workspace (${esc(e.message)}).</p>`;
    }
  }

  async function paintModulePage(moduleId) {
    const out = qs('#architecture-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(archJsonUrl());
      const m = (cache.modules || []).find(x => x.id.toLowerCase() === String(moduleId).toLowerCase());
      if (!m) {
        out.innerHTML = `<p class="empty">Module ${esc(moduleId)} not found.</p>`;
        return;
      }
      out.innerHTML = renderModulePage(m);
      if (Array.isArray(m.games) && m.games.length) initGamePicker(m);
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the architecture workspace (${esc(e.message)}).</p>`;
    }
  }

  async function render() {
    const moduleId = (document.body && document.body.dataset.module) || null;
    if (moduleId) {
      await paintModulePage(moduleId);
    } else {
      await paintOverview();
    }
  }

  window.renderArchitecture = render;
})();
