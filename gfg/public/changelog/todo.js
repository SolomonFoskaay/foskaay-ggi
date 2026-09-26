// public/changelog/todo.js
// Admin "Todo" workspace renderer (the live agent task list, kept short).
//
// Shows:
//   1. CURRENT - the live nested list the agent is working from (owner numbering).
//   2. HISTORY - the most recent 3 archived lists, newest first.
//
// DATA: /changelog/todo.json. The agent refreshes it on every report/commit/push
// (see .opencode/rules/todo-admin.md): it archives the previous current to the
// front of history, keeps at most 10 snapshots, and writes the fresh full list.
// This file is client-served, so it holds task text only, never secrets.
(function () {
  var TODO_JSON = '/changelog/todo.json';
  var cache = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function qs(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }
  async function loadJson(url) {
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
    return res.json();
  }
  function marker(s) {
    if (s === 'done') return '[DONE]';
    if (s === 'in_progress') return '[WORKING]';
    if (s === 'deprecated') return '[DEPRECATED]';
    return '[PENDING]';
  }
  function statusClass(s) {
    if (s === 'done') return 'todo-done';
    if (s === 'in_progress') return 'todo-progress';
    if (s === 'deprecated') return 'todo-deprecated';
    return 'todo-pending';
  }

  function counts(items) {
    var c = { done: 0, in_progress: 0, pending: 0, deprecated: 0 };
    (items || []).forEach(function (it) { if (c[it.s] != null) c[it.s]++; });
    return c;
  }

  function listHtml(items) {
    var rows = (items || []).map(function (it) {
      var raw = String(it.t || '');
      var indent = (/^\s*/.exec(raw) || [''])[0].length;
      return '<li class="todo-item ' + statusClass(it.s) + '" data-s="' + esc(it.s) + '"'
        + ' style="padding-left:' + (indent * 6) + 'px">'
        + '<span class="todo-mark">' + esc(marker(it.s)) + '</span>'
        + '<span class="todo-text">' + esc(raw.trim()) + '</span></li>';
    }).join('');
    return '<ul class="todo-list">' + rows + '</ul>';
  }

  function summaryHtml(items) {
    var c = counts(items);
    return '<div class="todo-summary">'
      + '<span class="todo-chip todo-done">' + c.done + ' DONE</span>'
      + '<span class="todo-chip todo-progress">' + c.in_progress + ' WORKING</span>'
      + '<span class="todo-chip todo-pending">' + c.pending + ' PENDING</span>'
      + (c.deprecated ? '<span class="todo-chip todo-deprecated">' + c.deprecated + ' DEPRECATED</span>' : '')
      + '</div>';
  }

  // Plain-terms notes block (migration status, what to test, chain audit).
  function notesHtml(data) {
    var blocks = [];
    if (data.migrationNote) {
      blocks.push('<p class="todo-note-lead">' + esc(data.migrationNote) + '</p>');
    }
    function section(title, obj) {
      if (!obj || typeof obj !== 'object') return '';
      var rows = Object.keys(obj).map(function (k) {
        return '<div class="todo-note-row"><div class="todo-note-k">' + esc(k) + '</div><div class="todo-note-v">' + esc(obj[k]) + '</div></div>';
      }).join('');
      return '<h4 class="todo-note-h">' + esc(title) + '</h4>' + rows;
    }
    blocks.push(section('Batch status, in plain terms', data.testNotes));
    blocks.push(section('Chain audit (what is on Arc, what is left on Solana)', data.chainAudit));
    if (!blocks.length) return '';
    return '<section class="game-card todo-notes">' + blocks.join('') + '</section>';
  }

  function currentHtml(cur) {
    if (!cur) return '<p class="empty">No todo list published yet.</p>';
    return '<section class="game-card todo-current">'
      + '<div class="todo-head">'
      + '<h3>' + esc(cur.title || 'Current todo list') + '</h3>'
      + '<span class="todo-when">updated ' + esc(cur.updated || '') + '</span>'
      + '</div>'
      + summaryHtml(cur.items)
      + listHtml(cur.items)
      + '</section>';
  }

  function historyHtml(hist) {
    if (!Array.isArray(hist) || !hist.length) {
      return '<section class="game-card"><h3>Recent lists</h3>'
        + '<p class="empty">No archived lists yet. The last 10 snapshots will appear here as new lists are posted.</p></section>';
    }
    var blocks = hist.map(function (h, i) {
      return '<details class="todo-archive"' + (i === 0 ? ' open' : '') + '>'
        + '<summary>' + esc(h.title || ('Snapshot ' + (i + 1))) + ' <span class="todo-when">' + esc(h.updated || '') + '</span></summary>'
        + summaryHtml(h.items)
        + listHtml(h.items)
        + '</details>';
    }).join('');
    return '<section class="game-card"><h3>Recent lists</h3>'
      + '<p style="color:var(--muted); font-size:0.84rem; line-height:1.55;">The last 10 archived lists, newest first. Older snapshots are dropped so this file never grows without bound.</p>'
      + blocks + '</section>';
  }

  async function renderTodo() {
    var host = document.getElementById('todo-items');
    if (!host) return;
    try {
      cache = cache || await loadJson(TODO_JSON);
    } catch (e) {
      host.innerHTML = '<p class="empty">Could not load todo.json (' + esc(e.message) + ').</p>';
      return;
    }
    host.innerHTML = notesHtml(cache) + currentHtml(cache.current) + historyHtml(cache.history);
  }

  window.renderTodo = renderTodo;
})();
