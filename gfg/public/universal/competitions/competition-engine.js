// public/universal/competitions/competition-engine.js
// M7 — EARN COMPETITION ENGINE (universal, game-agnostic, R17/R18).
//
// Listens on the SAME M2 seam (window.onGameResult) the rewards use, and for
// every OPEN competition whose games[] includes the finished game and whose
// window is live ([starts_at, ends_at]) it records the verified win to the
// server-side window-fresh ledger (proof sig kept, so every row is checkable).
// Final Points (Total x live plan boost: L2 1.25x, L3 1.5x, L1 1.0x;
// non-qualifying levels hidden, never removed)
// are computed server-side at board time — the admin settles from that board.
//
// Emits window.gfgCompetitions:
//   refresh()/list() -> all on-chain competition instances
//   active()        -> open though not started/ended
//   live()          -> currently-open windows
//   enter(comp)     -> gate (any-of tier_bits) + spendable entry + ledger entry
//   board(creator,seq) -> {board:[{position,wallet,totalPoints,finalPoints,...}], hidden:[...]}
//   subscribe(cb)
(function () {
    'use strict';
    if (window.gfgCompetitions) return;
    window.gfgCompetitions = {};

    var TAG_TO_SOURCE = { ludo: 1, ayo_olopon: 2 }; // M1 source-code registry (add games here as they ship)
    var SOURCE_TO_TAG = { 1: 'ludo', 2: 'ayo_olopon' };
    var subs = [];
    var cache = null; // { competitions: [] }
    var ENTERED_KEY = 'gfg_comp_entered_v1';
    function enteredSet() { try { return JSON.parse(localStorage.getItem(ENTERED_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function markEntered(comp) { try { var m = enteredSet(); m[(comp.creator || '') + ':' + comp.seq] = 1; localStorage.setItem(ENTERED_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ } }
    function isEntered(comp) { return !!(enteredSet()[(comp.creator || '') + ':' + comp.seq]); }

    function wallet() {
        try {
            var w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
            if (!w && window.currentProfile && window.currentProfile.solana_wallet) w = window.currentProfile.solana_wallet;
            if (!w) return null;
            return (typeof w === 'string') ? w : (w.address || String(w));
        } catch (e) { return null; }
    }
    function currentLevel() {
        try {
            var a = (window.activeTier && typeof window.activeTier.get === 'function') ? window.activeTier.get() : null;
            if (a && a.level) return a.level;
            var p = (window.premiumPoints && typeof window.premiumPoints.get === 'function') ? window.premiumPoints.get() : null;
            var lvl = Number(p && p.subscriptionLevel ? p.subscriptionLevel : 0);
            return (lvl > 0 && Number(p.subscriptionActiveUntil || 0) > Date.now()) ? lvl : 0;
        } catch (e) { return 0; }
    }
    function tierOk(comp) {
        var lvl = currentLevel();
        return lvl > 0 && !!(comp.tierBits & (1 << lvl));
    }

    function isArc() {
        try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; }
    }

    async function refresh() {
        // ARC (arcv2m17 audit): the competition LIFECYCLE is not yet on Arc
        // (module (6) is pending), and /api/competitions is the Solana relay.
        // Do NOT call it on Arc: that was a Solana read fired at module load on
        // every page. Competitions simply read as empty on Arc until (6) ships.
        if (isArc()) { cache = []; return; }
        try {
            const r = await fetch('/api/competitions', { cache: 'no-store' });
            const j = await r.json();
            if (j && Array.isArray(j.competitions)) cache = j.competitions;
        } catch (e) { /* cached */ }
        notify();
        return cache || [];
    }
    async function list() { if (!cache) await refresh(); return cache || []; }
    function active() { return (cache || []).filter(c => c.status === 0); }
    function live() {
        var now = Date.now();
        return active().filter(c => now >= c.startsAt * 1000 && now <= c.endsAt * 1000);
    }

    async function board(creator, seq) {
        if (isArc()) return null; // Solana relay; competitions are off on Arc until (6)
        const r = await fetch('/api/competitions?seq=' + seq + '&board=1' + (creator ? '&creator=' + encodeURIComponent(creator) : ''), { cache: 'no-store' });
        return (await r.json()) || null;
    }

    async function enter(comp) {
        if (isArc()) return { ok: false, error: 'not-on-arc-yet' }; // (6) pending
        var w = wallet();
        if (!w) return { ok: false, error: 'signin' };
        if (!tierOk(comp)) return { ok: false, error: 'tier' };
        // spend_ref is a u64 on-chain: use a deterministic numeric hash of the
        // (competition, wallet) pair so it never collides per window/wallet.
        var refStr = 'comp|' + (comp.creator || '') + '|' + comp.seq + '|' + w;
        var hv = 0x811c9dc5;
        for (var qi = 0; qi < refStr.length; qi++) { hv ^= refStr.charCodeAt(qi); hv = Math.imul(hv, 0x01000193) >>> 0; }
        var ref = (hv % 2147483647) || 1;
        var fam = comp.entryFamilies || 0;
        var tried = [];
        var order = [1, 4, 2]; // global, premium, local
        for (var i = 0; i < order.length; i++) {
            var bit = order[i];
            if (!(fam & bit)) continue;
            tried.push(bit === 1 ? 'global' : bit === 4 ? 'premium' : 'local');
            var sig = null;
            try {
                if (bit === 1 && window.globalLedger && typeof window.globalLedger.spend === 'function') sig = await window.globalLedger.spend(comp.entryCost, 30, ref);
                else if (bit === 4 && window.premiumPoints && typeof window.premiumPoints.spend === 'function') sig = await window.premiumPoints.spend(comp.entryCost, 30, ref);
                else if (bit === 2 && window.localPoints && typeof window.localPoints.spend === 'function') sig = await window.localPoints.spend(comp.entryCost, 30, ref);
            } catch (e) { sig = null; }
            if (sig) {
                markEntered(comp); // board counts only users who ENTERED
                try {
                    await fetch('/api/competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enter', creator: comp.creator || null, seq: comp.seq, wallet: w }) });
                } catch (e) { /* advisory */ }
                // create the on-chain tally so the entrant appears on the board
                // instantly (ranked 0 until they win inside the window).
                try {
                    await fetch('/api/competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ensure', creator: comp.creator || null, seq: comp.seq, wallet: w }) });
                } catch (e) { /* advisory */ }
                return { ok: true };
            }
        }
        return { ok: false, error: 'insufficient', tried: tried, cost: comp.entryCost };
    }

    // Record a finished match to live windows (M2 seam, once).
    function onFinish(env) {
        try {
            if (isArc()) return; // Solana relay; competition lifecycle is (6), pending
            if (!env || env.schema !== 'gfg:game-result@1') return;
            var w = wallet();
            if (!w) return;
            var gameCode = TAG_TO_SOURCE[env.gameId];
            if (!gameCode) return;
            var proofSig = env.proof && env.proof.signature;
            if (!proofSig) return;
            var ts = Math.floor((env.finishedAt || Date.now()) / 1000);
            var windows = (cache || []).filter(function (c) {
                return c.status === 0 && (c.games || []).indexOf(gameCode) !== -1 && ts >= c.startsAt && ts <= c.endsAt && isEntered(c);
            });
            windows.forEach(function (c) {
                // H: relay signs the win ON-CHAIN (durable on serverless; tally [gfgwin, comp, player]).
                fetch('/api/competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'record', creator: c.creator || null, seq: c.seq, wallet: w, ts: ts, game: env.gameId, proofSig: proofSig }) }).catch(function () {});
            });
        } catch (e) { /* ignore */ }
    }

    function subscribe(cb) { if (typeof cb === 'function') subs.push(cb); return function () { subs = subs.filter(x => x !== cb); }; }
    function notify() { subs.slice().forEach(function (cb) { try { cb(cache); } catch (e) {} }); }

    window.gfgCompetitions = {
        refresh, list, active, live, board, enter, subscribe, isEntered,
        tierOk, currentLevel, wallet,
        sourceCodeFor: function (tag) { return TAG_TO_SOURCE[tag]; },
        sourceTagFor: function (code) { return SOURCE_TO_TAG[code]; },
    };

    if (window.onGameResult) window.onGameResult(onFinish);
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:game-result', function (e) { onFinish(e && e.detail); });
        window.addEventListener('gfg:auth-changed', function () { cache = null; refresh(); });
    }
    refresh();
})();