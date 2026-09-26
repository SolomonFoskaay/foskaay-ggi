// profile-core.js
// Shared data helpers for the profile pages (home + detail). Reads the signed-in
// user's own Supabase records and their own on-chain points PDA only.
// Used by /profile/ (home) and its detail pages (/profile/activity.html,
// /profile/points.html).

(function () {

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Load the signed-in user's point_transactions that carry an on-chain
    // match_id (proof-roll signature). Renders into el. `full` fetches all
    // rows (detail pages) vs a leaner cap on the profile home card.
    async function loadOnchainActivity(el, opts) {
        opts = opts || {};
        if (!window.supabaseClient || !window.currentUser) return;
        try {
            const { data, error } = await window.supabaseClient
                .from('point_transactions')
                .select('game_id, points, reason, match_id, created_at')
                .eq('user_id', window.currentUser.id)
                .not('match_id', 'is', null)
                .order('created_at', { ascending: false })
                .limit(opts.full ? 200 : 100);
            if (error) throw new Error(error.message);
            if (!data || !data.length) {
                el.innerHTML = '<p class="empty">No on-chain activity linked to your account yet. Play a match and win to see your verifiable rolls here.</p>';
                return;
            }
            const rows = data.map(t => {
                const game = t.game_id === 'ludo' ? 'Ludo' : esc(t.game_id);
                const reason = t.reason === 'win' ? '🏆 Match won'
                    : t.reason === 'tamper' ? '⚠ Tamper notice'
                    : esc(t.reason || 'Activity');
                const when = t.created_at ? '<span style="color:#666;font-size:0.75rem;"> ' + esc(t.created_at.slice(0, 16).replace('T', ' ')) + '</span>' : '';
                const link = window.gfgExplorer ? window.gfgExplorer.txLink(t.match_id) : esc(t.match_id);
                return `<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <div style="font-weight:600;">${game} · ${reason}${t.points ? ' <span style="color:#f87818;">(+' + esc(t.points) + ' pts)</span>' : ''}</div>
                    <div style="margin-top:4px;">${link}${when}</div>
                    <div style="color:#555;font-size:0.72rem; word-break:break-all; margin-top:2px;">${esc(t.match_id)}</div>
                </div>`;
            });
            if (window.GFG_Pager) {
                GFG_Pager.paginate(el, {
                    items: rows,
                    render: r => r,
                    empty: '<p class="empty">No on-chain activity linked to your account yet. Play a match and win to see your verifiable rolls here.</p>',
                    homePer: 6,
                });
            } else {
                el.innerHTML = rows.join('');
            }
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not load on-chain activity (' + esc(e.message) + ').</p>';
        }
    }

    // Render the signed-in user's per-game (M3) ledger card from a ledger
    // snapshot (the module's cached/notified value, or a fresh fetch). Pure
    // sync render — never re-fetches — so repeated updates never flicker.
    function renderPointsLedgerCard(el, ledger, gameTag) {
        const lastTs = ledger.lastRecordedTs
            ? new Date(ledger.lastRecordedTs).toLocaleString() : '—';
        const reasonLabel = ledger.lastReason === 1 ? 'Match won (1st place)'
            : (ledger.lastReason === 2 ? 'Match won (2nd place)'
            : (ledger.lastReason === 3 ? 'Match won (3rd place)'
            : (ledger.lastReason ? 'Award (' + ledger.lastReason + ')' : '—')));
        const pda = window.magicblockDice && typeof window.magicblockDice.corePda === 'function'
            ? window.magicblockDice.corePda() : null;
        const pdaLink = (pda && window.gfgExplorer)
            ? window.gfgExplorer.accountLink(pda) : (pda ? esc(pda) : '—');
        el.innerHTML = `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Lifetime points (pure)</span>
                    <b style="color:#f87818; font-size:1.15rem;">${ledger.pureLifetime}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spendable points</span>
                    <b style="color:#7838f8;">${ledger.spendableBalance}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Rewards recorded</span>
                    <b>${ledger.awardCount}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last award</span>
                    <b>+${ledger.lastPoints} <span style="color:#666;font-size:0.78rem;">(${esc(reasonLabel)})</span></b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last recorded</span>
                    <b style="font-size:0.82rem;">${esc(lastTs)}</b>
                </div>
                ${ledger.spendCount ? `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Local spends</span>
                    <b>${ledger.spendCount}</b>
                </div>` : ''}
                <div style="padding:8px 0;">
                    <span style="color:var(--muted); font-size:0.82rem;">Your Player Core account (all games)</span>
                    <div style="margin-top:4px;">${pdaLink}</div>
                </div>`;
    }

    // Load the signed-in user's own on-chain points PDA ledger (gasless read,
    // own account only, per-game ledger). Pass a ledger snapshot to render it
    // synchronously (no fetch, no flicker); without one it fetches then renders.
    // Returns the ledger (or null).
    async function loadPointsLedger(el, gameTag, ledger) {
        gameTag = gameTag || 'ludo';
        if (ledger && ledger.spendableBalance != null) {
            renderPointsLedgerCard(el, ledger, gameTag);
            return ledger;
        }
        // ARC (arcv2m17 audit): read through the chain gateway, never the
        // Solana SDK. Previously this page issued a Solana read on Arc.
        try {
            if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                const arcLedger = await window.gfgChain.fetchLedger(gameTag);
                if (arcLedger) { renderPointsLedgerCard(el, arcLedger, gameTag); return arcLedger; }
                el.innerHTML = '<p class="empty">Your ledger has no rewards yet. Win a match and your reward is written here permanently.</p>';
                return null;
            }
        } catch (e) { /* soft: fall through to the Solana path below */ }
        const magic = window.magicblockDice;
        if (!magic || typeof magic.fetchPointsPda !== 'function' || typeof magic.pointsPda !== 'function') {
            el.innerHTML = '<p class="empty">On-chain ledger unavailable (wallet not ready).</p>';
            return null;
        }
        const pda = magic.pointsPda(gameTag);
        if (!pda) {
            el.innerHTML = '<p class="empty">Connect your wallet to see your on-chain ledger.</p>';
            return null;
        }
        try {
            const fetched = await magic.fetchPointsPda(gameTag);
            if (!fetched) {
                el.innerHTML = '<p class="empty">Your ledger account has no rewards yet. Win a match and your reward is written here permanently.</p>';
                return null;
            }
            renderPointsLedgerCard(el, fetched, gameTag);
            return fetched;
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not read your ledger (' + esc(e.message) + ').</p>';
            return null;
        }
    }

    // Collapsible homepage sections: sections marked .dash-section render
    // EXPANDED by default; clicking the header row collapses the section and
    // shows a one-line summary. Bound once on the header row so the inline
    // onclick + button listener never double-fire.
    function bindFolds() {
        document.querySelectorAll('.dash-section').forEach(function (section) {
            const head = section.querySelector('.dash-fold-head');
            const toggle = section.querySelector('.dash-fold-toggle');
            if (!head) return;
            const syncLabel = function () {
                if (toggle) {
                    toggle.textContent = section.classList.contains('collapsed') ? '＋ Expand' : '− Collapse';
                }
            };
            syncLabel();
            head.addEventListener('click', function () {
                section.classList.toggle('collapsed');
                syncLabel();
            });
        });
    }

    // Render the global (M4) ledger card from a ledger snapshot. Pure sync
    // render — never re-fetches — so repeated updates never flicker.
    function renderGlobalLedgerCard(el, ledger) {
        const lastTs = ledger.lastRecordedTs
            ? new Date(ledger.lastRecordedTs).toLocaleString() : '—';
        const pda = window.magicblockDice && typeof window.magicblockDice.corePda === 'function'
            ? window.magicblockDice.corePda() : null;
        const pdaLink = (pda && window.gfgExplorer)
            ? window.gfgExplorer.accountLink(pda) : (pda ? esc(pda) : '—');
        const fmt = (n) => (n ?? 0).toLocaleString();
        const sourceLabel = GLOBAL_SOURCE_LABEL(ledger.lastSource);
        el.innerHTML = `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Pure (unspendable, never multiplied)</span>
                    <b style="color:#f87818;font-size:1.15rem;">${fmt(ledger.pureLifetime)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Lifetime (unspendable, all sources)</span>
                    <b style="color:#7838f8;">${fmt(ledger.lifetime)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spendable</span>
                    <b style="color:#2ecc71;">${fmt(ledger.spendableBalance)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Game credits</span>
                    <b>${ledger.awardCount ?? 0}</b>
                </div>
                ${ledger.spendCount ? `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spends</span>
                    <b>${ledger.spendCount}</b>
                </div>` : ''}
                ${ledger.lastPoints ? `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last credit</span>
                    <b>+${fmt(ledger.lastPoints)} <span style="color:#666;font-size:0.78rem;">(${esc(sourceLabel)})</span></b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last credit time</span>
                    <b style="font-size:0.82rem;">${esc(lastTs)}</b>
                </div>` : ''}
                <div style="padding:8px 0;">
                    <span style="color:var(--muted);font-size:0.82rem;">Global ledger account (yours, site-wide)</span>
                    <div style="margin-top:4px;">${pdaLink}</div>
                </div>`;
    }

    // Map an M4 lastSource code to a human label (mirrors global-ledger
    // SOURCE_CODES). 0 / unknown -> a neutral line.
    function GLOBAL_SOURCE_LABEL(code) {
        switch (Number(code)) {
            case 1: return 'Ludo win';
            case 2: return 'Ayo Olopon win';
            case 10: return 'Signup bonus';
            case 11: return 'Referral';
            case 12: return 'Giveaway';
            case 13: return 'Active Tier boost';
            default: return 'Award';
        }
    }

    async function loadGlobalLedger(el, ledger) {
        if (ledger && ledger.spendableBalance != null) {
            renderGlobalLedgerCard(el, ledger);
            return ledger;
        }
        // ARC (arcv2m17 audit): gateway read, no Solana SDK.
        try {
            if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                const arcLedger = await window.gfgChain.fetchGlobalLedger();
                if (arcLedger) { renderGlobalLedgerCard(el, arcLedger); return arcLedger; }
                el.innerHTML = '<p class="empty">No global ledger yet. Win a match to create your cross-game record.</p>';
                return null;
            }
        } catch (e) { /* soft */ }
        const magic = window.magicblockDice;
        if (!magic || typeof magic.fetchGlobalPointsPda !== 'function') {
            el.innerHTML = '<p class="empty">Global ledgers unavailable (wallet not ready).</p>';
            return null;
        }
        const pda = magic.globalPointsPda();
        if (!pda) {
            el.innerHTML = '<p class="empty">Connect your wallet to see your global ledgers.</p>';
            return null;
        }
        try {
            const fetched = await magic.fetchGlobalPointsPda();
            if (!fetched) {
                el.innerHTML = '<p class="empty">No global ledger account yet. Win a match to create your cross-game record.</p>';
                return null;
            }
            renderGlobalLedgerCard(el, fetched);
            return fetched;
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not read global ledgers (' + esc(e.message) + ').</p>';
            return null;
        }
    }

    function renderPremiumLedgerCard(el, ledger) {
        const lastCreditTs = ledger.lastCreditTs ? new Date(ledger.lastCreditTs).toLocaleString() : '—';
        const lastSpendTs = ledger.lastSpendTs ? new Date(ledger.lastSpendTs).toLocaleString() : '—';
        const subUntil = ledger.subscriptionActiveUntil ? new Date(ledger.subscriptionActiveUntil).toLocaleString() : '—';
        const subLabel = ledger.subscriptionLevel ? 'Level ' + ledger.subscriptionLevel : 'Level 0 (free)';
        const daysLeft = ledger.subscriptionActiveUntil && ledger.subscriptionActiveUntil > Date.now() ? Math.ceil((ledger.subscriptionActiveUntil - Date.now())/86400000) : 0;
        const subStatus = ledger.subscriptionLevel > 0 && daysLeft > 0 ? `Active — ${daysLeft}d left` : (ledger.subscriptionLevel > 0 ? 'Expired' : 'No active subscription');
        const pda = window.magicblockDice && typeof window.magicblockDice.corePda === 'function' ? window.magicblockDice.corePda() : null;
        const pdaLink = (pda && window.gfgExplorer) ? window.gfgExplorer.accountLink(pda) : (pda ? esc(pda) : '—');
        el.innerHTML = `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Lifetime premium (never spent)</span>
                    <b style="color:#f87818; font-size:1.15rem;">${(ledger.premiumLifetime||0).toLocaleString()}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spendable premium</span>
                    <b style="color:#7838f8;">${(ledger.premiumSpendable||0).toLocaleString()}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Subscription</span>
                    <b>${esc(subLabel)} <span style="color:#666;font-size:0.78rem;">(${esc(subStatus)})</span></b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Active until</span>
                    <b style="font-size:0.82rem;">${esc(subUntil)}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Premium payments received</span>
                    <b>1 <span style="color:#666;font-size:0.78rem;">(latest +${ledger.lastCreditPoints || 0}P)</span></b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last credit source</span>
                    <b style="font-size:0.82rem; text-align:right;">${PREMIUM_REASON_LABEL(ledger.lastCreditReason)}<span style="display:block;color:#666;font-size:0.72rem;">${esc(lastCreditTs)}</span></b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Payment reference (invoice)</span>
                    <b style="font-family:monospace; font-size:0.78rem; word-break:break-all;">${ledger.lastCreditRef ? esc(String(ledger.lastCreditRef)) : '—'}</b>
                </div>
                ${ledger.lastSpendTs ? `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last spend/activate</span>
                    <b style="font-size:0.82rem;">${esc(String(ledger.lastSpendRef||''))} <span style="color:#666;font-size:0.72rem;">${esc(lastSpendTs)}</span></b>
                </div>` : ''}
                <div style="padding:8px 0;">
                    <span style="color:var(--muted); font-size:0.82rem;">Premium ledger account (yours, buy-only)</span>
                    <div style="margin-top:4px;">${pdaLink}</div>
                    <div style="color:#666;font-size:0.75rem;margin-top:6px;">How you get it: you pay for a plan or booster, support verifies the payment and credits premium points to your premium ledger (on-chain, platform pays the network fees). Premium never comes from wins or daily. You can quote the payment reference as your receipt.</div>
                </div>`;
    }

    async function loadPremiumLedger(el, ledger) {
        if (ledger && ledger.premiumLifetime != null) {
            renderPremiumLedgerCard(el, ledger);
            return ledger;
        }
        // ARC (arcv2m17 audit): gateway read, no Solana SDK.
        try {
            if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                const arcLedger = await window.gfgChain.fetchPremiumLedger();
                if (arcLedger) { renderPremiumLedgerCard(el, arcLedger); return arcLedger; }
                el.innerHTML = '<p class="empty">No premium points yet. Premium points come from a verified payment. <a href="/profile/subscription.html" style="color:#f87818;">Go Premium</a></p>';
                return null;
            }
        } catch (e) { /* soft */ }
        const magic = window.magicblockDice;
        if (!magic || typeof magic.fetchPremiumPointsPdaFor !== 'function') {
            el.innerHTML = '<p class="empty">Premium ledger unavailable (wallet not ready).</p>';
            return null;
        }
        const w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
        const wallet = w || (window.currentProfile ? window.currentProfile.solana_wallet : null);
        if (!wallet) {
            el.innerHTML = '<p class="empty">Connect your wallet to see your premium ledger.</p>';
            return null;
        }
        try {
            const fetched = await magic.fetchPremiumPointsPdaFor(typeof wallet === 'string' ? wallet : wallet.address || wallet);
            if (!fetched) {
                el.innerHTML = '<p class="empty">No premium points yet. Premium points are only gotten by paying (crypto) after support verifies your payment — they buy your plan or booster. <a href="/profile/subscription.html" style="color:#f87818;">Go Premium</a></p>';
                return null;
            }
            renderPremiumLedgerCard(el, fetched);
            return fetched;
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not read premium ledger (' + esc(e.message) + ').</p>';
            return null;
        }
    }

    // On-chain premium credit reason (M3/M4-style tag stored in last_credit_reason).
    function PREMIUM_REASON_LABEL(code) {
        switch (code) {
        case 1: return 'Subscription / plan payment';
            case 2: return 'In-game premium purchase';
            case 3: return 'Promo / giveaway credit';
            case 4: return 'Booster purchase';
            default: return 'Subscription / plan payment';
        }
    }

    window.ProfileCore = { esc, loadOnchainActivity, loadPointsLedger, loadGlobalLedger, loadPremiumLedger, renderPremiumLedgerCard, PREMIUM_REASON_LABEL, bindFolds };

})();
