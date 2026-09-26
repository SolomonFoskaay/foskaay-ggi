// tiers.js — S1: Active Tier ladder + spendable sink + win multiplier
//
// Settled economics (econ-003, 2026-08-14, DO NOT re-litigate):
//   Tier 1 (free)    1x   cost 0
//   Tier 2           2x   1,000 spendable / month
//   Tier 3           3x   2,500 spendable / month
//   Tier 4           4x   5,000 spendable / month
//
// Rules:
//   - Multiplier applies ONLY to base match win points (100 -> 200/300/400).
//     NEVER to stake returns, competition prizes, or referral gifts.
//   - Per-day multiplier cap: at most +1,000 boosted points/day (~10 extra
//     100-pt wins), so sinks drain faster than multipliers mint.
//   - Spending comes from the SPENDABLE balance (profiles.global_points).
//     LIFETIME points (profiles.lifetime_points) never decrease.
//   - Tier lasts one month from purchase (renews monthly, may lapse).
//
// Ledgers (econ-002): global_points = spendable, lifetime_points = permanent.
// Anti-abuse note: server-authoritative metering of allowance/refills is a
// mainnet item in docs/changelog/security-queue.md. Devnet is free money.

(function () {

    const TIER_LADDER = {
        1: { cost: 0,    mult: 1, label: 'Tier 1', name: 'Free' },
        2: { cost: 1000, mult: 2, label: 'Tier 2', name: 'Double' },
        3: { cost: 2500, mult: 3, label: 'Tier 3', name: 'Triple' },
        4: { cost: 5000, mult: 4, label: 'Tier 4', name: 'Quad' }
    };
    const TIER_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // one calendar month
    const DAILY_BOOST_CAP = 1000;                    // +1,000 boosted pts/day max

    // localStorage keys (device-level, per user)
    function boostKey() {
        return 'gfg_tier_boost_' + (window.currentUser ? window.currentUser.id : 'anon');
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function readBoostUsedToday() {
        try {
            const rec = JSON.parse(localStorage.getItem(boostKey()) || 'null');
            if (rec && rec.date === todayStr()) return Math.max(0, rec.used || 0);
        } catch (e) { /* ignore */ }
        return 0;
    }

    function writeBoostUsedToday(used) {
        try {
            localStorage.setItem(boostKey(), JSON.stringify({ date: todayStr(), used }));
        } catch (e) { /* ignore */ }
    }

    function getProfile() {
        return window.currentProfile || null;
    }

    // Effective tier for the signed-in player right now (lapses on expiry).
    window.getActiveTier = function () {
        const p = getProfile();
        const stored = p && p.active_tier ? Number(p.active_tier) : 1;
        const expiresAt = p && p.active_tier_expires_at ? new Date(p.active_tier_expires_at).getTime() : 0;
        if (stored > 1 && expiresAt > Date.now()) {
            const t = TIER_LADDER[stored];
            return { tier: stored, mult: t.mult, cost: t.cost, label: t.label, name: t.name, expiresAt };
        }
        const t = TIER_LADDER[1];
        return { tier: 1, mult: t.mult, cost: 0, label: t.label, name: t.name, expiresAt: 0 };
    };

    window.getSpendablePoints = function () {
        // Prefer on-chain M4 spendable; fall back to Supabase mirror.
        var gl = window.globalLedger && typeof window.globalLedger.get === 'function'
            ? window.globalLedger.get() : null;
        if (gl && gl.spendableBalance != null) return gl.spendableBalance;
        var p = getProfile();
        return p && typeof p.global_points === 'number' ? p.global_points : 0;
    };

    window.getLifetimePoints = function () {
        const p = getProfile();
        return p && typeof p.lifetime_points === 'number' ? p.lifetime_points : 0;
    };

    // ---- Purchase an Active Tier (monthly) ----
    // Deducts spendable, sets tier + expiry. Idempotent enough: buying the same
    // tier again simply extends expiry by a month from now.
    window.buyActiveTier = async function (tier) {
        tier = Number(tier);
        if (!TIER_LADDER[tier] || tier < 2) {
            if (window.showAuthBanner) window.showAuthBanner('Unknown tier', true);
            return false;
        }
        if (!window.currentUser || !getProfile()) {
            if (window.showAuthBanner) window.showAuthBanner('Sign in to buy an Active Tier', true);
            return false;
        }

        const cost = TIER_LADDER[tier].cost;
        const spendable = window.getSpendablePoints();
        if (spendable < cost) {
            if (window.showAuthBanner) {
                window.showAuthBanner(`Not enough spendable points (need ${cost.toLocaleString()}, you have ${spendable.toLocaleString()})`, true);
            }
            return false;
        }

        const newGlobal = spendable - cost;
        const expiresAt = new Date(Date.now() + TIER_MONTH_MS).toISOString();

        // Optimistic in-session update so the player sees the tier immediately.
        const profile = getProfile();
        profile.global_points = newGlobal;
        profile.active_tier = tier;
        profile.active_tier_expires_at = expiresAt;
        window.currentProfile = profile;
        if (window.showAuthBanner) {
            window.showAuthBanner(`Active ${TIER_LADDER[tier].name} unlocked (${TIER_LADDER[tier].mult}x on wins) until ${new Date(expiresAt).toLocaleDateString()}`);
        }
        if (typeof window.refreshAuthHeader === 'function') window.refreshAuthHeader();

        // Persist: audit row (negative = spend) + profile totals.
        const saved = await persistTierPurchase(tier, cost, newGlobal, expiresAt);
        if (!saved) {
            // No write-through: keep the device state but warn; devnet only.
            console.warn('[tier] Supabase write failed — tier kept on device for this session');
        }
        return true;
    };

    async function persistTierPurchase(tier, cost, newGlobal, expiresAt) {
        if (!window.supabaseClient || !window.currentUser) return false;
        try {
            const audit = await window.supabaseClient
                .from('point_transactions')
                .insert({
                    user_id: window.currentUser.id,
                    game_id: 'system',
                    points: -cost,
                    reason: 'active_tier_purchase'
                })
                .select('id')
                .single();
            if (audit.error) {
                console.error('[tier] audit insert failed:', audit.error);
                return false;
            }
            const update = await window.supabaseClient
                .from('profiles')
                .update({
                    global_points: newGlobal,
                    active_tier: tier,
                    active_tier_expires_at: expiresAt
                })
                .eq('id', window.currentUser.id)
                .select()
                .single();
            if (update.error) {
                console.error('[tier] profiles update failed:', update.error);
                return false;
            }
            if (update.data) window.currentProfile = update.data;
            return true;
        } catch (err) {
            console.error('[tier] unexpected persist error:', err);
            return false;
        }
    }

    // ---- Multiplier on base match win points (with daily cap) ----
    // Returns the FULL award to bank and the breakdown for display:
    //   { base, mult, boosted, total, capHit, remainingToday }
    // base is the un-multiplied match reward (e.g. 100). boosted is the extra
    // from the tier, capped so total boosted per day never exceeds +1,000.
    window.computeWinReward = function (base) {
        base = Math.max(0, Number(base) || 0);
        const tier = window.getActiveTier();
        if (tier.tier <= 1 || base <= 0) {
            return { base, mult: 1, boosted: 0, total: base, capHit: false, remainingToday: DAILY_BOOST_CAP };
        }

        const usedToday = readBoostUsedToday();
        const remainingToday = Math.max(0, DAILY_BOOST_CAP - usedToday);
        const desiredBoost = base * (tier.mult - 1);
        const boosted = Math.min(desiredBoost, remainingToday);
        const capHit = boosted < desiredBoost;

        // Commit the boost to today's counter.
        writeBoostUsedToday(usedToday + boosted);

        return {
            base,
            mult: tier.mult,
            boosted,
            total: base + boosted,
            capHit,
            remainingToday: Math.max(0, remainingToday - boosted)
        };
    };

    // Expose ladder metadata for UI rendering.
    window.ACTIVE_TIERS = TIER_LADDER;
    window.TIER_DAILY_BOOST_CAP = DAILY_BOOST_CAP;
    window.resetDailyBoostCounter = function () { writeBoostUsedToday(0); };

    // Refresh any on-page tier/spendable displays.
    window.renderTierUI = function () {
        if (typeof window.__renderTierUI === 'function') window.__renderTierUI();
    };

})();
