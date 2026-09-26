// profiles.js
// Handles profile loading, 500 signup points, and header display
// Dynamic is primary login • Supabase is backup store

(function () {

    function getPill() {
        return document.getElementById('gfg-user-pill') || document.querySelector('.gfg-user-pill');
    }

    // Get current Dynamic user (works with current headless SDK)
    function getDynamicUser() {
        try {
            if (!window.dynamicClient) return null;

            const user = window.dynamicClient.auth?.currentUser
                || window.dynamicClient.user
                || window.dynamicClient.auth?.user
                || null;

            if (!user) return null;

            // Try to get the Solana wallet address
            let solanaWallet = null;
            try {
                // Preferred: read via the SDK helper exposed by src/dynamic-auth.js
                if (window.getDynamicSolanaWallet) {
                    solanaWallet = window.getDynamicSolanaWallet();
                }
                if (!solanaWallet) {
                    const wallets = window.dynamicClient?.walletAccounts
                        || user.walletAccounts
                        || [];

                    // Find a Solana wallet
                    const solWallet = wallets.find(w =>
                        w.chain === 'solana' ||
                        w.chain === 'SOL' ||
                        (w.address && w.address.length >= 32 && w.address.length <= 44)
                    );

                    if (solWallet) {
                        solanaWallet = solWallet.address || solWallet.publicKey || null;
                    }
                }
            } catch (e) {
                console.warn('Could not read Solana wallet', e);
            }

            return {
                dynamicId: user.userId || user.id || user.user_id,
                email: user.email
                    || (user.verifiedCredentials && user.verifiedCredentials[0]?.email)
                    || user.emailAddress
                    || null,
                solanaWallet: solanaWallet
            };
        } catch (e) {
            console.warn('Could not read Dynamic user', e);
            return null;
        }
    }

    // Create or load profile using dynamic_user_id
    async function ensureProfile(dynamicUser) {
        if (!dynamicUser || !dynamicUser.dynamicId) return null;

        // 1. Try to find existing profile by dynamic_user_id
        let { data: profile, error } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .eq('dynamic_user_id', dynamicUser.dynamicId)
            .maybeSingle();

        if (error) {
            console.error('Profile fetch error:', error);
            return null;
        }

        // 2. Profile already exists
        if (profile) {
            // Backfill the wallet if it was captured as null earlier
            // (e.g. signup happened before Dynamic finished creating the wallet)
            if (!profile.solana_wallet && dynamicUser.solanaWallet) {
                const { error: backfillError } = await window.supabaseClient
                    .from('profiles')
                    .update({ solana_wallet: dynamicUser.solanaWallet })
                    .eq('dynamic_user_id', dynamicUser.dynamicId);

                if (backfillError) {
                    console.error('Profile wallet backfill error:', backfillError);
                } else {
                    profile.solana_wallet = dynamicUser.solanaWallet;
                }
            }
            return profile;
        }

        // 3. Create new profile
        let bonus = 500;
        const { data: config } = await window.supabaseClient
            .from('point_config')
            .select('value')
            .eq('key', 'signup_bonus')
            .maybeSingle();

        if (config && config.value) bonus = config.value;

        const code = 'GF' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const username = (dynamicUser.email || 'player').split('@')[0].slice(0, 20);

        // Generate a normal UUID for the primary key
        const newId = crypto.randomUUID();

        const { data: created, error: insertError } = await window.supabaseClient
        .from('profiles')
        .insert({
            id: newId,
            dynamic_user_id: dynamicUser.dynamicId,
            email: dynamicUser.email || null,
            solana_wallet: dynamicUser.solanaWallet || null,
            username: username,
            display_name: username,
            global_points: bonus,
            lifetime_points: bonus,
            level: 1,
            referral_code: code
        })
        .select()
        .single();

        if (insertError) {
            console.error('Profile create error:', insertError);
            return null;
        }

        // Record signup bonus
        await window.supabaseClient.from('point_transactions').insert({
            user_id: newId,
            game_id: 'system',
            points: bonus,
            reason: 'signup_bonus'
        });

        if (window.showAuthBanner) {
            window.showAuthBanner('Welcome! +' + bonus + ' signup points added');
        }

        return created;
    }

    // Expose the session resolver so every page (profile, competitions,
    // subscription-paid) checks the SAME sign-in signal the header pill uses,
    // never a stale page-level copy. This is the single sign-in/out source.
    window.getDynamicUser = getDynamicUser;

    // Update the header UI. Points are ALWAYS on-chain (M4 global ledger).
    // Shows cached points immediately (from localStorage), then auto-updates
    // when the async on-chain fetch completes. No "unavailable" flash.
    var _globalLedgerUnsub = null;
    async function updateHeader(dynamicUser) {
        const pill = getPill();
        if (!pill) return;

        if (dynamicUser) {
            const profile = await ensureProfile(dynamicUser);
            // Identity stays concealed: show the unique GFG-XXXXXX handle (same as
            // the affiliate identity), never the email or a profile name.
            let handle = null;
            try { handle = (window.gfgReferral && typeof window.gfgReferral.handle === 'function') ? window.gfgReferral.handle() : null; } catch (e) {}
            const name = (handle || profile?.display_name || 'Player').slice(0, 12);
            const premium = (window.activeTier && typeof window.activeTier.get === 'function') ? window.activeTier.get() : null;
            const lvlMult = (lv) => {
                try { if (window.gfgPlanLadder && typeof window.gfgPlanLadder.multiplier === 'function') return window.gfgPlanLadder.multiplier(lv); } catch (e) {}
                return [1, 1.5, 2, 3][lv] || 1;
            };
            const tier = premium && premium.active
                ? { tier: premium.level, mult: lvlMult(premium.level), label: 'Level ' + premium.level }
                : ((typeof window.getActiveTier === 'function')
                    ? window.getActiveTier()
                    : { tier: 0, mult: 1, label: 'Level 0' });
            const tierBadge = (tier.tier > 0 && tier.mult > 1)
                ? `<span class="tier-badge" title="Active ${tier.label} (${tier.mult}x on win points)">${tier.mult}x</span>`
                : '';

            // Read on-chain M4 spendable. Cache-only: the module's board is the source
            // of truth, and get() never fetches. Show the cached balance, or
            // once the wallet has been verified (checked) a real 0, and only
            // "Loading…" before the first check has landed.
            const gl = window.globalLedger && typeof window.globalLedger.get === 'function'
                ? window.globalLedger.get() : null;
            const onChainAvailable = gl && gl.spendableBalance != null;
            const globalChecked = !!(window.globalLedger &&
                typeof window.globalLedger.checked === 'function' &&
                window.globalLedger.checked());
            const pointsText = onChainAvailable
                ? gl.spendableBalance.toLocaleString()
                : (globalChecked ? '0' : 'Loading\u2026');

            pill.innerHTML = `
                <button id="btn-signout" class="auth-btn-small">Sign out</button>
                <span class="auth-user">, ${name}</span>
                ${tierBadge}
                <span id="display-points">${pointsText} Pts</span>
            `;

            const btn = document.getElementById('btn-signout');
            if (btn) {
                btn.onclick = function () {
                    if (window.showConfirmDialog) {
                        window.showConfirmDialog({
                            title: 'Sign out?',
                            message: 'Are you sure you want to sign out? Your points and progress stay saved to your account.',
                            okText: 'Yes, sign out',
                            cancelText: 'Cancel',
                            onOk: async function () {
                                if (window.logoutDynamic) {
                                    await window.logoutDynamic();
                                }
                                updateHeader(null);
                            }
                        });
                    } else {
                        // Fallback: confirm-less direct sign out.
                        if (window.logoutDynamic) {
                            window.logoutDynamic().then(() => updateHeader(null));
                        }
                    }
                };
            }

            // Subscribe to globalLedger ONCE so the pill auto-updates when
            // the async on-chain fetch completes. No race, no blink.
            if (window.globalLedger && typeof window.globalLedger.subscribe === 'function' && !_globalLedgerUnsub) {
                _globalLedgerUnsub = window.globalLedger.subscribe(function (ledger) {
                    var el = document.getElementById('display-points');
                    if (!el) return;
                    if (ledger && ledger.spendableBalance != null) {
                        el.textContent = ledger.spendableBalance.toLocaleString() + ' Pts';
                    } else if (window.globalLedger &&
                        typeof window.globalLedger.checked === 'function' &&
                        window.globalLedger.checked()) {
                        el.textContent = '0 Pts';
                    }
                });
            }

            window.currentUser = {
                id: profile?.id,
                dynamicId: dynamicUser.dynamicId,
                email: dynamicUser.email,
                source: 'dynamic'
            };
            window.currentProfile = profile;

        } else {
            // Logged out state: Sign in button first, points last (points sit
            // next to the menu, so a menu-tap never hits the sign-in button).
            if (_globalLedgerUnsub) { _globalLedgerUnsub(); _globalLedgerUnsub = null; }
            pill.innerHTML = `
                <button id="btn-open-auth" class="auth-btn-small">Sign in</button>
                <span id="display-points">⭐ 0 Pts</span>
            `;

            const btn = document.getElementById('btn-open-auth');
            if (btn) {
                btn.onclick = function () {
                    if (window.openDynamicLogin) {
                        window.openDynamicLogin();
                    }
                };
            }

            window.currentUser = null;
            window.currentProfile = null;
        }
    }

    // Main refresh – Dynamic only (primary)
    window.refreshAuthHeader = async function () {
        const dynamicUser = getDynamicUser();
        await updateHeader(dynamicUser);
    };

    // Award points (used by Ludo later). Optimistic: the header + in-session
    // profile update immediately; the Supabase write is attempted and, if it
    // fails (network hiccup, RLS, devnet-side schedules), the award is queued
    // to localStorage and re-synced on the next page load / auth refresh.
    window.awardGlobalPoints = async function (points, gameId, reason, matchId = null) {
        if (!window.currentUser || !window.currentProfile) {
            if (window.showAuthBanner) window.showAuthBanner('Sign in to earn points', true);
            return false;
        }
        if (points <= 0) return false;

        const oldGlobal = window.currentProfile.global_points || 0;
        const newGlobal = oldGlobal + points;
        const newLifetime = (window.currentProfile.lifetime_points || 0) + points;
        const newLevel = computeLevelFromLifetime(newLifetime);

        // Optimistic in-session bump so the player immediately sees the reward
        // even when the DB is unreachable (points still persist to Supabase on
        // the next successful sync).
        window.currentProfile.global_points = newGlobal;
        window.currentProfile.lifetime_points = newLifetime;
        window.currentProfile.level = newLevel;
        const pill = getPill();
        const pointsEl = pill ? pill.querySelector('#display-points') : null;
        if (pointsEl) pointsEl.textContent = `⭐ ${newGlobal.toLocaleString()} Pts`;
        if (window.showAuthBanner) {
            window.showAuthBanner(`+${points} pts! Total: ${newGlobal}`);
        }

        const award = {
            user_id: window.currentUser.id,
            game_id: gameId,
            points: points,
            reason: reason,
            match_id: matchId,
            created_at: new Date().toISOString()
        };

        let saved = await persistAwardToSupabase(award, {
            global: newGlobal,
            lifetime: newLifetime,
            level: newLevel
        });
        if (!saved) {
            queuePendingAward(award);
            console.warn('[points] Supabase unavailable — reward queued on device for later sync', award);
        }
        return saved;
    };

    // Level ladder used for the global spendable points.
    function computeLevelFromLifetime(lifetimePoints) {
        if (lifetimePoints >= 5000) return 5;
        if (lifetimePoints >= 3000) return 4;
        if (lifetimePoints >= 1000) return 3;
        if (lifetimePoints >= 500) return 2;
        return 1;
    }

    // Best-effort write of one award: insert the audit row, then write the
    // given profile totals (the caller supplies the authoritative numbers —
    // in the live path they already include the optimistic bump).
    async function persistAwardToSupabase(award, totals) {
        if (!window.supabaseClient) return false;
        try {
            const insert = await window.supabaseClient
                .from('point_transactions')
                .insert({
                    user_id: award.user_id,
                    game_id: award.game_id,
                    points: award.points,
                    reason: award.reason,
                    match_id: award.match_id || null
                })
                .select('id')
                .single();

            if (insert.error) {
                console.error('[points] point_transactions insert failed:', insert.error);
                return false;
            }

            const update = await window.supabaseClient
                .from('profiles')
                .update({
                    global_points: totals.global,
                    lifetime_points: totals.lifetime,
                    level: totals.level
                })
                .eq('id', award.user_id)
                .select()
                .single();

            if (update.error) {
                console.error('[points] profiles update failed:', update.error);
                return false;
            }
            if (update.data) window.currentProfile = update.data;
            return true;
        } catch (err) {
            console.error('[points] unexpected Supabase error:', err);
            return false;
        }
    }

    // Bumps the authenticated profile's global/lifetime/level by the award,
    // recomputing FROM the CURRENT in-memory profile (not double counting).
    // Returns true when the update round-trips a row from the DB.
    async function updateProfileTotalsForAward(award) {
        if (!window.supabaseClient) return false;
        try {
            const newGlobal = (window.currentProfile?.global_points || 0) + award.points;
            const newLifetime = (window.currentProfile?.lifetime_points || 0) + award.points;
            const newLevel = computeLevelFromLifetime(newLifetime);

            const update = await window.supabaseClient
                .from('profiles')
                .update({
                    global_points: newGlobal,
                    lifetime_points: newLifetime,
                    level: newLevel
                })
                .eq('id', award.user_id)
                .select()
                .single();

            if (update.error) {
                console.error('[points] profiles update failed:', update.error);
                return false;
            }
            if (update.data) window.currentProfile = update.data;
            return true;
        } catch (err) {
            console.error('[points] unexpected profile update error:', err);
            return false;
        }
    }

    // ---- pending-award queue (device-level backup of the backup) ----
    function pendingAwardKey() {
        return `gfg_pending_awards_${window.currentUser ? window.currentUser.id : 'anon'}`;
    }

    function queuePendingAward(award) {
        try {
            const key = pendingAwardKey();
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            list.push(award);
            localStorage.setItem(key, JSON.stringify(list));
        } catch (e) {
            console.error('[points] failed to queue pending award', e);
        }
    }

    window.getPendingPointAwards = function () {
        try {
            const key = pendingAwardKey();
            return JSON.parse(localStorage.getItem(key) || '[]');
        } catch (e) { return []; }
    };

    // Retry earlier queued awards. Called after auth refresh; de-dupes by
    // match_id so a partially-applied award is never double-counted.
    window.syncPendingPointAwards = async function () {
        if (!window.currentUser || !window.currentProfile) return 0;
        const key = pendingAwardKey();
        const queued = window.getPendingPointAwards();
        if (!queued.length) return 0;

        let synced = 0;
        const remaining = [];

        for (const award of queued) {
            let ok = false;
            // If the same award (match) already landed in Supabase (e.g. the
            // insert succeeded earlier but the profile bump was interrupted),
            // only apply the missing profile bump — never double-insert.
            if (award.match_id) {
                const { data: existing, error } = await window.supabaseClient
                    .from('point_transactions')
                    .select('id')
                    .eq('user_id', award.user_id)
                    .eq('match_id', award.match_id)
                    .maybeSingle();
                if (!error && existing) {
                    ok = await updateProfileTotalsForAward(award);
                } else {
                    ok = await persistAwardToSupabase(award, {
                        global: (window.currentProfile?.global_points || 0) + award.points,
                        lifetime: (window.currentProfile?.lifetime_points || 0) + award.points,
                        level: computeLevelFromLifetime((window.currentProfile?.lifetime_points || 0) + award.points)
                    });
                }
            } else {
                ok = await persistAwardToSupabase(award, {
                    global: (window.currentProfile?.global_points || 0) + award.points,
                    lifetime: (window.currentProfile?.lifetime_points || 0) + award.points,
                    level: computeLevelFromLifetime((window.currentProfile?.lifetime_points || 0) + award.points)
                });
            }

            if (ok) synced++;
            else remaining.push(award);
        }

        localStorage.setItem(key, JSON.stringify(remaining));
        if (synced && typeof window.refreshAuthHeader === 'function') {
            window.refreshAuthHeader();
        }
        if (synced && window.showAuthBanner) {
            window.showAuthBanner(`☁️ ${synced} pending reward${synced > 1 ? 's' : ''} synced`);
        }
        return synced;
    };

    // Wait for Dynamic to restore the OTP session after a page load.
    // createDynamicClient restores auth asynchronously (from localStorage /
    // the Dynamic API), and on a cold page load (e.g. navigating straight to a
    // game page) restore can finish AFTER the old fixed 900ms delay, leaving
    // the header pill stuck on "Sign in" even though the user IS logged in.
    // So we poll until either the user appears or a deadline passes.
    function waitForDynamicSession(timeoutMs = 8000) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeoutMs;
            (function poll() {
                const u = getDynamicUser();
                if (u) return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(poll, 250);
            })();
        });
    }

    // On page load
    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(async () => {
            await waitForDynamicSession();
            await window.refreshAuthHeader();
            // Re-sync any awards queued while Supabase was unreachable.
            if (typeof window.syncPendingPointAwards === 'function') {
                await window.syncPendingPointAwards();
            }
            // If Dynamic finished restoring the session AFTER the first
            // refresh rendered the logged-out pill, render again now that the
            // user is known.
            if (getDynamicUser()) await window.refreshAuthHeader();
        }, 200);
    });
})();