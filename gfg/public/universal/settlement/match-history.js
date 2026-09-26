// public/universal/settlement/match-history.js
// arcv2m17 — GFG-BS MATCH HISTORY (universal, GAME-AGNOSTIC, FREE to read).
//
// Shows a player's past matches on the game page, each with clickable explorer
// links for the START and the END, so there is never doubt the game is on-chain.
//
// COST: ZERO. Reading chain events (eth_getLogs) is a free read-only RPC call,
// no gas and no USDC, so history can show as many games as the RPC allows. The
// only limit is the RPC's block-range cap, so this paginates backwards.
//
// DATA SOURCE: the MatchSettlement contract's own events (MatchStarted /
// MatchSettled). No off-chain store, no indexer, no database.
//
// GAME-AGNOSTIC: it filters by the connected wallet, not by game, so ANY game
// reuses it. A game only needs to render a container with [data-gfg-match-history].
(function () {
    'use strict';

    var CONFIG_URL = '/arc-config.json';
    var API = '/api/arc';
    var DEFAULT_LIMIT = 10;      // last N games (free reads, safe default)
    var MAX_LIMIT = 50;          // cap for "load more" (still free)
    var cache = null;

    function isArc() { try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; } }
    function wallet() {
        try {
            var a = window.gfgChainAdapter;
            var w = (a && a.walletAddress && a.walletAddress()) || null;
            if (w) return String(w);
        } catch (e) { /* ignore */ }
        try { if (window.getDynamicEvmWallet) { var x = window.getDynamicEvmWallet(); if (x) return String(x); } } catch (e) { /* ignore */ }
        return null;
    }
    function explorer() {
        try { if (cache && cache.explorer) return cache.explorer; } catch (e) { /* ignore */ }
        return 'https://explorer.testnet.arc.io';
    }
    async function config() {
        if (cache) return cache;
        try { cache = (await (await fetch(CONFIG_URL, { cache: 'no-store' })).json()).rails.evm; } catch (e) { cache = null; }
        return cache;
    }

    // Ask the relayer to read the match events (server-side keeps the browser
    // thin and avoids per-RPC-range issues). The relayer returns already-filtered
    // rows for the connected player.
    async function load(player, limit) {
        var body = JSON.stringify({ action: 'matchHistory', params: { player: player, limit: limit || DEFAULT_LIMIT } });
        var res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
        var j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || ('history ' + res.status));
        return j.matches || [];
    }

    function short(h) { return h ? (String(h).slice(0, 10) + '…' + String(h).slice(-6)) : ''; }
    function when(ts) { try { return new Date(Number(ts) * 1000).toLocaleString(); } catch (e) { return ''; } }

    function render(rows, host, player) {
        if (!host) return;
        if (!rows.length) {
            host.innerHTML = '<div class="gfg-mh-empty">No matches yet. Play a game and it will appear here with a start link, and a chain link once the batch window flushes.</div>';
            return;
        }
        var html = '<div class="gfg-mh-title">Your on-chain matches (newest first)</div><div class="gfg-mh-list">';
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var startTx = r.startTx ? '<a class="gfg-mh-link" target="_blank" rel="noopener" href="' + explorer() + '/tx/' + r.startTx + '">start tx</a>' : '';
            // A settled match is final on-chain only when the window flushes. Before
            // that we show an honest "pending flush" (app receipt is instant, the
            // chain stamp lands at window close). The end link appears once flushed.
            var endTx = r.settleTx ? '<a class="gfg-mh-link" target="_blank" rel="noopener" href="' + explorer() + '/tx/' + r.settleTx + '">end tx</a>' : '';
            var status, statusClass;
            if (!r.settled) { status = 'playing'; statusClass = 'open'; }
            else if (r.disputed) { status = 'disputed'; statusClass = 'disputed'; }
            else if (r.flushState === 'pending flush') { status = 'pending flush'; statusClass = 'open'; }
            else { status = 'settled'; statusClass = 'settled'; }
            html += '<div class="gfg-mh-row">'
                + '<span class="gfg-mh-game">' + (r.gameTag != null ? '(game ' + r.gameTag + ')' : '') + '</span>'
                + '<span class="gfg-mh-status gfg-mh-' + statusClass + '">' + status + '</span>'
                + '<span class="gfg-mh-time">' + when(r.startedAt) + '</span>'
                + '<span class="gfg-mh-moves">' + (r.moveCount || 0) + ' moves</span>'
                + '<span class="gfg-mh-links">' + startTx + endTx + '</span>'
                + '</div>';
        }
        html += '</div>';
        html += '<div class="gfg-mh-note">Every match has an on-chain beginning (start tx) and is written to the chain at window close (end tx). Matches batched together share one flush transaction, so your end tx may be the same block as other players. Reads are free, so this list costs nothing.</div>';
        host.innerHTML = html;
    }

    async function refresh(hostEl) {
        if (!isArc()) return;
        var host = hostEl || document.querySelector('[data-gfg-match-history]');
        if (!host) return;
        var p = wallet();
        if (!p) return;
        await config();
        try {
            var rows = await load(p, Number(host.getAttribute('data-gfg-limit')) || DEFAULT_LIMIT);
            render(rows, host, p);
        } catch (e) {
            console.warn('[match-history] soft-fail:', e && e.message);
            host.innerHTML = '<div class="gfg-mh-empty">Match history is unavailable right now. Your games are still on-chain; try again shortly.</div>';
        }
    }

    window.gfgMatchHistory = {
        isEnabled: isArc,
        refresh: refresh,
        load: load,
        limit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
    };

    // Auto-render on any page that has the container, once signed in.
    function boot() {
        if (typeof window.addEventListener !== 'function') return;
        window.addEventListener('load', function () { setTimeout(function () { refresh(); }, 1200); });
        window.addEventListener('gfg:auth-changed', function () { setTimeout(function () { refresh(); }, 1200); });
    }
    boot();
})();
