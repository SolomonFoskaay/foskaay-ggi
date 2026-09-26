// public/changelog/economics.js
// Admin-only "Game Economics" workspace renderer.
// Pipeline: raw -> fine-tuned -> ready. Raw = owner's unfiltered thoughts;
// fine-tuned = discussed and shaped; ready = finalized, then promoted into
// the normal changelog roadmap (planned / in-progress).
// Data lives in economics.json (client-served but admin-gated; no unfixed
// security/anti-exploit details go here, per security-queue.md rules).
(function () {
  const ECONOMICS_JSON = '/changelog/economics.json';
  const STAGES = ['raw', 'fine-tuned', 'ready'];
  const STAGE_LABEL = {
    'raw': 'Raw',
    'fine-tuned': 'Fine-tuned',
    'ready': 'Ready to implement'
  };
  const STAGE_NOTE = {
    'raw': 'Raw capture the moment the idea lands. Unfiltered owner thoughts, no shaping yet.',
    'fine-tuned': 'Discussed and shaped into a clear design. Decisions and blind-spots recorded.',
    'ready': 'Finalized. Promote this into the normal changelog roadmap (planned / in-progress) with add-roadmap.mjs or bump-version.mjs.'
  };

  let state = { stage: 'raw' };
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

  function tagChips(tags) {
    if (!Array.isArray(tags) || !tags.length) return '';
    return `<div class="econ-tags">${tags.map(t => `<span class="econ-tag">${esc(t)}</span>`).join('')}</div>`;
  }

  function renderItem(e) {
    const notes = Array.isArray(e.notes) && e.notes.length
      ? `<div class="entry-details"><h4>Notes</h4><ul>${e.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`
      : '';
    return `
      <article class="entry roadmap-entry econ-entry">
        <div class="entry-head">
          <span class="entry-version">econ-${esc(e.id)}</span>
          <span class="badge b-status">${esc(STAGE_LABEL[e.stage] || e.stage)}</span>
          <span class="entry-date">added ${esc(e.added || '')}${e.updated && e.updated !== e.added ? ' · updated ' + esc(e.updated) : ''}</span>
        </div>
        <h3>${esc(e.title)}</h3>
        ${e.summary ? `<p class="entry-summary">${esc(e.summary)}</p>` : ''}
        ${notes}
        ${tagChips(e.tags)}
      </article>`;
  }

  function renderTabs() {
    return `
      <nav class="changelog-tabs econ-tabs" role="tablist" aria-label="Economics pipeline">
        ${STAGES.map(s => `
          <button class="changelog-tab econ-tab ${s === state.stage ? 'active' : ''}"
            role="tab" aria-selected="${s === state.stage}"
            data-stage="${s}">${STAGE_LABEL[s]}</button>
        `).join('')}
      </nav>`;
  }

  async function paint() {
    const out = qs('#economics-items');
    if (!out) return;
    try {
      if (!cache) cache = await loadJson(ECONOMICS_JSON);
      const items = (cache.items || []).filter(i => i.stage === state.stage);
      const updated = cache.updated || '';
      out.innerHTML = `
        ${renderTabs()}
        <p class="admin-note">${esc(STAGE_NOTE[state.stage])}</p>
        <p class="econ-updated">Workspace last updated: ${esc(updated)}</p>
        ${items.length
          ? items.map(renderItem).join('')
          : `<p class="empty">Nothing in "${esc(STAGE_LABEL[state.stage]).toLowerCase()}" right now.</p>`}
      `;
    } catch (e) {
      out.innerHTML = `<p class="empty">Could not load the economics workspace (${esc(e.message)}).</p>`;
    }
  }

  function bind() {
    const out = qs('#economics-items');
    if (!out) return;
    out.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-stage]');
      if (btn) {
        state.stage = btn.dataset.stage;
        paint();
      }
    });
  }

  async function render() {
    bind();
    await paint();
  }

  window.renderEconomics = render;
})();