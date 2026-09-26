// public/changelog/research.js
// Admin-only "Research" workspace renderer (pre-architecture explorations).
//
// Purpose: hold research BEFORE it becomes a module in architecture.json, so the
// owner can read it on mobile and re-check it later (for example the Arc
// migration and the earned-cards idea). Adding a research entry is a decision:
// the agent asks first. See .opencode/rules/research.md.
//
// Two render modes on ONE page:
//   1. OVERVIEW (/changelog/tests.html): the list of research items.
//   2. ITEM (/changelog/tests.html?r=arc): one item's full write-up.
//
// Mobile: every table is wrapped in a horizontally scrollable container with a
// min-width, so wide tables scroll INSIDE the card and never push the page
// wider than the viewport.
(function () {
  const TESTS_JSON = '/changelog/tests.json';
  let cache = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function qs(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }
  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }
  function statusBadge(status, legend) {
    const label = (legend && legend[status]) || status || '';
    return `<span class="badge b-status planned">${esc(status)}</span>`;
  }

  function tableHtml(t) {
    if (!t || !Array.isArray(t.headers) || !t.headers.length) return '';
    const head = t.headers.map((h) => `<th>${esc(h)}</th>`).join('');
    const body = (t.rows || []).map((row) =>
      `<tr>${(row || []).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
    // Wrapper: horizontal scroll on small screens, never overflows the card.
    return `<div class="research-table-wrap"><table class="research-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function sectionHtml(s) {
    let html = `<h4 class="research-h4">${esc(s.heading)}</h4>`;
    (s.paragraphs || []).forEach((p) => { html += `<p class="research-p">${esc(p)}</p>`; });
    if (Array.isArray(s.bullets) && s.bullets.length) {
      html += `<ul class="research-list">${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
    }
    html += tableHtml(s.table);
    return html;
  }

  function itemHtml(item, legend) {
    const sections = (item.sections || []).map(sectionHtml).join('');
    return `
      <article class="entry roadmap-entry econ-entry research-entry" style="margin-bottom:16px;">
        <div class="entry-head">
          <span class="entry-version" style="font-size:0.9rem;">tests/${esc(item.id)}</span>
          ${statusBadge(item.status, legend)}
          <span style="font-size:0.78rem; color:#888;">updated ${esc(item.updated || '')}</span>
        </div>
        <h3>${esc(item.title)}</h3>
        ${item.summary ? `<p class="entry-summary">${esc(item.summary)}</p>` : ''}
        ${item.decision ? `<p class="research-decision">${esc(item.decision)}</p>` : ''}
        <div class="research-body">${sections}</div>
      </article>`;
  }

  function overviewHtml(data) {
    const legend = data.statusLegend || {};
    const cards = (data.items || []).map((item) => `
      <a class="research-card" href="/changelog/tests.html?r=${encodeURIComponent(item.id)}">
        <div class="research-card-head">
          <span class="entry-version" style="font-size:0.9rem;">tests/${esc(item.id)}</span>
          ${statusBadge(item.status, legend)}
        </div>
        <h3 class="research-card-title">${esc(item.title)}</h3>
        <p class="research-card-summary">${esc(item.summary || '')}</p>
        <span class="research-card-open">Open →</span>
      </a>`).join('');
    const legendRows = Object.keys(legend).map((k) => `<li><b>${esc(k)}</b>: ${esc(legend[k])}</li>`).join('');
    return `
      <section class="game-card" style="margin-bottom:16px;">
        <h3>Test results</h3>
        <p style="color:var(--muted); font-size:0.86rem; line-height:1.6;">${esc(data.note || '')}</p>
      </section>
      <div class="research-grid">${cards || '<p class="empty">No research entries yet.</p>'}</div>
      <section class="game-card" style="margin-top:16px;">
        <h3>Status legend</h3>
        <ul class="research-list">${legendRows}</ul>
      </section>`;
  }

  async function renderTests() {
    const host = document.getElementById('tests-items');
    if (!host) return;
    try {
      cache = cache || await loadJson(TESTS_JSON);
    } catch (e) {
      host.innerHTML = '<p class="empty">Could not load research.json (' + esc(e.message) + ').</p>';
      return;
    }
    const id = (qs('r') || '').toLowerCase();
    const item = id ? (cache.items || []).find((x) => String(x.id).toLowerCase() === id) : null;
    if (id && !item) {
      host.innerHTML = '<p class="empty">Unknown research id "' + esc(id) + '". <a href="/changelog/tests.html" style="color:#f87818;">Back to all research</a>.</p>';
      return;
    }
    if (item) {
      host.innerHTML = `<p style="margin:0 0 12px;"><a href="/changelog/tests.html" style="color:#f87818;">← All research</a></p>` + itemHtml(item, cache.statusLegend);
      document.title = item.title + ' | Research | GlobalFolkGames';
    } else {
      host.innerHTML = overviewHtml(cache);
    }
  }

  window.renderTests = renderTests;
})();
