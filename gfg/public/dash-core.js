// dash-core.js
// Shared data + rendering helpers for the dashboard pages (home + detail).
// Loads server-probed data (ops, endpoints, accounts) and off-chain stats,
// plus the changelog roadmap pipeline and tamper notices. Each dashboard page
// calls the loaders it needs and renders into its own containers.
//
// Also exposes the staff gate so detail pages enforce the same admin-only
// access as the dashboard home (client-side UX gate only, per AGENTS.md).

(function () {

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const statusTag = (status) => {
        const label = status === 'in-progress' ? 'In progress' : status === 'shipped' ? 'Shipped' : 'Planned';
        const cls = status === 'in-progress' ? 'in-progress' : '';
        return `<span class="badge b-status ${cls}">${label}</span>`;
    };

    // Route a list through the shared pager if present, else render plain.
    function pagerOrRaw(el, items, render, opts) {
        opts = opts || {};
        if (window.GFG_Pager) {
            GFG_Pager.paginate(el, Object.assign({}, opts, { items, render }));
        } else {
            el.innerHTML = (opts.header || '') + items.map(render).join('') + (opts.footer || '');
        }
    }

    // Staff gate mirrors the changelog admin page (client-side UX gate).
    // Fixed 2026-08-21: wait for Dynamic wallet to restore before checking role,
    // and cache the result so a slow restore never falsely redirects an admin.
    // Fixed 2026-08-23: role resolution no longer depends on changelog/render.js
    // (getChangelogRole) - several admin pages don't load it, which made the gate
    // bounce admins. Now falls back to reading roles.json directly. It also never
    // redirects when the wallet simply hasn't resolved (slow session) - only a
    // KNOWN non-staff wallet redirects.
    let gateCache = null;
    let gatePending = null;
    async function isStaffWallet(w) {
        try {
            if (window.getChangelogRole) {
                const r = await window.getChangelogRole();
                if (r === 'admin' || r === 'moderator') return true;
            }
        } catch (e) { /* fall through */ }
        try {
            const resp = await fetch('/changelog/roles.json', { cache: 'no-store' });
            const j = await resp.json();
            const lists = [].concat(j.admin || [], j.moderator || []);
            const wl = String(w || '').toLowerCase();
            if (!wl) return false;
            return lists.some(x => String(x).toLowerCase() === wl);
        } catch (e) { return false; }
    }
    async function gateStaff() {
        if (gateCache === true) return true;
        if (gateCache === false) { window.location.replace('/'); return false; }
        if (gatePending) return gatePending;
        gatePending = (async () => {
            let walletKnown = false;
            let wallet = null;
            // Wait up to 10s for the wallet session to restore (Dynamic is async)
            for (let i = 0; i < 20; i++) {
                try {
                    const w = window.getDynamicSolanaWallet ? window.getDynamicSolanaWallet() : null;
                    const p = window.currentProfile && window.currentProfile.solana_wallet ? window.currentProfile.solana_wallet : null;
                    wallet = w || p || null;
                    if (wallet) { walletKnown = true; break; }
                } catch (e) {}
                await new Promise(r => setTimeout(r, 500));
            }
            if (!walletKnown) return false; // slow session: never bounce a real admin
            const staff = await isStaffWallet(wallet);
            if (staff) { gateCache = true; return true; }
            gateCache = false;
            window.location.replace('/');
            return false;
        })();
        const res = await gatePending;
        gatePending = null;
        return res;
    }

    // ---------- Ops panel + endpoint watchlist (server probe) ----------
    async function loadProbe(opts) {
        opts = opts || {};
        const opsEl = document.getElementById(opts.opsEl || 'dash-ops-grid');
        const gasEl = opts.gasEl ? document.getElementById(opts.gasEl) : null;
        const epEl = document.getElementById(opts.epEl || 'dash-endpoints-list');
        const accountsEl = document.getElementById(opts.accountsEl);
        const btn = document.getElementById(opts.refreshBtn || 'ep-refresh');
        const lastCheckedEl = document.getElementById(opts.lastCheckedEl || 'ep-last-checked');
        if (opsEl) opsEl.innerHTML = '<p class="empty">Loading…</p>';
        if (gasEl) gasEl.innerHTML = '<p class="empty">Loading…</p>';
        if (epEl) epEl.innerHTML = '<p class="empty">Loading…</p>';
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/endpoints', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

            if (lastCheckedEl && data.generatedAt) {
                lastCheckedEl.textContent =
                    '· checked ' + new Date(data.generatedAt).toLocaleTimeString() + (data.environment ? ' (' + data.environment + ')' : '');
            }

            if (accountsEl) renderAccounts(data, accountsEl, opts.accountsLastEl);

            if (opsEl) renderOps(data, opsEl);

            if (gasEl) renderGas(data, gasEl);

            if (epEl) renderEndpoints(data, epEl);
        } catch (e) {
            if (opsEl) opsEl.innerHTML = '<p class="empty">Ops panel unavailable (' + esc(e.message) + ').</p>';
            if (epEl) epEl.innerHTML = '<p class="empty">Watchlist unavailable (' + esc(e.message) + '). Is the relay (npm run relay / api function) running?</p>';
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function renderOps(data, el) {
        const ops = data.ops || {};
        const cards = [];
        cards.push({ k: 'Version', v: 'v' + (ops.version || '—') });
        cards.push({ k: 'Git ref', v: (ops.gitRef || '—').slice(0, 10) });
        const rc = ops.roadmapCounts;
        if (rc) cards.push({ k: 'Roadmap', v: `${rc.planned} planned · ${rc.inProgress} in-progress · ${rc.shipped} shipped`, small: true });
        if (ops.sponsor) {
            const b = ops.sponsor.balanceSol;
            const cls = b == null ? 'bad' : b < 1 ? 'warn' : 'ok';
            cards.push({ k: 'Sponsor balance', v: b == null ? 'n/a' : b + ' SOL', cls });
        }
        if (ops.ledger && !ops.ledger.error) {
            cards.push({ k: 'Sponsor spend', v: ops.ledger.globalSpentSol + ' SOL · ' + ops.ledger.playersCount + ' player(s)', small: true });
            cards.push({ k: 'Spend caps', v: `${ops.ledger.perPlayerCapSol} / ${ops.ledger.globalCapSol} SOL · reserve ${ops.ledger.reserveSol}`, small: true });
            const an = ops.ledger.analytics;
            if (an) {
                const bat = an.battery || {};
                const tierLabel = { full: 'Healthy', low: 'Low', critical: 'Critical', unknown: 'Unknown' }[bat.tier] || 'Healthy';
                const tCls = bat.tier === 'full' ? 'ok' : bat.tier === 'low' ? 'warn' : 'bad';
                cards.push({ k: `Gas reserve · ${tierLabel}`, v: bat.tier === 'critical' ? 'Need top-up' : bat.balanceSol == null ? 'balance read failed' : bat.balanceSol + ' / ' + bat.tankSol + ' SOL', cls: tCls, html: batteryMeter(bat) });
                const cap = an.cap;
                if (cap && cap.limitSol) {
                    cards.push({ k: `Global spend cap · ${cap.tier === 'critical' ? 'Critical' : cap.tier === 'low' ? 'Low' : 'Healthy'}`, v: cap.spentSol + ' / ' + cap.limitSol + ' SOL' + (cap.tier === 'critical' ? ' · onboarding will pause' : ''), cls: cap.tier === 'full' ? 'ok' : 'warn', html: capMeter(cap) });
                }
                cards.push({ k: 'Avg player onboarding', v: an.avgOnboardingSol + ' SOL', small: true });
                cards.push({ k: 'Players funded / SOL', v: an.playersPerSol + ' fresh player(s)', small: true });
                cards.push({ k: 'Burn rate (7d avg)', v: (an.burnPerDaySol || 0) + ' SOL/day', small: true });
                const f = an.forecasts || {};
                const f1 = f['1 SOL'], f5 = f['5 SOL'], f25 = f['25 SOL'];
                cards.push({ k: 'Forecast · 1 SOL', v: (f1 ? `${f1.playersFunded} players` : 'n/a') + (f1 && f1.runwayMonths != null ? ` · ${f1.runwayMonths} mo` : ''), small: true });
                cards.push({ k: 'Forecast · 5 SOL', v: (f5 ? `${f5.playersFunded} players` : 'n/a') + (f5 && f5.runwayMonths != null ? ` · ${f5.runwayMonths} mo` : ''), small: true });
                cards.push({ k: 'Forecast · 25 SOL', v: (f25 ? `${f25.playersFunded} players` : 'n/a') + (f25 && f25.runwayMonths != null ? ` · ${f25.runwayMonths} mo` : ''), small: true });
            }
        }
        if (ops.compState) {
            const cs = ops.compState;
            if (cs.error) {
                cards.push({ k: 'Competition escrow (S2)', v: 'unavailable (' + esc(cs.error) + ')', small: true, cls: 'warn' });
            } else if (cs.state) {
                const st = cs.state;
                const stateCls = st.state === 'Settled' ? 'ok' : st.state === 'Funded' ? 'warn' : 'ok';
                cards.push({
                    k: 'Competition escrow (S2)',
                    v: '#' + (st.compId || '—') + ' · ' + st.state + ' · 🏆 ' + (st.prizePool || 0).toLocaleString() + ' pts',
                    cls: stateCls,
                    small: true,
                    html: `<div class="v small ${stateCls}">#${esc(st.compId || '—')} · ${esc(st.state)}</div>
                        <div class="k">Prize pool</div><div class="v">${(st.prizePool || 0).toLocaleString()} pts</div>
                        <div class="k">Winners settled</div><div class="v">${st.winnerCount || 0} / 3</div>`,
                });
            }
        }
        if (ops.inventory) {
            cards.push({ k: 'gfg-dice program', v: ops.inventory.gfgDiceProgram, small: true });
            cards.push({ k: 'ER VRF queue', v: ops.inventory.erVrfQueue, small: true });
            cards.push({ k: 'Base VRF queue', v: ops.inventory.baseVrfQueue, small: true });
            cards.push({ k: 'ER validator', v: ops.inventory.erValidator, small: true });
        }
        if (!cards.length) {
            el.innerHTML = '<p class="empty">No ops data.</p>';
            return;
        }
        pagerOrRaw(el, cards, c =>
            `<div class="ops-card"><div class="k">${esc(c.k)}</div>` +
            `<div class="v ${c.cls || ''} ${c.small ? 'small' : ''}">${c.html || esc(c.v)}</div></div>`,
            {
                wrap: pageHtml => `<div class="ops-grid">${pageHtml}</div>`,
                empty: '<p class="empty">No ops data.</p>',
                homePer: 12,
            });
    }

    // ---------- Gas analytics feed (ops.html + dashboard home) ----------
    const CATEGORY_LABEL = {
        onboarding: 'Player onboarding',
        house: 'House / computer seats',
        roll: 'Fallback base rolls',
    };
    const CATEGORY_COLOR = {
        onboarding: '#f87818',
        house: '#7838f8',
        roll: '#3498db',
    };

    // Battery meter: — a horizontal gauge showing the gas reserve vs the tank.
    function batteryMeter(bat) {
        if (!bat) return '';
        if (bat.tier === 'unknown' || bat.pct == null) {
            return `<div class="gas-battery unknown" title="Balance read failed (sponsor keypair not resolvable)">
            <div class="gas-battery-fill" style="width:0%"></div>
            <span class="gas-battery-txt">n/a</span>
        </div>`;
        }
        const pct = bat.pct || 0;
        const tier = pct >= 50 ? 'full' : pct >= 25 ? 'low' : 'critical';
        return `<div class="gas-battery ${tier}" title="${esc(bat.balanceSol)} / ${esc(bat.tankSol)} SOL reserve">
            <div class="gas-battery-fill" style="width:${pct}%"></div>
            <span class="gas-battery-txt">${pct}%</span>
        </div>`;
    }

    // Spend-cap meter: how much of the global onboarding cap has been used.
    function capMeter(cap) {
        if (!cap) return '';
        const pct = cap.pct || 0;
        const tier = cap.tier === 'critical' ? 'critical' : cap.tier === 'low' ? 'low' : 'full';
        return `<div class="gas-battery ${tier}" title="${esc(cap.spentSol)} / ${esc(cap.limitSol)} SOL global spend cap used">
            <div class="gas-battery-fill" style="width:${Math.min(100, pct)}%"></div>
            <span class="gas-battery-txt">${pct}%</span>
        </div>`;
    }

    // Donut chart (inline SVG, no deps) for "what aspect burns the most gas".
    function donutSvg(parts, size) {
        size = size || 120;
        const stroke = Math.max(14, Math.round(size * 0.2));
        const total = parts.reduce((s, p) => s + p.value, 0);
        if (!total) return '';
        const r = (size - stroke) / 2;
        const c = 2 * Math.PI * r;
        let offset = 0;
        const segs = parts.map(p => {
            const frac = p.value / total;
            const dash = frac * c;
            const seg = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${p.color}" stroke-width="${stroke}" stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
            offset += dash;
            return seg;
        }).join('');
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-label="gas spend by category">${segs}</svg>`;
    }

    // Small horizontal bar row: label + filled bar + value.
    function barRow(label, lamports, max, totalLamports, color) {
        const w = max > 0 ? Math.max(2, Math.round(100 * lamports / max)) : 0;
        const sol = (lamports / 1e9).toFixed(4);
        const pct = totalLamports > 0 ? Math.round(100 * lamports / totalLamports) : 0;
        return `<div class="gas-bar-row">
            <span class="gas-bar-label">${esc(label)}</span>
            <div class="gas-bar-track"><div class="gas-bar-fill" style="width:${w}%;background:${color};"></div></div>
            <span class="gas-bar-val">${sol} SOL${totalLamports > 0 ? ' · ' + pct + '%' : ''}</span>
        </div>`;
    }

    function renderGas(data, el) {
        if (!el) return;
        el.innerHTML = '<p class="empty">Loading…</p>';
        const ops = (data && data.ops) || {};
        const ledger = ops.ledger;
        if (!ledger || ledger.error) {
            el.innerHTML = '<p class="empty">Gas analytics unavailable (' + esc((ledger && ledger.error) || 'no ledger') + ').</p>';
            return;
        }
        const an = ledger.analytics;
        if (!an) {
            el.innerHTML = '<p class="empty">Gas analytics not in this probe payload yet.</p>';
            return;
        }
        el.innerHTML = gasFeedHtml(an, ops.sponsor || {}, ledger);
    }

    function gasFeedHtml(an, sponsor, ledger) {
        const bat = an.battery || {};
        const categories = an.categories || [];
        const parts = categories.map(cat => ({
            label: CATEGORY_LABEL[cat.category] || cat.category,
            color: CATEGORY_COLOR[cat.category] || '#8e44ad',
            value: cat.lamports,
            sol: cat.sol,
        }));
        const topCount = Math.min((an.topPlayers || []).length, 5);
        const topRows = (an.topPlayers || []).slice(0, topCount).map((p, i) => `
            <tr><td>#${i + 1}</td><td class="mono">${esc(p.pubkey.slice(0, 6))}…${esc(p.pubkey.slice(-4))}</td><td>${esc(p.sol)} SOL</td></tr>`).join('');
        const totalSol = an.totalSol || 0;

        const dayMax = Math.max(...(an.periods.day || []).map(b => b.lamports), 1);
        const weekMax = Math.max(...(an.periods.week || []).map(b => b.lamports), 1);
        const monthMax = Math.max(...(an.periods.month || []).map(b => b.lamports), 1);
        const recentDays = (an.periods.day || []).slice(-7);
        const recentWeeks = (an.periods.week || []).slice(-6);
        const recentMonths = (an.periods.month || []).slice(-6);

        const f = an.forecasts || {};
        const fc = (key, name) => {
            const v = f[key];
            if (!v) return '';
            return `<div class="ops-card"><div class="k">${esc(name)}</div><div class="v small">
                ${v.playersFunded} fresh player(s)` + (v.runwayMonths != null ? `<br>≈ ${v.runwayMonths} months of play` : '<br>runway n/a (no recent burn)') + `</div></div>`;
        };

        return `<div class="gas-grid">
            <div class="gas-cell gas-cell-wide">
                <div class="k">Gas reserve (sponsor wallet)</div>
                <div>
                    ${batteryMeter(bat)}
                </div>
                <div class="gas-meta">${esc(bat.balanceSol)} of ${esc(bat.tankSol)} SOL tank · reserve floor ${esc((ledger && ledger.reserveSol) || 0.3)} SOL</div>
                <div class="gas-note">${
                    bat.tier === 'unknown'
                        ? 'Sponsor balance could not be read (keypair not resolvable on this host). The relay likely still works; check that GFG_Gasless_Sponsor_Keypair is set for this deployment.'
                        : bat.tier === 'critical'
                            ? 'Critical: the sponsor wallet is close to the reserve floor. Top it up from your own wallet soon or fresh players will stop onboarding.'
                            : bat.tier === 'low'
                                ? 'Low: plan a top-up of the sponsor wallet. It is the same deployer keypair, so a manual send there refills it.'
                                : 'The sponsor wallet is the gas tank (same deployer keypair). Nothing auto-refills it, so top it up yourself whenever this looks low.'
                }</div>
            </div>

            <div class="gas-cell">
                <div class="k">Global spend cap (onboarding)</div>
                <div>
                    ${capMeter(an.cap)}
                </div>
                <div class="gas-meta">${esc((an.cap && an.cap.spentSol) || 0)} of ${esc((an.cap && an.cap.limitSol) || 0)} SOL used · pause at ${esc((an.cap && an.cap.limitSol) || 0)} SOL</div>
                <div class="gas-note">${
                    an.cap && an.cap.tier === 'critical'
                        ? 'Critical: onboarding budget nearly used. Fresh players will stop being sponsored. Top up the sponsor wallet to reset the meter.'
                        : an.cap && an.cap.tier === 'low'
                            ? 'Low: onboarding budget past halfway. Plan a sponsor top-up before fresh players stop onboarding.'
                            : 'The global cap is a safety tripwire so an exploit cannot drain the sponsor wallet. It is not a per-player fee.'
                }</div>
            </div>

            <div class="gas-cell">
                <div class="k">What burns the reserve</div>
                <div style="display:flex;align-items:center;gap:14px;margin-top:8px;">
                    <div>${donutSvg(parts, 110)}</div>
                    <div style="flex:1;min-width:0;">
                        ${(parts.length ? parts : [{ label: 'No spend yet', color: '#555', value: 1, sol: 0 }]).map(p => `
                            <div class="gas-legend"><span class="gas-dot" style="background:${p.color}"></span>
                            <span class="gas-legend-label">${esc(p.label)}</span>
                            <span class="gas-legend-val">${(p.sol || 0).toFixed(4)} SOL</span></div>`).join('')}
                    </div>
                </div>
                <div class="gas-note">Rolls are gasless on the ER, so all sponsor gas is account setup (init + delegate). More games cost ~nothing; more players cost onboarding.</div>
            </div>

            <div class="gas-cell">
                <div class="k">Top spenders (${topCount} of ${(an.topPlayers || []).length})</div>
                <table class="mini-table"><thead><tr><th>#</th><th>Player</th><th>Setup cost</th></tr></thead>
                <tbody>${topRows || '<tr><td colspan="3">No sponsored players yet.</td></tr>'}</tbody></table>
            </div>

            <div class="gas-cell">
                <div class="k">Burn rate</div>
                <div class="gas-big">${(an.burnPerDaySol || 0).toFixed(4)} <span class="gas-unit">SOL/day</span></div>
                <div class="gas-note">7-day average from the spend-event log. Total: ${esc(totalSol)} SOL across ${esc(ledger.playersCount)} player(s).</div>
                <div class="gas-note" style="color:#f87818;">Avg onboarding: ${esc(an.avgOnboardingSol)} SOL · funds ${esc(an.playersPerSol)} fresh player(s) per SOL.</div>
            </div>

            <div class="gas-cell gas-cell-wide">
                <div class="k">Gas spend over time</div>
                <div class="gas-sub">Last 7 days</div>
                ${recentDays.map(b => barRow(b.label, b.lamports, dayMax, an.totalLamports, '#f87818')).join('')}
                <div class="gas-sub">Last 6 weeks</div>
                ${recentWeeks.map(b => barRow(b.label, b.lamports, weekMax, an.totalLamports, '#7838f8')).join('')}
                <div class="gas-sub">Last 6 months</div>
                ${recentMonths.map(b => barRow(b.label, b.lamports, monthMax, an.totalLamports, '#3498db')).join('')}
            </div>

            <div class="gas-cell gas-cell-wide">
                <div class="k">Forecasts</div>
                <div class="gas-sub">If the reserve holds N SOL, here is what it pays for today (devnet costs; mainnet gasless rolls stay free, onboarding is the cost). Refills are manual.</div>
                <div class="ops-grid">
                    ${fc('1 SOL', 'Forecast · 1 SOL')}${fc('5 SOL', 'Forecast · 5 SOL')}${fc('25 SOL', 'Forecast · 25 SOL')}
                </div>
            </div>
        </div>`;
    }

    function renderEndpoints(data, el) {
        const watch = data.watchlist || [];
        const downs = watch.filter(w => !w.ok).length;
        const footer = downs
            ? `<p class="muted-note" style="color:#e74c3c;">⚠ ${downs} of ${watch.length} checks failing — see detail above and the server logs.</p>`
            : '';
        pagerOrRaw(el, watch, w => `
            <div class="ep-row">
                <span class="ep-dot ${w.ok ? 'ok' : 'down'}"></span>
                <span class="ep-name">${esc(w.name)}</span>
                <span class="ep-tag ${esc(w.access)}">${esc(w.access)}</span>
                <span class="ep-lat">${w.latencyMs != null ? w.latencyMs + 'ms' : '—'}</span>
                <span class="ep-detail">${esc(w.detail)}</span>
            </div>`,
            {
                empty: '<p class="empty">No endpoints in the watchlist.</p>',
                footer,
                homePer: 6,
            });
    }

    // ---------- Wallets & accounts tracker ----------
    function linkTag(address, isAccount) {
        if (!window.gfgExplorer) return '<span class="mono">' + esc(address) + '</span>';
        return window.gfgExplorer[isAccount ? 'accountLink' : 'txLink'](address);
    }

    function renderAccounts(data, el, stampEl) {
        if (!el) return;
        const acc = data.ops && data.ops.accounts;
        if (stampEl && data.generatedAt) stampEl.textContent = '· checked ' + new Date(data.generatedAt).toLocaleTimeString();

        if (!acc || acc.error) {
            el.innerHTML = '<p class="empty">Accounts tracker unavailable (' + esc((acc && acc.error) || 'no data') + ').</p>';
            return;
        }
        const accounts = (acc.accounts || []).map(a => {
            const deleg = a.delegated == null
                ? '—'
                : a.delegated
                    ? `<span style="color:#2ecc71;">✓ delegated</span>${a.delegationDetail ? ' <span style="color:#999;font-size:0.78rem;">' + esc(a.delegationDetail) + '</span>' : ''}`
                    : `<span style="color:#e74c3c;">✗ not delegated</span>`;
            const txs = (a.latestTxs || []).map(t => {
                const when = t.blockTime ? ' <span style="color:#666;font-size:0.72rem;">' + esc(t.blockTime.slice(0, 16).replace('T', ' ')) + '</span>' : '';
                return `<div style="margin:2px 0;">${linkTag(t.signature, false)}${when}</div>`;
            }).join('');
            const bal = a.balanceSol != null ? esc(a.balanceSol) + ' SOL' : (a.balanceError ? 'err' : '—');
            return `<tr>
                <td>${esc(a.role)}<br><span class="mono">${linkTag(a.address, true)}</span></td>
                <td>${esc(a.gasless || '')}</td>
                <td>${deleg}</td>
                <td>${bal}</td>
                <td>${txs || (a.txsError ? '<span style="color:#e74c3c;">txs: ' + esc(a.txsError) + '</span>' : '—')}</td>
            </tr>`;
        });
        if (!accounts.length) {
            el.innerHTML = '<p class="empty">No accounts yet — play a first roll to seed this list.</p>';
            return;
        }
        const tableWrap = pageHtml => `
            <div class="table-wrap">
                <table class="mini-table">
                    <thead><tr><th>What it is</th><th>Gasless / who pays</th><th>ER delegated</th><th>Balance</th><th>Latest transactions</th></tr></thead>
                    <tbody>${pageHtml}</tbody>
                </table>
            </div>`;
        pagerOrRaw(el, accounts, a => a, {
            wrap: tableWrap,
            empty: '<p class="empty">No accounts yet — play a first roll to seed this list.</p>',
            homePer: 4,
        });
    }

    // ---------- On-chain / Off-chain player stats ----------
    async function delegationRow(player) {
        let state = '—';
        try {
            const res = await fetch('https://devnet-router.magicblock.app/getDelegationStatus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [player.pubkey] }),
            });
            const j = await res.json();
            const r = j.result || {};
            state = r.isDelegated
                ? `<span style="color:#2ecc71;">yes${r.fqdn ? ' · ' + esc(r.fqdn) : ''}</span>`
                : `<span style="color:#e74c3c;">no</span>`;
        } catch (e) { state = '<span style="color:#e74c3c;">error</span>'; }
        return `<tr><td class="mono">${esc(player.pubkey.slice(0, 6))}…${esc(player.pubkey.slice(-4))}</td>` +
               `<td>${state}</td><td>${esc(player.spentSol)} SOL</td></tr>`;
    }

    async function loadOnchain(el) {
        el.innerHTML = '<p class="empty">Loading…</p>';
        const out = [];
        try {
            const res = await fetch('/api/endpoints', { cache: 'no-store' });
            const data = await res.json();
            const ops = data.ops || {};

            if (ops.sponsor && ops.sponsor.pubkey) {
                out.push(`<p>Sponsor wallet: <span class="mono">${esc(ops.sponsor.pubkey)}</span> · <b style="color:#2ecc71;">${esc(ops.sponsor.balanceSol)} SOL</b></p>`);
            }
            const players = (ops.ledger && ops.ledger.players) || [];
            const tableWrap = pageHtml => `
                <table class="mini-table">
                    <thead><tr><th>Player</th><th>Delegated</th><th>Spent</th></tr></thead>
                    <tbody>${pageHtml}</tbody>
                </table>`;
            if (players.length) {
                const checkRows = [];
                for (const p of players.slice(0, 60)) {
                    checkRows.push(await delegationRow(p));
                }
                out.push('<div class="muted-note">Sponsored dice accounts (from the sponsor ledger), with live delegation status from the Magic Router:</div>');
                const bodyEl = document.createElement('div');
                el.innerHTML = out.join('');
                el.appendChild(bodyEl);
                pagerOrRaw(bodyEl, checkRows, r => r, {
                    wrap: tableWrap,
                    empty: '<p class="empty">No sponsored accounts yet — play a first roll as a fresh player to seed this list.</p>',
                    homePer: 10,
                });
            } else {
                out.push('<p class="empty">No sponsored accounts yet — play a first roll as a fresh player to seed this list.</p>');
                el.innerHTML = out.join('');
            }
        } catch (e) {
            out.push('<p class="empty">On-chain data unavailable (' + esc(e.message) + ').</p>');
            el.innerHTML = out.join('');
        }
        el.dataset.loaded = '1';
    }

    async function loadOffchain(el) {
        el.innerHTML = '<p class="empty">Loading…</p>';
        const out = [];
        try {
            if (!window.supabaseClient) throw new Error('Supabase client not loaded');
            const sb = window.supabaseClient;

            const [profilesR, txR] = await Promise.all([
                sb.from('profiles').select('username, email, solana_wallet, global_points, level, created_at').order('created_at', { ascending: false }).limit(100),
                sb.from('point_transactions').select('reason, points').order('created_at', { ascending: false }).limit(500),
            ]);

            if (profilesR.error) throw new Error(profilesR.error.message);
            const profiles = profilesR.data || [];
            const tx = (txR.data || []);

            const totalPoints = profiles.reduce((s, p) => s + (p.global_points || 0), 0);
            const withWallet = profiles.filter(p => p.solana_wallet).length;
            out.push(`<div class="ops-grid">
                <div class="ops-card"><div class="k">Profiles</div><div class="v">${profiles.length}</div></div>
                <div class="ops-card"><div class="k">With wallet</div><div class="v">${withWallet}<span class="k"> · ${profiles.length ? Math.round(100 * withWallet / profiles.length) : 0}%</span></div></div>
                <div class="ops-card"><div class="k">Global points</div><div class="v">${totalPoints.toLocaleString()}</div></div>
                <div class="ops-card"><div class="k">Tx records (sample)</div><div class="v">${tx.length}</div></div>
            </div>`);

            const byReason = {};
            tx.forEach(t => { byReason[t.reason || 'other'] = (byReason[t.reason || 'other'] || 0) + (t.points || 0); });
            const reasons = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, sum]) =>
                `<tr><td>${esc(r)}</td><td>${esc(sum.toLocaleString())} pts</td></tr>`).join('');
            if (reasons) {
                out.push('<div class="muted-note">Points issued by reason (recent ledger sample):</div>');
                out.push(`<table class="mini-table"><thead><tr><th>Reason</th><th>Points</th></tr></thead><tbody>${reasons}</tbody></table>`);
            }

            // Active Tier tracking (S1) — separate fail-open query so a missing
            // migration column never breaks the whole off-chain tab.
            out.push(await tierTrackingHtml(sb));

            if (profiles.length) {
                out.push('<div class="muted-note">Most recent profiles:</div>');
                const profileRow = p => {
                    const w = p.solana_wallet || '';
                    return `<tr><td>${esc(p.username || '—')}</td><td>${esc(p.email || '—')}</td>` +
                        `<td class="mono">${w ? esc(w.slice(0, 6)) + '…' + esc(w.slice(-4)) : '—'}</td>` +
                        `<td>${esc((p.global_points || 0).toLocaleString())}</td><td>${esc(p.level)}</td>` +
                        `<td>${esc((p.created_at || '').slice(0, 16).replace('T', ' '))}</td></tr>`;
                };
                const profileTableWrap = pageHtml => `
                    <div class="table-wrap">
                        <table class="mini-table">
                            <thead><tr><th>Name</th><th>Email</th><th>Wallet</th><th>Pts</th><th>Level</th><th>Created</th></tr></thead>
                            <tbody>${pageHtml}</tbody>
                        </table>
                    </div>`;
                const bodyEl = document.createElement('div');
                el.innerHTML = out.join('');
                el.appendChild(bodyEl);
                pagerOrRaw(bodyEl, profiles, profileRow, {
                    wrap: profileTableWrap,
                    empty: '<p class="empty">No profiles in the store yet.</p>',
                    homePer: 8,
                });
            } else {
                out.push('<p class="empty">No profiles in the store yet.</p>');
                el.innerHTML = out.join('');
            }
        } catch (e) {
            out.push('<p class="empty">Off-chain data unavailable (' + esc(e.message) + ').</p>');
            el.innerHTML = out.join('');
        }
        el.dataset.loaded = '1';
    }

    // Active Tier tracking (S1): how many players hold tiers, spendable
    // drained by purchases, and recent purchases. Fail-open: if the migration
    // columns don't exist yet, render a note instead of erroring the tab.
    async function tierTrackingHtml(sb) {
        try {
            const [profilesR, tierTxR] = await Promise.all([
                sb.from('profiles')
                    .select('id, username, email, solana_wallet, active_tier, active_tier_expires_at, global_points')
                    .order('created_at', { ascending: false })
                    .limit(500),
                sb.from('point_transactions')
                    .select('user_id, points, created_at')
                    .eq('reason', 'active_tier_purchase')
                    .order('created_at', { ascending: false })
                    .limit(200),
            ]);
            if (profilesR.error) throw new Error(profilesR.error.message);
            const profiles = profilesR.data || [];
            const tierTx = tierTxR.data || [];

            const now = Date.now();
            const holders = profiles.filter(p => p.active_tier && Number(p.active_tier) > 1);
            const activeHolders = holders.filter(p => p.active_tier_expires_at && new Date(p.active_tier_expires_at).getTime() > now);
            const lapsedHolders = holders.length - activeHolders.length;

            const byLevel = {};
            activeHolders.forEach(p => { const l = Number(p.active_tier); byLevel[l] = (byLevel[l] || 0) + 1; });
            const dist = [2, 3, 4].map(l => `<span style="color:#f87818;">T${l}: ${byLevel[l] || 0}</span>`).join(' · ');

            const spent = tierTx.reduce((s, t) => s + Math.abs(t.points || 0), 0);
            const purchases30d = tierTx.filter(t => t.created_at && (Date.now() - new Date(t.created_at).getTime()) < 30 * 24 * 60 * 60 * 1000).length;

            const recentRows = tierTx.slice(0, 8).map(t => {
                const p = profiles.find(p => p.id === t.user_id);
                const name = p && (p.username || p.email) ? (p.username || p.email) : (t.user_id || '').slice(0, 8);
                return `<tr><td>${esc(name)}</td><td>-${esc(Math.abs(t.points || 0).toLocaleString())}</td>` +
                    `<td>${esc((t.created_at || '').slice(0, 16).replace('T', ' '))}</td></tr>`;
            }).join('');

            const cells = `
                <div class="ops-card"><div class="k">Tier holders</div><div class="v">${holders.length}</div></div>
                <div class="ops-card"><div class="k">Active now</div><div class="v" style="color:#2ecc71;">${activeHolders.length}</div></div>
                <div class="ops-card"><div class="k">Lapsed</div><div class="v">${lapsedHolders}</div></div>
                <div class="ops-card"><div class="k">Distribution</div><div class="v small">${dist}</div></div>
                <div class="ops-card"><div class="k">Spendable drained</div><div class="v" style="color:#f87818;">${spent.toLocaleString()}</div></div>
                <div class="ops-card"><div class="k">Purchases (30d)</div><div class="v">${purchases30d}</div></div>`;

            const recentBlock = recentRows
                ? `<div class="muted-note" style="margin-top:12px;">Recent tier purchases (spendable sink):</div>
                   <table class="mini-table"><thead><tr><th>Player</th><th>Spent</th><th>When</th></tr></thead><tbody>${recentRows}</tbody></table>`
                : `<p class="empty">No Active Tier purchases yet — the S1 tier buy card on /profile/ seeds this view.</p>`;

            return `<div style="margin-top:16px;border-top:1px solid #7838f8;padding-top:12px;">
                <div class="k" style="color:#7838f8;font-weight:700;margin-bottom:4px;">⚡ Active Tier (S1) — tracked</div>
                <div class="ops-grid">${cells}</div>${recentBlock}
            </div>`;
        } catch (e) {
            return `<div style="margin-top:16px;border-top:1px solid #7838f8;padding-top:12px;">
                <div class="k" style="color:#7838f8;font-weight:700;">⚡ Active Tier (S1)</div>
                <p class="muted-note">Tier tracking unavailable — run <span class="mono">supabase/migrations/0001_active_tier.sql</span> first (${esc(e.message)}).</p>
            </div>`;
        }
    }

    // Bind the On-chain / Off-chain tab bar to the two loaders.
    function bindStatsTabs() {
        document.querySelectorAll('.stats-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                document.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.stats-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('stats-' + tab.dataset.tab).classList.add('active');
                const loader = document.getElementById(tab.dataset.tab === 'onchain' ? 'dash-onchain' : 'dash-offchain');
                if (loader && loader.dataset.loaded !== '1') {
                    if (tab.dataset.tab === 'onchain') loadOnchain(loader); else loadOffchain(loader);
                }
            });
        });
    }

    // ---------- Release pipeline + tracker ----------
    function pendingRow(r) {
        const detail = (r.details && r.details.length)
            ? `<div class="entry-details"><h4>DEV Plan</h4><ol class="dev-plan-list">${r.details.map(d => `<li>${esc(d)}</li>`).join('')}</ol></div>`
            : '';
        return `
            <article class="entry roadmap-entry">
                <div class="entry-head">
                    <span class="entry-version">Next</span>
                    ${statusTag(r.status)}
                    <span class="badge b-status pending">Pending approval</span>
                    <span class="entry-date">added ${esc(r.added || '')}</span>
                </div>
                <h3>${esc(r.title)}</h3>
                <p class="entry-summary">${esc(r.summary) || '<em>(no user summary yet)</em>'}</p>
                ${detail}
            </article>`;
    }

    function trackerRow(r) {
        const approvedTag = r.approved === true
            ? '<span class="badge b-minor">User-approved</span>'
            : '<span class="badge b-status pending">Pending approval</span>';
        const detail = (r.details && r.details.length)
            ? `<div class="entry-details"><h4>DEV Plan</h4><ol class="dev-plan-list">${r.details.map(d => `<li>${esc(d)}</li>`).join('')}</ol></div>`
            : '';
        return `
            <article class="entry roadmap-entry">
                <div class="entry-head">
                    <span class="entry-version">Next</span>
                    ${statusTag(r.status)}
                    ${approvedTag}
                    <span class="entry-date">added ${esc(r.added || '')}</span>
                </div>
                <h3>${esc(r.title)}</h3>
                <p class="entry-summary">${esc(r.summary) || '<em>(no user summary yet)</em>'}</p>
                ${detail}
            </article>`;
    }

    async function loadRoadmap(opts) {
        opts = opts || {};
        const pipelineEl = document.getElementById(opts.pipelineEl || 'dash-pipeline-stats');
        const pendEl = document.getElementById(opts.pendingEl || 'dash-pending-list');
        const allEl = document.getElementById(opts.allEl || 'dash-all-list');
        try {
            const res = await fetch('/changelog/changelog.json', { cache: 'no-store' });
            const data = await res.json();
            const roadmap = data.roadmap || [];
            const entries = data.entries || [];
            const planned = roadmap.filter(r => r.status === 'planned');
            const inProgress = roadmap.filter(r => r.status === 'in-progress');
            const pending = roadmap.filter(r => r.approved !== true);

            if (pipelineEl) {
                pipelineEl.innerHTML =
                    `Current version: <b style="color:#fff;">v${data.current || '—'}</b><br>` +
                    `Planned: <b style="color:#f87818;">${planned.length}</b> · ` +
                    `In progress: <b style="color:#2ecc71;">${inProgress.length}</b> · ` +
                    `Released: <b style="color:#3498db;">${entries.length}</b><br>` +
                    (pending.length ? `<br><span style="color:#7838f8;">⚠ ${pending.length} item(s) pending approval — tell the agent "Approve: &lt;title&gt;" to publish them.</span>` : '<br><span style="color:#27ae60;">All roadmap items are approved for the user page.</span>');
            }

            if (pendEl) {
                const pendRows = pending.map(pendingRow);
                if (pendRows.length) {
                    pagerOrRaw(pendEl, pendRows, r => r, {
                        wrap: pageHtml => `<div class="changelog-entries">${pageHtml}</div>`,
                        empty: `<p class="empty">Nothing pending — every roadmap item is approved.</p>`,
                        homePer: 3,
                    });
                } else {
                    pendEl.innerHTML = `<p class="empty">Nothing pending — every roadmap item is approved.</p>`;
                }
            }

            if (allEl) {
                const roadmapRows = roadmap.map(trackerRow);
                const entriesRows = entries.map(e => `
                    <article class="entry">
                        <div class="entry-head">
                            <span class="entry-version">v${esc(e.version)}</span>
                            <span class="badge b-${e.type || 'patch'}">${esc(e.type || 'Update')}</span>
                            <span class="entry-date">${esc(e.date)}</span>
                        </div>
                        <h3>${esc(e.title)}</h3>
                        <p class="entry-summary">${esc(e.summary) || ''}</p>
                    </article>`);
                const allRows = roadmapRows.concat(entriesRows);
                if (allRows.length) {
                    pagerOrRaw(allEl, allRows, r => r, {
                        wrap: pageHtml => `<div class="changelog-entries">${pageHtml}</div>`,
                        empty: `<p class="empty">Nothing in the tracker yet.</p>`,
                        homePer: 3,
                    });
                } else {
                    allEl.innerHTML = `<p class="empty">Nothing in the tracker yet.</p>`;
                }
            }
        } catch (e) {
            if (pipelineEl) pipelineEl.textContent = 'Could not load roadmap (' + e.message + ').';
            if (pendEl) pendEl.innerHTML = '<p class="empty">Unavailable.</p>';
            if (allEl) allEl.innerHTML = '<p class="empty">Unavailable.</p>';
        }
    }

    // ---------- Tamper / integrity notices ----------
    async function loadNotices(el) {
        el.innerHTML = '<p class="empty">Loading…</p>';
        try {
            const { data: notices, error } = await window.supabaseClient
                .from('point_transactions')
                .select('user_id, reason, match_id, created_at')
                .eq('game_id', 'tamper')
                .order('created_at', { ascending: false })
                .limit(200);

            if (error) throw new Error(error.message);
            if (!notices || !notices.length) {
                el.innerHTML = '<p class="empty">No tamper notices recorded. 🎉</p>';
            } else {
                const rows = notices.map(n => {
                    let detail = { detail: n.reason || '' };
                    try { detail = JSON.parse(n.match_id || '{}'); } catch (e) { /* keep reason */ }
                    return `
                        <article class="entry" style="border:1px solid rgba(231,76,60,0.4);">
                            <div class="entry-head">
                                <span class="badge b-status pending">Tamper</span>
                                <span class="entry-date">${esc(n.created_at)}</span>
                            </div>
                            <h3>${esc(detail.kind || n.reason || 'tamper')}</h3>
                            <p class="entry-summary">${esc(detail.detail || '')}</p>
                            <p style="color:var(--muted); font-size:0.8rem;">user: ${esc(n.user_id || '(signed out)')}${detail.url ? ' · ' + esc(detail.url) : ''}</p>
                        </article>`;
                });
                pagerOrRaw(el, rows, r => r, {
                    wrap: pageHtml => `<div class="changelog-entries">${pageHtml}</div>`,
                    empty: '<p class="empty">No tamper notices recorded. 🎉</p>',
                    homePer: 3,
                });
            }
        } catch (e) {
            el.innerHTML = '<p class="empty">Notices unavailable (' + esc(e.message) + ').</p>';
        }
    }

    // ---------- Collapsible homepage sections ----------
    // Sections marked .dash-section render EXPANDED by default; clicking the
    // header row (or its toggle) collapses the section and shows a one-line
    // summary. Clicking again re-expands. Bound once on the header row so the
    // inline onclick + button listener never double-fire.
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

    window.DashCore = {
        esc,
        statusTag,
        gateStaff,
        loadProbe,
        renderOps,
        renderGas,
        renderEndpoints,
        renderAccounts,
        loadOnchain,
        loadOffchain,
        bindStatsTabs,
        delegationRow,
        loadRoadmap,
        loadNotices,
        bindFolds,
    };

})();
