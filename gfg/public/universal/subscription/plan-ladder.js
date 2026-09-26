// public/universal/subscription/plan-ladder.js
// arcv2m5 — CONFIG-DRIVEN plan ladder (owner 2026-08-22/2026-09-19).
//
// The plan ladder (levels, premium cost, win multiplier, lives pool, daily
// reward, prices) lives in ONE public data file, /plan-ladder.json, so adding a
// level or changing a price is a config edit, never a code change.
//
// This module loads that file ONCE and exposes it to every consumer:
//   window.gfgPlanLadder = {
//     get(level)  -> the level's object, or the free (L0) object as a safe default
//     all()       -> the whole ladder array
//     multiplier(level), livesPool(level), dailyReward(level),
//     premiumCost(level), membershipCost(level), levelOf(code)
//   }
// Consumers (lives, daily-reward, premium-ledger, profiles) read from here
// instead of hardcoding numbers. It is a soft-fail read: if the file is missing
// the module falls back to the owner-approved launch numbers below, so the app
// never breaks on a fetch error.
(function () {
    // Owner-approved fallback (also the current on-chain enforced values).
    var FALLBACK = {
        ladder: [
            { level: 0, code: 'free', label: 'Free', premiumCost: 0, membershipCostPts: 0, winMultiplier: 1, lives: 5, dailyReward: 25, ads: 'full' },
            { level: 1, code: 'l1', label: 'Level 1', premiumCost: 5000, membershipCostPts: 5000, winMultiplier: 1.5, lives: 10, dailyReward: 50, ads: 'less' },
            { level: 2, code: 'l2', label: 'Level 2', premiumCost: 5000, membershipCostPts: 5000, winMultiplier: 2, lives: 15, dailyReward: 100, ads: 'less' },
            { level: 3, code: 'l3', label: 'Level 3', premiumCost: 10000, membershipCostPts: 10000, winMultiplier: 3, lives: 20, dailyReward: 200, ads: 'none' },
        ],
    };

    var data = FALLBACK;
    var byLevel = {};
    var byCode = {};
    var ready = false;
    var waiters = [];

    function index() {
        byLevel = {}; byCode = {};
        var l = (data && data.ladder) || [];
        for (var i = 0; i < l.length; i++) {
            byLevel[Number(l[i].level)] = l[i];
            byCode[String(l[i].code)] = l[i];
        }
    }
    index();

    function freeDefault() { return byLevel[0] || FALLBACK.ladder[0]; }

    function get(level) {
        var lv = Number(level);
        if (!isFinite(lv)) lv = 0;
        return byLevel[lv] || freeDefault();
    }

    window.gfgPlanLadder = {
        ready: function () { return ready; },
        all: function () { return (data && data.ladder) ? data.ladder.slice() : FALLBACK.ladder.slice(); },
        get: get,
        levelOf: function (code) { var e = byCode[String(code)]; return e ? Number(e.level) : 0; },
        multiplier: function (level) { return Number(get(level).winMultiplier || 1); },
        livesPool: function (level) { return Number(get(level).lives || 5); },
        dailyReward: function (level) { return Number(get(level).dailyReward || 25); },
        premiumCost: function (level) { return Number(get(level).premiumCost || 0); },
        membershipCost: function (level) { return Number(get(level).membershipCostPts || get(level).premiumCost || 0); },
        ads: function (level) { return String(get(level).ads || 'less'); },
        onReady: function (cb) {
            if (typeof cb !== 'function') return function () {};
            if (ready) { try { cb(window.gfgPlanLadder); } catch (e) {} return function () {}; }
            waiters.push(cb);
            return function () { var i = waiters.indexOf(cb); if (i >= 0) waiters.splice(i, 1); };
        },
    };

    // Load once; on success re-index and fire waiters. Soft-fail keeps FALLBACK.
    fetch('/plan-ladder.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            if (j && Array.isArray(j.ladder) && j.ladder.length) { data = j; index(); }
        })
        .catch(function () { /* keep FALLBACK */ })
        .then(function () {
            ready = true;
            var cbs = waiters.slice(); waiters.length = 0;
            for (var i = 0; i < cbs.length; i++) { try { cbs[i](window.gfgPlanLadder); } catch (e) { /* ignore */ } }
            try { window.dispatchEvent(new CustomEvent('gfg:plan-ladder')); } catch (e) { /* ignore */ }
        });
})();
