// public/universal/lives/daily-reward.js
// M10 — DAILY REWARD MODULE (universal, game-agnostic half of M10).
//
// One claim per GMT+00 day, signed-in required. Banks the reward as a
// kind=1 credit into the M4 global ledger via window.globalLedger.credit()
// with source_code 14 (daily_reward) — M4b lifetime + M4c spendable only,
// never M3 and never M4a pure (the M4 module contract for kind=1).
//
// Boosts with an active subscription: free = 25P/day, Level-2 subscriber =
// 200P/day. A claim is per-wallet-per-day and is enforced locally (the ledger
// read-back after the write is the final idempotence check).
//
// Consumes: M5 window.activeTier.get() (reward size), M4 window.globalLedger.
// credit() (the bank). Emits: window.gfgDaily = { get(), claim(), subscribe(cb) }.
// DOM slots (any page): [data-daily-amount], [data-daily-claimed].
(function () {
    var CACHE_KEY = 'gfg_daily_cache_v1';

    var FREE_REWARD = 25;
    var PREMIUM_REWARD = 50;    // L1
    var LEVEL3_REWARD = 100;    // L2
    var LEVEL4_REWARD = 200;    // L3 daily reward (M5 ladder 2026-08-31)
    var DAILY_REASON = 6; // daily_reward reason tag (WIN_* are 1..3, tier_boost is 5)

    var store = {};
    try {
        store = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}') || {};
    } catch (e) { store = {}; }

    var subscribers = [];
    var claiming = false;

    // ---- identity --------------------------------------------------------
    function isArc() {
        try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; }
    }
    function evmAddress() {
        try {
            var a = window.gfgChainAdapter;
            var w = (a && a.walletAddress && a.walletAddress()) || null;
            if (w) return String(w);
        } catch (e) { /* ignore */ }
        try { if (window.getDynamicEvmWallet) { var x = window.getDynamicEvmWallet(); if (x) return String(x); } } catch (e) { /* ignore */ }
        return null;
    }
    function readAddress() {
        try { if (isArc()) { var e = evmAddress(); if (e) return e; } } catch (err) { /* ignore */ }
        var addr = null;
        try {
            if (window.getDynamicSolanaWallet) {
                var w = window.getDynamicSolanaWallet();
                if (w && typeof w === 'string') addr = w;
                else if (w && w.address) addr = String(w.address);
            }
        } catch (e) { /* ignore */ }
        if (!addr) {
            try {
                if (window.currentProfile && window.currentProfile.solana_wallet) addr = String(window.currentProfile.solana_wallet);
            } catch (e) { /* ignore */ }
        }
        return addr;
    }

    function walletKey() {
        try {
            if (isArc()) { var e = evmAddress(); if (e) return e.toLowerCase(); }
        } catch (err) { /* ignore */ }
        try {
            if (window.getDynamicSolanaWallet) {
                var w = window.getDynamicSolanaWallet();
                if (w && typeof w === 'string') return w.toLowerCase();
                if (w && w.address) return String(w.address).toLowerCase();
            }
            if (window.currentProfile && window.currentProfile.solana_wallet) {
                return String(window.currentProfile.solana_wallet).toLowerCase();
            }
        } catch (e) { /* ignore */ }
        return 'anon';
    }

    // ---- time helpers -----------------------------------------------------
    function utcDayKey() {
        var d = new Date();
        return d.getUTCFullYear() + '-' +
            String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
            String(d.getUTCDate()).padStart(2, '0');
    }

    // ---- subscription boost -------------------------------------------------
    function activeView() {
        try {
            if (window.activeTier && typeof window.activeTier.get === 'function') {
                return window.activeTier.get() || null;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function tierLevel() {
        var v = activeView();
        return v ? (v.level || 0) : 0;
    }

    function isPremiumActive() {
        var v = activeView();
        return !!(v && v.active === true && (v.level || 0) >= 1);
    }

    function amount() {
        // Config-driven (arcv2m5): the daily reward comes from the plan ladder
        // (/plan-ladder.json) when loaded. Fallback = L0 25 / L1 50 / L2 100 / L3 200.
        var l = tierLevel();
        try {
            if (window.gfgPlanLadder && typeof window.gfgPlanLadder.dailyReward === 'function') {
                return Number(window.gfgPlanLadder.dailyReward(l)) || FREE_REWARD;
            }
        } catch (e) { /* ignore */ }
        if (l >= 3) return LEVEL4_REWARD;
        if (l >= 2) return LEVEL3_REWARD;
        if (l >= 1) return PREMIUM_REWARD;
        return FREE_REWARD;
    }

    // ---- storage -----------------------------------------------------------
    function slice() {
        var wk = walletKey();
        if (!store[wk] || typeof store[wk] !== 'object') store[wk] = { day: utcDayKey(), claimed: false };
        return store[wk];
    }

    function persist() {
        try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
    }

    function claimedToday() {
        var s = slice();
        if (s.day !== utcDayKey()) {
            s.day = utcDayKey();
            s.claimed = false;
            persist();
        }
        return !!s.claimed;
    }

    function dayNumber() {
        return Number(utcDayKey().replace(/-/g, ''));
    }

    // ---- core api ---------------------------------------------------------
    function get() {
        return {
            claimedToday: claimedToday(),
            amount: amount(),
            tierLevel: tierLevel(),
        };
    }

    // Bank today's reward into the M4 global ledger (kind=1, source 14).
    // Returns a promise: {ok:true, points, sig} on a landed write,
    // {ok:false, error} otherwise. Only marks the claim made once the write is
    // CONFIRMED (sig OR the ledger's lastMatchRef matches our day ref), so a
    // transient failure never silently loses today's reward.
    async function claim() {
        var addr = readAddress();
        if (!addr) return { ok: false, error: 'signin', message: 'Sign in to claim your daily reward.' };
        if (claiming) return { ok: false, error: 'busy', message: 'Claim already in progress.' };
        if (claimedToday()) return { ok: true, points: amount(), claimed: true };

        if (!window.globalLedger || typeof window.globalLedger.credit !== 'function') {
            return { ok: false, error: 'no-ledger', message: 'Daily reward is not ready yet. Try again in a moment.' };
        }

        claiming = true;
        try {
            var pts = amount();
            var ref = dayNumber();
            var sig = await window.globalLedger.credit({
                kind: 1,
                source: 'daily_reward',
                sourceCode: 14,
                points: pts,
                reason: DAILY_REASON,
                matchRef: ref,
            });
            // Confirm the write landed (mirror the M5 tier-boost pattern): a
            // sig OR the ledger's last_match_ref equal to our day ref proves it.
            var landed = !!sig;
            if (!landed) {
                try {
                    var gl = window.globalLedger && typeof window.globalLedger.get === 'function'
                        ? window.globalLedger.get() : null;
                    landed = !!(gl && String(gl.lastMatchRef || '') === String(ref));
                } catch (e) { /* ignore */ }
            }
            if (landed) {
                slice().claimed = true;
                persist();
                notify();
                return { ok: true, points: pts, sig: sig || null, claimed: true };
            }
            return { ok: false, error: 'write', message: 'Your reward is still banking on-chain. Check back shortly.' };
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e), message: 'Daily reward failed to bank. Try again.' };
        } finally {
            claiming = false;
        }
    }

    function notify() {
        var view = get();
        subscribers.slice().forEach(function (cb) {
            try { cb(view); } catch (e) { /* ignore */ }
        });
    }

    function subscribe(cb) {
        if (typeof cb === 'function') subscribers.push(cb);
        return function () {
            var i = subscribers.indexOf(cb);
            if (i >= 0) subscribers.splice(i, 1);
        };
    }

    // ---- slot rendering -----------------------------------------------------
    function fillSlots() {
        var view = get();
        var amountEls = document.querySelectorAll('[data-daily-amount]');
        var claimedEls = document.querySelectorAll('[data-daily-claimed]');
        for (var i = 0; i < amountEls.length; i++) amountEls[i].textContent = view.amount;
        for (var j = 0; j < claimedEls.length; j++) {
            claimedEls[j].textContent = view.claimedToday ? 'Claimed' : 'Not claimed yet';
        }
    }

    function render() {
        fillSlots();
        notify();
    }

    // ---- auto-render on wallet/auth/cross-tab changes -----------------------
    function handleDomReady() {
        render();
        refreshWhenWalletReady();
    }

    var pollActive = false;
    var lastReadWallet = null;
    function refreshWhenWalletReady(timeoutMs) {
        if (pollActive) return;
        pollActive = true;
        var deadline = Date.now() + (timeoutMs || 30000);
        (function poll() {
            var addr = readAddress();
            if (addr) {
                if (addr !== lastReadWallet) {
                    lastReadWallet = addr;
                    render();
                }
                pollActive = false;
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
            else pollActive = false;
        })();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleDomReady);
    } else {
        handleDomReady();
    }
    if (typeof window.addEventListener === 'function') {
        ['pageshow', 'focus'].forEach(function (ev) {
            window.addEventListener(ev, function () { handleDomReady(); });
        });
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            lastReadWallet = readAddress();
            render();
        });
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key !== CACHE_KEY) return;
            try { store = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (err) { store = {}; }
            render();
        });
    }
    // The reward amount follows the active tier (free 25 / Level-2 200): re-render
    // live whenever the premium ledger refreshes (activate/fetch) or its wallet
    // cache changes in another tab.
    try {
        if (window.premiumPoints && typeof window.premiumPoints.subscribe === 'function') {
            window.premiumPoints.subscribe(function () { render(); });
        }
    } catch (e) { /* ignore */ }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key && e.key.indexOf('gfg_premium_ledger') >= 0) render();
        });
    }

    // ---- public API ---------------------------------------------------------
    window.gfgDaily = {
        // PURE cache read: {claimedToday, amount, tierLevel} for the current UTC day.
        get: get,
        // Bank today's reward (kind=1, source 14, into M4). Promise as above.
        claim: claim,
        subscribe: subscribe,
    };
})();