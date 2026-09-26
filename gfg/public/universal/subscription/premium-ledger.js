// public/universal/subscription/premium-ledger.js
// M5 — PREMIUM POINTS + ACTIVE TIER MODULE (universal, game-agnostic).
//
// The MONEY module. Premium points are their OWN on-chain ledger
// ([gfgprem, player], buy-only): premium_lifetime (a permanent credential,
// never spent) + premium_spendable (the subscription/special-purchase
// currency). Acquired ONLY by direct purchase via the admin credit flow after
// a VERIFIED manual crypto payment. Never merges into M3/M4 and never
// touches M4a pure.
//
// Subscription state lives ON-CHAIN in the same PDA (subscription_level u8,
// subscription_active_until i64): 0 = free, 1 = Level 1, 2 = Level 2,
// 3 = Level 3, with a HARD 30-day window and NO auto-renew. Any page reads
// the truth from the chain gaslessly; Supabase keeps only payment/affiliate
// relationship rows.
//
// Exposes:
//   window.premiumPoints = { get(), checked(), fetch(), spend(amount,
//     reason, ref), activate(), subscribe(cb), lastCredit, lastSpend,
//     lastError, clearTransient(), reset() }
//   window.activeTier    = { get() -> {level, expiry, daysLeft, active},
//     subscribe(cb) }
// and fills any DOM slot marked data-premium-lifetime / data-premium-spendable
// / data-sub-level / data-sub-days on any page.
//
// Read economy mirrors global-ledger.js EXACTLY (owner-approved contract):
// the wallet-keyed localStorage cache is the ONLY display source; the RPC is
// consulted only on the first check after login + after a spend/activate, and
// reads go BY WALLET ADDRESS via magicblockDice.fetchPremiumPointsPdaFor.
(function () {

    var CACHE_KEY = 'gfg_premium_ledger_cache_v1';
    var cacheStore = {};       // wallet -> premium ledger snapshot (latest known)
    var cached = null;         // current wallet's snapshot
    var subscribers = [];      // callbacks invoked after a fetch / spend / activate / reset
    var lastCredit = null;      // last admin credit (relayed to the profile history)
    var lastSpend = null;       // last spend/activation, with its status
    var lastError = null;       // last failure reason

    // Separate check-marker key (mirrors global-ledger META_KEY).
    var META_KEY = 'gfg_premium_ledger_meta_v1';
    var metaStore = {};
    var refreshInFlight = null;

    // ---- identity + cache (mirror global-ledger.js) ----

    function readAddress() {
        // Arc rail: the EVM address is the identity for the on-chain ledger.
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

    function loadCache() {
        try {
            var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
            if (typeof raw === 'object') cacheStore = raw;
        } catch (e) { cacheStore = {}; }
    }

    function syncCacheToWallet() {
        var wk = walletKey();
        var entry = cacheStore[wk];
        cached = (entry && typeof entry === 'object' && entry.premiumSpendable != null) ? entry : null;
    }

    function persistCache(ledger) {
        try {
            cacheStore[walletKey()] = ledger;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheStore));
        } catch (e) { /* ignore */ }
    }

    function loadMeta() {
        try {
            metaStore = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {};
        } catch (e) { metaStore = {}; }
    }
    function markChecked(any) {
        metaStore[walletKey()] = { at: Date.now(), any: !!any };
        try { localStorage.setItem(META_KEY, JSON.stringify(metaStore)); } catch (e) { /* ignore */ }
    }
    function hasChecked() { return !!metaStore[walletKey()]; }
    function hasRealWallet() { return readAddress() !== null; }

    function magicReady() {
        return !!(window.magicblockDice && typeof window.magicblockDice.fetchPremiumPointsPdaFor === 'function');
    }

    // ---- Arc rail (arcv2m16/arcv2m17) --------------------------------------
    // On Arc the ledger lives in PlayerCore, read through the relayer. This is
    // the SAME on-chain truth, just a different rail; the module is otherwise
    // chain-agnostic. Returns the same ledger shape the Solana path produces.
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
    async function arcReadLedger() {
        var addr = evmAddress();
        if (!addr) return null;
        var a = window.gfgChainAdapter;
        if (!a || typeof a.readPlayer !== 'function') return null;
        var r = await a.readPlayer('ludo');
        if (!r) return null;
        var p = r.premium || {};
        var lv = r.lives || {};
        return {
            premiumLifetime: Number(p.lifetime || 0),
            premiumSpendable: Number(p.spendable || 0),
            subscriptionLevel: Number(p.level || 0),
            // relayer returns seconds; the view expects ms.
            subscriptionActiveUntil: Number(p.activeUntil || 0) * 1000,
            boosterActiveUntil: Number(lv.boosterUntil || 0) * 1000,
            chain: 'arc',
        };
    }

    loadCache();
    syncCacheToWallet();
    loadMeta();

    function fillSlots(ledger) {
        var lifeEls = document.querySelectorAll('[data-premium-lifetime]');
        var spendEls = document.querySelectorAll('[data-premium-spendable]');
        var levelEls = document.querySelectorAll('[data-sub-level]');
        var daysEls = document.querySelectorAll('[data-sub-days]');
        for (var i = 0; i < lifeEls.length; i++) lifeEls[i].textContent = ledger.premiumLifetime || 0;
        for (var j = 0; j < spendEls.length; j++) spendEls[j].textContent = ledger.premiumSpendable || 0;
        for (var k = 0; k < levelEls.length; k++) levelEls[k].textContent = ledger.subscriptionLevel || 0;
        for (var m = 0; m < daysEls.length; m++) daysEls[m].textContent = ledgerActive().daysLeft;
    }

    function notify(ledger) {
        subscribers.slice().forEach(function (cb) {
            try { cb(ledger || cached, activeView(ledger || cached)); } catch (e) { /* ignore */ }
        });
    }

    function activeView(ledger) {
        ledger = ledger || cached;
        if (!ledger) return null;
        var until = ledger.subscriptionActiveUntil || 0;
        var daysLeft = until > Date.now() ? Math.ceil((until - Date.now()) / 86400000) : 0;
        return {
            level: ledger.subscriptionLevel || 0,
            expiry: until,
            daysLeft: daysLeft,
            active: (ledger.subscriptionLevel || 0) > 0 && until > Date.now(),
        };
    }

    // Centerpiece: fetch the premium ledger BY WALLET ADDRESS (no signing
    // session required, mirrors global-ledger.address-read + the recovery
    // page's raw reads). Falls back to the sign-in-scoped SDK fetch.
    async function refreshLedger(force) {
        if (refreshInFlight) return refreshInFlight;
        var firstCheck = !hasChecked();
        refreshInFlight = (async function () {
            var ledger = null;
            try {
                // Arc rail: read PlayerCore through the relayer (same on-chain
                // truth). On Arc this is the ONLY read path: if it returns null
                // we must NOT fall through to the Solana SDK (that was a real
                // Solana read on the Arc build). Return the honest cached/empty
                // state instead.
                if (isArc()) {
                    ledger = await arcReadLedger();
                    if (ledger) {
                        cached = ledger;
                        if (hasRealWallet()) markChecked(true);
                        persistCache(ledger);
                        fillSlots(ledger);
                        notify(ledger);
                        return ledger;
                    }
                    if (hasRealWallet()) markChecked(false);
                    if (firstCheck) notify(null);
                    var arcFallback = cached || null;
                    if (arcFallback) fillSlots(arcFallback);
                    return arcFallback;
                }
                var addr = readAddress();
                var sdk = window.magicblockDice;
                if (!ledger && addr && sdk && typeof sdk.fetchPremiumPointsPdaFor === 'function') {
                    ledger = await sdk.fetchPremiumPointsPdaFor(addr);
                }
                if (!ledger && sdk && typeof sdk.fetchPremiumPointsPda === 'function') {
                    ledger = await sdk.fetchPremiumPointsPda();
                }
                if (ledger) {
                    cached = ledger;
                    if (hasRealWallet()) markChecked(true);
                    persistCache(ledger);
                    fillSlots(ledger);
                    notify(ledger);
                    return ledger;
                }
            } catch (e) { /* ledger not readable yet */ }
            if (hasRealWallet()) markChecked(false);
            if (firstCheck) notify(null);
            var fallback = cached || null;
            if (fallback) fillSlots(fallback);
            return fallback;
        })();
        try {
            return await refreshInFlight;
        } finally {
            refreshInFlight = null;
        }
    }

    // ---- public API -----------------------------------------------------
    window.premiumPoints = {
        // Latest known premium ledger snapshot (or null). PURE cache read.
        get: function () { return cached || null; },
        // True once this wallet has been verified (even with a zero ledger).
        checked: function () { return hasChecked(); },
        // Blocking gasless fetch of the premium ledger (own account).
        fetch: function () { return refreshLedger(true); },
        // Draw down PREMIUM spendable (gasless ER write, player session key
        // signs). Soft-fail. Returns the spend receipt sig on success.
        spend: async function (amount, reason, ref) {
            if (!magicReady()) return null;
            try {
                // ARC (arcv2m17 audit): spend through the gateway, never the
                // Solana SDK. gfgChain.spendGlobal routes to the Arc adapter on
                // Arc and to the ER session key on Solana.
                var sig = await window.gfgChain.spendGlobal(amount, reason, ref);
                await refreshLedger(true);
                lastSpend = { amount: amount, reason: reason, ref: ref, sig: sig, at: Date.now() };
                notify(cached);
                return sig || null;
            } catch (e) {
                lastError = (e && (e.message || e)) || String(e);
                console.warn('[premium-ledger] spend failed (soft-fail):', lastError);
                return null;
            }
        },
        // Activate a plan on-chain via activate_subscription_level (deducts
        // 5,000/10,000/15,000 premium spendable for Level 1/2/3, sets a hard
        // 30-day window, NO auto-renew). Gasless ER write. Soft-fail. Returns
        // the receipt sig on success.
        activate: async function (level) {
            var lvl = Math.min(3, Math.max(1, Number(level) || 1));
            // Arc rail: activation is an ADMIN-GATED on-chain write (the relayer
            // holds the operator role), so the browser asks the relayer and the
            // contract sets the 30-day window from block time. No signing needed.
            if (isArc()) {
                var a = window.gfgChainAdapter;
                if (!a || typeof a.activatePlan !== 'function') { lastError = 'arc activate unavailable'; return null; }
                try {
                    var addr = evmAddress();
                    if (!addr) { lastError = 'no Arc wallet connected'; return null; }
                    var r = await a.activatePlan(addr, lvl, 30);
                    await refreshLedger(true);
                    lastSpend = { amount: premiumCostForLevel(lvl), reason: 'activate_subscription', ref: 'activate', sig: (r && (r.txHash || r)) || null, at: Date.now() };
                    notify(cached);
                    return (r && (r.txHash || r)) || null;
                } catch (e) {
                    lastError = (e && (e.message || e)) || String(e);
                    console.warn('[premium-ledger] arc activate failed:', lastError);
                    return null;
                }
            }
            if (!magicReady()) return null;
            try {
                var sig = await window.magicblockDice.activateSubscriptionLevel(lvl);
                await refreshLedger(true);
                lastSpend = { amount: premiumCostForLevel(lvl), reason: 'activate_subscription', ref: 'activate', sig: sig, at: Date.now() };
                notify(cached);
                return sig || null;
            } catch (e) {
                lastError = (e && (e.message || e)) || String(e);
                console.warn('[premium-ledger] activate failed (soft-fail):', lastError);
                return null;
            }
        },
        reset: function () {
            cached = null;
            var wk = walletKey();
            delete cacheStore[wk];
            delete metaStore[wk];
            try { localStorage.setItem(META_KEY, JSON.stringify(metaStore)); } catch (e) { /* ignore */ }
            fillSlots({ premiumLifetime: 0, premiumSpendable: 0, subscriptionLevel: 0, subscriptionActiveUntil: 0 });
            notify(null);
            return true;
        },
        subscribe: function (cb) {
            if (typeof cb === 'function') subscribers.push(cb);
            return function () {
                var i = subscribers.indexOf(cb);
                if (i >= 0) subscribers.splice(i, 1);
            };
        },
        get lastCredit() { return lastCredit; },
        get lastSpend() { return lastSpend; },
        get lastError() { return lastError; },
        clearTransient: function () {
            lastCredit = null;
            lastSpend = null;
            lastError = null;
        },
        _markCredit: function (c) { lastCredit = c; notify(cached); },
    };

    window.activeTier = {
        // PURE cache read of the on-chain subscription state.
        get: function () { return activeView(); },
        // Force a fresh gasless read of the subscription state.
        fetch: function () { return refreshLedger(true).then(function (l) { return activeView(l); }); },
        // Subscribe to subscription-state changes. The callback receives the
        // activeTier view ({level, expiry, daysLeft, active}). Shares the
        // premiumPoints subscriber list (they fire on the same refreshes).
        subscribe: function (cb) {
            if (typeof cb !== 'function') return function () { /* noop */ };
            var wcb = function (ledger, view) { cb(view || activeView(ledger)); };
            subscribers.push(wcb);
            return function () {
                var i = subscribers.indexOf(wcb);
                if (i >= 0) subscribers.splice(i, 1);
            };
        },
    };

    // ---- render cached on load + wallet-ready poll (mirror global-ledger) ----
    function renderCached() {
        if (cached) fillSlots(cached);
    }
    var pollActive = false;
    var lastReadWallet = null;
    function refreshWhenWalletReady(timeoutMs) {
        if (pollActive) return;
        pollActive = true;
        var deadline = Date.now() + (timeoutMs || 30000);
        (function poll() {
            var sdk = window.magicblockDice;
            var addr = readAddress();
            var ready = isArc() ? !!addr : !!(addr && sdk && typeof sdk.isConfigured === 'function' && sdk.isConfigured());
            if (ready) {
                if (addr !== lastReadWallet) {
                    lastReadWallet = addr;
                    syncCacheToWallet();
                    renderCached();
                    notify(cached);
                }
                pollActive = false;
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
            else pollActive = false;
        })();
    }

    // RPC policy (owner contract): page loads must NOT hit the RPC (that got AS
    // banned before). But a FRESH session (new browser / incognito / silent restore
    // without gfg:auth-changed) has NO snapshot, so the tier badge and lives/daily
    // would sit at the default L1 forever. The compromise: a wallet-ready poll
    // seeds the cache with ONE fetch on the FIRST appearance of a wallet that has
    // no snapshot yet. After that, every page renders from the wallet-keyed cache
    // with zero RPC (auth-changed and win still refresh it, same as M3/M4).
    function handleDomReady() {
        renderCached();
        var pollActive = false;
        var deadline = Date.now() + 15000;
        (function poll() {
            try {
                var sdk = window.magicblockDice;
                var addr = readAddress();
                var ready = isArc() ? !!addr : !!(addr && sdk && typeof sdk.isConfigured === 'function' && sdk.isConfigured());
                if (ready) {
                    syncCacheToWallet();
                    renderCached();
                    // Seed on first appearance only when no snapshot exists yet.
                    if (!cached && !hasChecked() && typeof refreshLedger === 'function') {
                        refreshLedger(true);
                    }
                    return;
                }
                if (Date.now() < deadline) setTimeout(poll, 700);
            } catch (e) { /* ignore */ }
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
            syncCacheToWallet();
            renderCached();
        });
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key !== CACHE_KEY) return;
            loadCache();
            syncCacheToWallet();
            renderCached();
            notify(cached);
        });
    }

    // ---- M5 MULTIPLIER AT M4 FLOW-UP (kind=1 tier_boost) ----------------
    // Per the locked M5 spec: on each VERIFIED seam event while the sub is
    // active, M5 computes (multiplier-1)*base and credits M4 via
    // globalLedger.credit({kind:1, source:'tier_boost', ...}). This is the
    // ONLY place the multiplier applies, and it NEVER touches M3 local or M4a
    // pure (kind=1 credits M4b+M4c only, by the global-ledger contract).
    // Base comes from M3's computed award for the SAME envelope (read
    // synchronously, then a short bounded poll, exactly like M4's bank()).
    var BOOST_REASON = 5; // mirrors the program's u8 reason for tier boosts

    function multiplierForLevel(level) {
        // Config-driven (arcv2m5): read the live plan ladder when present, so a
        // new level or a changed multiplier is a config edit. Falls back to the
        // owner-approved launch numbers if the module/config is unavailable.
        try {
            if (window.gfgPlanLadder && typeof window.gfgPlanLadder.multiplier === 'function') {
                return Number(window.gfgPlanLadder.multiplier(level)) || 1;
            }
        } catch (e) { /* ignore */ }
        // Ladder L0-L3 (owner 2026-08-31): L0 free 1x, L1 1.5x, L2 2x, L3 3x.
        if (level <= 0) return 1;
        if (level === 1) return 1.5;
        if (level === 2) return 2;
        return 3;
    }

    // Premium cost of a plan level, config-driven when available.
    function premiumCostForLevel(level) {
        try {
            if (window.gfgPlanLadder && typeof window.gfgPlanLadder.premiumCost === 'function') {
                return Number(window.gfgPlanLadder.premiumCost(level)) || 0;
            }
        } catch (e) { /* ignore */ }
        return [0, 5000, 10000, 15000][Number(level)] || 0;
    }

    function baseAwardForEnv(env, matchRef) {
        if (!window.localPoints) return null;
        var now = Date.now();
        var seen = window.localPoints.lastSeenAward;
        var landed = window.localPoints.lastAward;
        if (seen && seen.points > 0 && String(seen.matchRef || '') === matchRef) return seen;
        if (landed && landed.points > 0 && String(landed.matchRef || '') === matchRef) return landed;
        if (seen && seen.points > 0 && seen.at && (now - seen.at) < 15000) return seen;
        if (landed && landed.points > 0 && landed.at && (now - landed.at) < 15000) return landed;
        return null;
    }

    var BOOST_PROCESSED_KEY = 'gfg_premium_tier_boost_processed_v1';
    var boostProcessed = {};
    try {
        boostProcessed = JSON.parse(window.localStorage.getItem(BOOST_PROCESSED_KEY) || '{}') || {};
    } catch (e) { boostProcessed = {}; }
    function persistBoostProcessed() {
        try { window.localStorage.setItem(BOOST_PROCESSED_KEY, JSON.stringify(boostProcessed)); } catch (e) { /* ignore */ }
    }

    function matchRefForSig(sig) {
        if (!sig) return '0';
        // ARC (arcv2m17 audit): prefer the gateway's stable ref (hex-safe on Arc).
        try {
            if (window.gfgChain && typeof window.gfgChain.matchRefFromSignature === 'function') {
                return String(window.gfgChain.matchRefFromSignature(sig));
            }
        } catch (e) { /* fall through */ }
        try {
            if (window.magicblockDice && typeof window.magicblockDice.matchRefFromSignature === 'function') {
                return String(window.magicblockDice.matchRefFromSignature(sig));
            }
        } catch (e) { /* fall through */ }
        return '0';
    }

    // The boost is its OWN kind=1 credit on M4, but the GlobalPoints duplicate
    // guard is ONE last_match_ref: the game-win write already occupies it. Derive
    // a distinct ref from the SAME proof roll (bytes 4-11 as u64) so the boost
    // write passes the guard while staying provably bound to that win.
    function boostRefForSig(sig) {
        if (!sig) return '0';
        // ARC: there is no dedicated boost-ref on the Arc gateway; derive a
        // distinct stable ref from the same token so it never collides with the
        // win ref (which uses the gateway's plain matchRefFromSignature).
        try {
            if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                const base = String(window.gfgChain.matchRefFromSignature(sig) || '0');
                let h = 0x811c9dc5 >>> 0;
                const s = 'boost|' + base;
                for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
                return String((h % 2147483647) || 1);
            }
        } catch (e) { /* fall through */ }
        try {
            if (window.magicblockDice && typeof window.magicblockDice.boostRefFromSignature === 'function') {
                return String(window.magicblockDice.boostRefFromSignature(sig));
            }
        } catch (e) { /* fall through */ }
        return '0';
    }

    async function applyTierBoost(env) {
        // Only for the signed-in user's verified finish, with an on-chain proof.
        var userSeat = null;
        for (var i = 0; i < env.players.length; i++) {
            var p = env.players[i];
            if (p.actor === 'user' && p.identity && p.position) { userSeat = p; break; }
        }
        if (!userSeat) return;
        var proofSig = env.proof && env.proof.signature;
        if (!proofSig) return;
        var matchRef = matchRefForSig(proofSig);     // the game-win ref (M4 occupies it)
        var boostRef = boostRefForSig(proofSig);     // the boost's own ref (same roll)
        if (!boostRef || boostRef === '0') return;
        if (boostProcessed[boostRef]) return; // already boosted this match

        // Sub must be active for the boost to apply (L0 free never boosts).
        var view = activeView();
        if (!view || !view.active || view.level <= 0) return;

        // Resolve M3's base award for this envelope (M4 banks it the same way).
        var award = baseAwardForEnv(env, matchRef);
        if (!award) {
            var deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                await new Promise(function (r) { setTimeout(r, 80); });
                award = baseAwardForEnv(env, matchRef);
                if (award) break;
            }
        }
        if (!award || !award.points || award.points <= 0) return;

        var mult = multiplierForLevel(view.level);
        if (mult <= 1) return;
        var boost = (mult - 1) * award.points; // Level 2 -> 1x base as the boost

        if (!window.globalLedger || typeof window.globalLedger.credit !== 'function') return;
        try {
            var sig = await window.globalLedger.credit({
                kind: 1,
                source: 'tier_boost',
                points: boost,
                reason: BOOST_REASON,
                matchRef: boostRef,
            });
            // Confirm the write actually landed (re-read the global ledger): a
            // sig OR the ledger's last match_ref matching proves it. Marking
            // processed only on a confirmed landing keeps a retry safe (the
            // program's own last_match_ref guard is the final idempotent wall).
            var gl = window.globalLedger && typeof window.globalLedger.get === 'function'
                ? window.globalLedger.get() : null;
            var landed = !!sig || (gl && String(gl.lastMatchRef || '') === String(boostRef));
            if (landed) {
                boostProcessed[boostRef] = { gameId: env.gameId, points: boost, at: Date.now() };
                persistBoostProcessed();
                console.log('[premium-ledger] tier_boost credited ' + boost + 'pt (Level ' + view.level + ' x' + mult + ') for match ' + matchRef);
            } else {
                console.warn('[premium-ledger] tier_boost write not confirmed for match', matchRef);
            }
        } catch (e) {
            console.warn('[premium-ledger] tier boost failed (soft-fail):', e.message || e);
        }
    }

    // M5 consumes the SAME seam M3/M4 consume (the module list is a bus, so
    // multiple handlers coexist). It never reads game internals.
    if (window.onGameResult) {
        window.onGameResult(function (env) {
            if (env && env.schema === 'gfg:game-result@1') applyTierBoost(env);
        });
    }

})();