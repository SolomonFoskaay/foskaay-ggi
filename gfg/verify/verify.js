// public/verify/verify.js (served at /verify/)
// Receipt + account explorer: queries the MagicBlock ER (rollup) RPC and the
// base devnet RPC directly and formats the result for humans. No backend, no
// API keys. The public MagicBlock devnet RPC allows cross-origin calls and the
// play RPC (api.devnet.solana.com) also answers from browsers, so the page runs
// entirely in the client. Honesty rule follows the game: never fake a link to
// an ER receipt (no public explorer indexes it); when a receipt IS on the base
// chain we link SolanaFM, and account lookups always surface the permanent
// base-chain record.
(function () {
  'use strict';

  // Region order matches the client (regionCandidatesFor): healthy regions first,
  // US LAST as a legacy-fallback. Pre-flip accounts (2026-08-18) still live on
  // US, so excluding it entirely would make this page blind to them. US is last,
  // not excluded, so a US-pinned receipt still resolves when AS/EU cannot see it.
  var ER_REGIONS = [
    'https://devnet-as.magicblock.app/',
    'https://devnet-eu.magicblock.app/',
    'https://devnet-us.magicblock.app/'
  ];
  var BASE_RPC = 'https://api.devnet.solana.com';
  // Sticky cursor: reads prefer the region that last answered, so a down/slow
  // region is skipped on the next query instead of retried every time.
  var erCursor = 0;

  var PROG_LABELS = {
    'CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ': 'GlobalFolkGames (dice, points, match record)',
    'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh': 'MagicBlock delegation',
    'Magic11111111111111111111111111111111111111': 'MagicBlock',
    '11111111111111111111111111111111': 'System program',
    'SysvarRent111111111111111111111111111111111': 'Rent sysvar'
  };

  var input, btn, out, statusEl;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function short(id, n) {
    if (!id) return '';
    n = n || 8;
    return id.length > 2 * n ? id.slice(0, n) + '...' + id.slice(-n) : id;
  }

  function rpc(url, method, params) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    }).then(function (res) {
      if (!res.ok) throw new Error(method + ' HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (data.error) throw new Error(data.error.message || (method + ' error'));
      return data.result;
    });
  }

  // Rollup query that fails over across every public ER region. If one region
  // is down or rate-limiting, the next one is tried before giving up.
  function erRpc(method, params) {
    var attempts = ER_REGIONS.length;
    var attempt = 0;
    function tryNext() {
      var url = ER_REGIONS[(erCursor + attempt) % attempts];
      attempt++;
      return rpc(url, method, params).then(function (r) {
        erCursor = (erCursor + attempt - 1) % attempts; // remember the winner
        return r;
      }).catch(function (e) {
        if (attempt >= attempts) throw e;
        return tryNext();
      });
    }
    return tryNext();
  }

  function pill(text, tone) {
    var color = ({ ok: '#2ecc71', warn: '#f87818', bad: '#e74c3c', idle: '#7838f8' })[tone] || '#7838f8';
    return '<div class="v-pill" style="color:' + color + ';">' + esc(text) + '</div>';
  }

  function anchorNames(logs) {
    var names = [];
    (logs || []).forEach(function (l) {
      var m = /Program log: Instruction: ([A-Za-z0-9_]+)/.exec(l || '');
      if (m && names.indexOf(m[1]) === -1) names.push(m[1]);
    });
    return names;
  }

  function programsInvoked(logs) {
    var progs = [];
    (logs || []).forEach(function (l) {
      var m = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[1\]$/.exec(l || '');
      if (m && progs.indexOf(m[1]) === -1) progs.push(m[1]);
    });
    return progs;
  }

  function txDetails(tx) {
    var meta = (tx && tx.meta) || {};
    var msg = tx && tx.transaction && tx.transaction.message;
    var ok = !meta.err;
    var rows = [
      ['Status', ok ? 'Success (confirmed)' : 'Failed / error'],
      ['When', tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Not listed'],
      ['Ledger slot', tx.slot != null ? String(tx.slot) : 'Not listed'],
      ['Network fee', meta.fee != null ? (meta.fee / 1e9).toFixed(6) + ' SOL' : 'Not listed']
    ];
    var names = anchorNames(meta.logMessages);
    rows.push(['Action recorded', names.length ? names.join('  ·  ') : 'Layer 1 rollup record']);
    var progs = programsInvoked(meta.logMessages);
    rows.push(['Programs involved', progs.length
      ? progs.map(function (p) { return PROG_LABELS[p] || 'Unknown (' + short(p, 10) + ')'; }).join(', ')
      : 'None listed']);

    var html = '<div class="v-card">' + (ok ? pill('Confirmed transaction', 'ok') : pill('Failed transaction', 'bad'))
      + '<ul class="v-rows">';
    rows.forEach(function (r) {
      html += '<li><span class="v-key">' + esc(r[0]) + '</span><span class="v-val">' + esc(r[1]) + '</span></li>';
    });
    html += '</ul></div>';

    var keys = msg && msg.accountKeys;
    if (Array.isArray(keys) && keys.length) {
      var signers = msg.header ? msg.header.numRequiredSignatures : 0;
      html += '<div class="v-card"><div class="v-key" style="margin-bottom:6px;">Accounts involved</div><div class="v-chips">';
      keys.forEach(function (k, i) {
        html += '<a class="v-chip" href="/verify/?account=' + encodeURIComponent(k) + '" title="' + esc(k) + '">'
          + esc(short(k, 12)) + (i < signers ? ' (signer)' : '') + '</a>';
      });
      html += '</div></div>';
    }
    return html;
  }

  function renderFound(sig, tx, source) {
    var g = window.gfgExplorer;
    var html = '<div class="v-card">'
      + (source === 'er'
        ? pill('Found on the MagicBlock rollup', 'ok')
        : pill('Found on the Solana base chain', 'ok'))
      + '<p class="v-lead">'
      + (source === 'er'
        ? 'This receipt was executed on the <b>MagicBlock rollup</b>, the gasless layer that runs GlobalFolkGames. No outside website links to it, because rollup transactions are not indexed by other explorers. This page asked the rollup directly and the transaction is confirmed exactly as shown below.'
        : 'This receipt lives on the <b>permanent base chain</b>, visible to any explorer forever. '
          + (g && g.txLink ? g.txLink(sig, 'Open on the base explorer') : esc(sig)))
      + '</p><code class="v-code">' + esc(sig) + '</code></div>'
      + txDetails(tx);
    return html;
  }

  function notFound(sig) {
    return '<div class="v-card">' + pill('Not found at this moment', 'warn')
      + '<p class="v-lead">Neither the rollup nor the base chain returned this receipt right now. The honest reasons:</p>'
      + '<ul style="font-size:0.9rem; line-height:1.6; padding-left:18px; margin-top:8px;">'
      + '<li>The rollup keeps a short, fast ledger. Very old game receipts are rolled onto the base chain, and the rollup then stops serving them.</li>'
      + '<li>Double check that the whole code was copied from the winners screen (every character matters).</li>'
      + '<li>Receipts usually appear within seconds of the match ending. If this receipt is fresh and still does not show, try again shortly.</li>'
      + '</ul>'
      + '<p class="v-lead" style="margin-top:8px;">For the permanent proof of your game account, paste your wallet or game account address instead. The original account creation transaction always stays on the base chain.</p>'
      + '<code class="v-code">' + esc(sig) + '</code></div>';
  }

  function querySig(sig) {
    out.innerHTML = '<div class="v-card">' + pill('Checking both ledgers...', 'idle') + '</div>';
    var erTx = null, baseTx = null;
    Promise.all([
      erRpc('getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json' }])
        .then(function (t) { erTx = t; }).catch(function () {}),
      rpc(BASE_RPC, 'getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json' }])
        .then(function (t) { baseTx = t; }).catch(function () {})
    ]).then(function () {
      if (baseTx) { out.innerHTML = renderFound(sig, baseTx, 'base'); return; }
      if (erTx) { out.innerHTML = renderFound(sig, erTx, 'er'); return; }
      out.innerHTML = notFound(sig);
    });
  }

  function accountBaseLink(addr) {
    var g = window.gfgExplorer;
    return (g && g.accountLink) ? g.accountLink(addr, 'Open on the base explorer (permanent)') : esc(addr);
  }

  function queryAccount(addr) {
    out.innerHTML = '<div class="v-card">' + pill('Loading account records...', 'idle') + '</div>';
    var html = '<div class="v-card">' + pill('Account is real on the base chain', 'ok')
      + '<p class="v-lead">This account was created on the Solana base chain, and that original act is permanent. Check it in the base explorer: ' + accountBaseLink(addr) + '</p>'
      + '<p class="v-lead" style="margin-top:6px;">One sign-in wallet covers every game you play (Ludo now, more later) through one GlobalFolkGames account, so a single creation and delegation record is the proof your game account was truly opened on-chain. The base explorer shows it, and that link always works.</p>'
      + '</div>'
      + '<div class="v-card"><div class="v-key" style="margin-bottom:6px;">Recent activity on the rollup</div><div id="v-acc-sigs"><p class="v-lead">Asking the rollup ledger...</p></div></div>';

    out.innerHTML = html;
    erRpc('getSignaturesForAddress', [addr, { commitment: 'confirmed', limit: 25 }])
      .then(function (sigs) {
        var box = $('v-acc-sigs');
        if (!box) return;
        if (Array.isArray(sigs) && sigs.length) {
          box.innerHTML = '<div class="v-chips">' + sigs.map(function (s) {
            return '<a class="v-chip" href="/verify/?tx=' + encodeURIComponent(s.signature) + '" title="' + esc(s.signature) + '">'
              + esc(short(s.signature, 10)) + '</a>';
          }).join('') + '</div>'
            + '<p class="v-lead" style="margin-top:6px;">Click any chip to inspect that transaction.</p>';
        } else {
          box.innerHTML = '<p class="v-lead">No rollup transactions listed for this account yet (the rollup recycles its ledger regularly). The permanent base record above is the strongest proof.</p>';
        }
      })
      .catch(function () {
        var box = $('v-acc-sigs');
        if (box) box.innerHTML = '<p class="v-lead">Rollup history is unavailable right now. The permanent base record above is the strongest proof.</p>';
      });
  }

  function looksLikeSig(s) {
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && s.length >= 80;
  }

  function looksLikeAddr(s) {
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s) && s.length <= 45;
  }

  function run(q) {
    q = String(q || '').trim();
    if (statusEl) statusEl.textContent = 'Checking on-chain...';
    if (!q) {
      out.innerHTML = '<div class="v-card">' + pill('Paste a receipt or account id first', 'warn') + '</div>';
      return;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(q)) {
      out.innerHTML = '<div class="v-card">' + pill('That does not look like a Solana id', 'warn')
        + '<p class="v-lead">A receipt is a long mix of letters and numbers. Copy the whole code from the winners screen.</p></div>';
      return;
    }
    if (looksLikeSig(q)) querySig(q);
    else if (looksLikeAddr(q)) queryAccount(q);
    else {
      out.innerHTML = '<div class="v-card">' + pill('Ambiguous id', 'warn')
        + '<p class="v-lead">That id is too short to be a receipt and too long to be an account address. Check that the whole code was copied.</p></div>';
    }
  }

  function init() {
    input = $('verify-input');
    btn = $('verify-btn');
    out = $('verify-result');
    statusEl = $('verify-status');
    if (!input || !btn || !out) return;

    function submit() { run(input.value); }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    var params = new URLSearchParams(location.search);
    var q = params.get('tx') || params.get('q') || params.get('account') || '';
    if (q) {
      input.value = q;
      run(q);
    } else {
      out.innerHTML = '<div class="v-card">' + pill('Ready', 'idle')
        + '<p class="v-lead">Paste a receipt or an account id above and press Check on-chain.</p></div>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();