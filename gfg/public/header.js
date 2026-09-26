// header.js
// Single source of truth for the global header + auth modal + slide-in nav
// Any page that calls initGlobalHeader() gets the full working header, the
// hamburger nav drawer and the login modal.

(function () {

    // ---------- Auth Modal HTML ----------
    function ensureAuthModal() {
        if (document.getElementById('auth-modal')) return; // already exists

        const modalHTML = `
            <div id="auth-modal" class="auth-modal">
                <div class="auth-modal-content">
                    <button id="auth-modal-close" class="auth-modal-close">×</button>
                    <h2>Account</h2>
                    <p class="auth-hint">Simple email + password. No wallet needed.</p>

                    <input type="email" id="auth-email" placeholder="Email address" autocomplete="email">
                    <input type="password" id="auth-password" placeholder="Password (min 6 chars)" autocomplete="current-password">

                    <div class="auth-actions">
                        <button id="btn-signin" class="auth-btn primary">Sign In</button>
                        <button id="btn-signup" class="auth-btn secondary">Create Account</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // Re-attach the event listeners (auth.js already defined the functions)
        document.getElementById('auth-modal-close')?.addEventListener('click', () => {
            document.getElementById('auth-modal')?.classList.remove('visible');
        });

        document.getElementById('btn-signin')?.addEventListener('click', () => {
            if (window.handleSignIn) window.handleSignIn();
        });

        document.getElementById('btn-signup')?.addEventListener('click', () => {
            if (window.handleSignUp) window.handleSignUp();
        });

        // Close when clicking the dark background
        document.getElementById('auth-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'auth-modal') {
                document.getElementById('auth-modal')?.classList.remove('visible');
            }
        });
    }

    // ---------- Menu items ----------
    // Essential links every visitor needs; admin-only items are shown when the
    // connected wallet is staff.
    // The Games menu item points at /games/; the central games registry is no
    // longer needed for nav labels (the single "Games" entry is static).
    function NAV_SECTIONS() {
        return [
            {
                heading: 'Play',
                items: [
                    { label: '🎮 Games', href: '/games/', match: 'games' },
                    { label: '🌍 Countries', href: '/countries/', match: 'countries' },
                    { label: '🏆 Competitions', href: '/competitions/', match: 'competitions' },
                    { label: 'Home', href: '/', match: 'home' }
                ]
            },
            {
                heading: 'Discover',
                items: [
                    { label: 'Premium Plans', href: '/profile/subscription.html', match: 'pricing' },
                    { label: 'What’s New', href: '/changelog/', match: 'changelog' },
                    { label: 'About', href: '/about/', match: 'about' },
                    { label: 'Forum', href: '/forum/', match: 'forum' },
                    { label: 'Support', href: '/support/', match: 'support' },
                    { label: 'Contact', href: '/contact/', match: 'contact' },
                    { label: '🎮 Foskaay GGI Demos', href: '/foskaay-ggi/demos/', match: 'ggi' }
                ]
            },
            {
                heading: 'Account',
                items: [
                    { label: 'My Profile', href: '/profile/', match: 'profile' }
                ]
            },
            {
                heading: 'Legal',
                items: [
                    { label: 'Privacy Policy', href: '/privacy.html', match: 'privacy' }
                ]
            }
        ];
    }

    // Admin-only links shown only to staff. The main drawer keeps ONLY the
    // Dashboard itself; every other admin page is reached from the dashboard's
    // own menu (dash-nav), so the visitor drawer stays clean.
    const ADMIN_NAV = [
        { label: '🛡 Dashboard', href: '/dashboard/', match: 'dashboard' }
    ];

    // Resolve the connected wallet the same way the changelog page does.
    function currentWallet() {
        try {
            // Arc rail: the EVM address is the identity.
            if (window.gfgChain && typeof window.gfgChain.isArc === 'function' && window.gfgChain.isArc()) {
                var a = window.gfgChainAdapter;
                var ew = (a && a.walletAddress && a.walletAddress()) || null;
                if (ew) return ew;
                if (window.getDynamicEvmWallet) { var x = window.getDynamicEvmWallet(); if (x) return x; }
            }
            if (window.getDynamicSolanaWallet) {
                const w = window.getDynamicSolanaWallet();
                if (w) return w;
            }
            if (window.currentProfile && window.currentProfile.solana_wallet) {
                return window.currentProfile.solana_wallet;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Return 'admin' | 'moderator' | 'user' for the connected wallet.
    async function resolveMyRole() {
        try {
            const res = await fetch('/changelog/roles.json', { cache: 'no-store' });
            if (!res.ok) return 'user';
            const roles = await res.json();
            const wallet = currentWallet();
            if (!wallet || !roles) return 'user';
            const w = wallet.toLowerCase();
            const norm = list => Array.isArray(list) ? list.map(a => String(a).toLowerCase()) : [];
            if (norm(roles.admin).includes(w)) return 'admin';
            if (norm(roles.moderator).includes(w)) return 'moderator';
        } catch (e) { /* ignore */ }
        return 'user';
    }

    // Build the slide-in navigation drawer. Glassmorphic so the page content
    // stays visible behind it; it slides OVER the page (never pushes it).
    function ensureDrawer() {
        if (document.getElementById('gfg-drawer')) return;

        const html = `
            <div id="gfg-drawer-scrim" class="gfg-drawer-scrim"></div>
            <aside id="gfg-drawer" class="gfg-drawer" aria-hidden="true">
                <div class="gfg-drawer-head">
                    <span class="gfg-brand"><img class="gfg-logo" src="/media/logo.png" alt="GlobalFolkGames.fun logo"> <span class="brand-orange">Global</span><span class="brand-purple">Folk</span><span class="brand-orange">Games</span><span class="brand-purple">.</span><span class="brand-orange">fun</span> <span class="gfg-beta">Beta</span></span>
                    <button id="gfg-drawer-close" class="gfg-drawer-close" aria-label="Close menu">×</button>
                </div>
                <nav class="gfg-drawer-nav" id="gfg-drawer-nav">
                    ${NAV_SECTIONS().map(sec => `
                        <div class="gfg-drawer-section">
                            <div class="gfg-drawer-heading">${sec.heading}</div>
                            <ul>
                                ${sec.items.map(it => `
                                    <li><a href="${it.href}" data-nav-item="${it.match}">${it.label}</a></li>
                                `).join('')}
                            </ul>
                        </div>
                    `).join('')}
                    <!-- Admin links are NOT in the DOM for visitors; added only
                         after the wallet is verified staff (see ensureAdminSection). -->
                </nav>
            </aside>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        const drawer = document.getElementById('gfg-drawer');
        const scrim = document.getElementById('gfg-drawer-scrim');
        const closeBtn = document.getElementById('gfg-drawer-close');

        function openDrawer() {
            drawer?.classList.add('open');
            scrim?.classList.add('show');
            if (drawer) drawer.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        }
        function closeDrawer() {
            drawer?.classList.remove('open');
            scrim?.classList.remove('show');
            if (drawer) drawer.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
        }

        closeBtn?.addEventListener('click', closeDrawer);
        scrim?.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDrawer();
        });
        // Clicking any link closes the drawer; the default navigation proceeds.
        drawer?.querySelectorAll('a[data-nav-item]').forEach(a => {
            a.addEventListener('click', closeDrawer);
        });

        window.openGlobalDrawer = openDrawer;
        window.closeGlobalDrawer = closeDrawer;

        // Admin-only links appear ONLY after the connected wallet is verified
        // staff. For everyone else the Admin section never exists in the DOM,
        // so a non-admin inspecting the page cannot even see the target URLs.
        resolveMyRole().then(role => {
            if (role !== 'user') ensureAdminSection();
        });
    }

    // Insert the Admin nav section for staff wallets only. Built lazily so
    // visitors and signed-in non-admins never receive the admin URLs in the
    // client payload at all.
    function ensureAdminSection() {
        if (document.getElementById('gfg-drawer-admin')) return;
        const nav = document.getElementById('gfg-drawer-nav');
        if (!nav) return;
        const sec = document.createElement('div');
        sec.className = 'gfg-drawer-section gfg-drawer-admin';
        sec.id = 'gfg-drawer-admin';
        sec.innerHTML = `
            <div class="gfg-drawer-heading">Admin</div>
            <ul>
                ${ADMIN_NAV.map(it => `
                    <li><a href="${it.href}" data-nav-item="${it.match}">${it.label}</a></li>
                `).join('')}
            </ul>
        `;
        nav.appendChild(sec);
        sec.querySelectorAll('a[data-nav-item]').forEach(a => {
            a.addEventListener('click', () => {
                if (typeof window.closeGlobalDrawer === 'function') window.closeGlobalDrawer();
            });
        });
    }

    // ---------- Global Header ----------
    function renderHeader(options = {}) {
        const gameName = options.gameName || '';

        // Remove old header if it exists
        const old = document.querySelector('.gfg-header');
        if (old) old.remove();

        const headerHTML = `
            <header class="gfg-header">
                <div class="gfg-header-left">
                    <a href="/" class="gfg-brand"><img class="gfg-logo" src="/media/logo.png" alt="GlobalFolkGames.fun logo"> <span class="brand-orange">Global</span><span class="brand-purple">Folk</span><span class="brand-orange">Games</span><span class="brand-purple">.</span><span class="brand-orange">fun</span> <span class="gfg-beta">Beta</span></a>
                    <span id="active-tier-badge" class="gfg-tier-badge" style="display:none; padding:1px 8px; border-radius:999px; font-size:0.68rem; font-weight:800; white-space:nowrap;"></span>
                    ${gameName ? `<span class="gfg-game-tag">${gameName}</span>` : ''}
                </div>
                <div class="gfg-header-right">
                    <div class="gfg-user-pill" id="gfg-user-pill">
                        <span id="display-points">⭐ 0 Pts</span>
                    </div>
                    <button id="gfg-menu-btn" class="gfg-menu-btn" aria-label="Open menu" aria-haspopup="true">☰</button>
                </div>
            </header>
            <a href="/backers/" class="gfg-backer-banner" aria-label="Become an Early Backer">
                <span class="b-emoji">🧡</span>
                <span class="b-text"><b>You can become an Early Backer.</b>&nbsp; 100 seats, lifetime L3, and you help this reach Mainnet.</span>
                <span class="b-cta">See how →</span>
            </a>
            <a href="/backers/" class="gfg-backer-banner-bottom" aria-label="Become an Early Backer">
                <span class="b-emoji">🧡</span>
                <span class="b-text"><b>You can become an Early Backer.</b>&nbsp; 100 seats, lifetime L3, and you help this reach Mainnet.</span>
                <span class="b-cta">See how →</span>
            </a>
        `;

        document.body.insertAdjacentHTML('afterbegin', headerHTML);

        // EARLY BACKER BOTTOM BANNER CYCLE (owner 2026-08-31):
        // show for 8s -> hide for 30s -> reappear, forever. Not user-cancellable
        // on purpose (it vanishes on its own), so it never goes stale but also
        // never overstays. Reduces banner-blindness by reappearing on a rhythm.
        (function () {
            var pop = document.querySelector('.gfg-backer-banner-bottom');
            if (!pop) return;
            var showMs = 8000;   // stays visible long enough to read + tap
            var hideMs = 30000;  // gone long enough to not feel intrusive
            var shown = false;
            function show(){ if (shown) return; shown = true; pop.classList.add('show'); setTimeout(hide, showMs); }
            function hide(){ pop.classList.remove('show'); shown = false; setTimeout(show, hideMs); }
            setTimeout(show, 4000); // first appearance shortly after load
        })();

        if (!document.getElementById('gfg-community') && !gameName) {
            const toast = document.createElement('div');
            toast.id = 'gfg-community';
            toast.className = 'gfg-community';
            toast.setAttribute('aria-live', 'polite');
            document.body.appendChild(toast);
            let shown = false;
            const closeBtn = document.createElement('button');
            closeBtn.className = 'gfg-community-close';
            closeBtn.setAttribute('aria-label', 'Dismiss');
            closeBtn.textContent = '×';
            closeBtn.onclick = function () { toast.classList.remove('show'); shown = false; };
            const tryShow = function (text) {
                if (shown) return;
                toast.innerHTML = '';
                toast.appendChild(closeBtn);
                const span = document.createElement('span');
                span.textContent = text;
                toast.appendChild(span);
                toast.classList.add('show');
                shown = true;
                setTimeout(function () { toast.classList.remove('show'); shown = false; }, 8000);
            };
            const maybeShow = function () {
                try {
                    fetch('/api/community-stats', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
                        if (!j || !j.latest || !j.count) return;
                        if (j.joinedMinutesAgo != null && j.joinedMinutesAgo <= 30) {
                            tryShow('🎮 Gamer ' + j.latest + ' just joined GlobalFolkGames');
                        }
                    }).catch(function () {});
                } catch (e) {}
            };
            setTimeout(maybeShow, 6000);
            // Refresh the counter on the page if it uses it.
            window.gfgCommunityCount = function () {
                try { return fetch('/api/community-stats', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { return (j && j.count) || 0; }); } catch (e) { return Promise.resolve(0); }
            };
        }
        // Measure the global header's REAL rendered height and expose it as
        // --gfg-header-h. The header may sit on one row (desktop) or two
        // (mobile when brand + right side don't fit), and its height varies
        // with the pill's content and font loading, so a fixed 50px guess
        // would leave the pill overlapping page headers below. Local headers
        // that stick under it (e.g. Ludo) read this variable. Re-measure on
        // resize and after fonts load so the value tracks any changes.
        function syncHeaderHeight() {
            const h = document.querySelector('.gfg-header');
            if (h) {
                document.documentElement.style.setProperty('--gfg-header-h', h.offsetHeight + 'px');
            }
        }
        syncHeaderHeight();
        window.addEventListener('resize', syncHeaderHeight);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => setTimeout(syncHeaderHeight, 120));
        }

        // Wire the hamburger menu to the slide-in drawer.
        const menuBtn = document.getElementById('gfg-menu-btn');
        menuBtn?.addEventListener('click', () => {
            ensureDrawer();
            if (window.openGlobalDrawer) window.openGlobalDrawer();
        });

        // Make sure the auth modal also exists on this page
        ensureAuthModal();
        ensureConfirmDialog();

        // Tell profiles.js the header is ready
        if (typeof window.refreshAuthHeader === 'function') {
            window.refreshAuthHeader();
        }
    }

    // ---------- Generic confirm dialog (platform-styled, thumb-safe) ----------
    // Used across the platform for destructive actions (sign out, etc.).
    // Button order: OK on the LEFT, Cancel on the RIGHT. On mobile the right
    // side is where a thumb naturally lands when reaching for the menu, so a
    // stray tap hits Cancel and nothing happens; signing out (OK) is a
    // deliberate, careful tap.
    function ensureConfirmDialog() {
        if (document.getElementById('gfg-confirm-dialog')) return;

        const html = `
            <div id="gfg-confirm-dialog" class="auth-modal">
                <div class="auth-modal-content">
                    <h2 id="gfg-confirm-title">${String.fromCharCode(63)}</h2>
                    <p id="gfg-confirm-message" class="auth-hint" style="margin-bottom:16px;"></p>
                    <div class="auth-actions gfg-confirm-actions">
                        <button id="gfg-confirm-ok" class="auth-btn primary">Okay</button>
                        <button id="gfg-confirm-cancel" class="auth-btn secondary">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        const dialog = document.getElementById('gfg-confirm-dialog');
        let onOk = null;

        function close() {
            dialog?.classList.remove('visible');
            onOk = null;
        }

        document.getElementById('gfg-confirm-ok')?.addEventListener('click', () => {
            const cb = onOk;
            close();
            if (cb) cb();
        });
        document.getElementById('gfg-confirm-cancel')?.addEventListener('click', close);
        // Clicking the dark background also cancels (safe default).
        dialog?.addEventListener('click', (e) => {
            if (e.target.id === 'gfg-confirm-dialog') close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('gfg-confirm-dialog')?.classList.contains('visible')) close();
        });

        // Public: window.showConfirmDialog({ title, message, okText, cancelText, onOk })
        window.showConfirmDialog = function (opts = {}) {
            const dlg = document.getElementById('gfg-confirm-dialog');
            if (!dlg) return;
            document.getElementById('gfg-confirm-title').textContent = opts.title || 'Are you sure?';
            document.getElementById('gfg-confirm-message').textContent = opts.message || '';
            document.getElementById('gfg-confirm-ok').textContent = opts.okText || 'Okay';
            document.getElementById('gfg-confirm-cancel').textContent = opts.cancelText || 'Cancel';
            onOk = opts.onOk || null;
            dlg.classList.add('visible');
        };
    }

    // Public function used by every page
    // Inject a plain script (the universal point modules are IIFE globals, so a
    // classic loader is enough; they self-boot on DOM ready + wallet ready).
    function ensureScript(src) {
        const existing = document.querySelector('script[src="' + src + '"]');
        if (existing) return;
        const el = document.createElement('script');
        el.src = src;
        el.async = false;
        document.body.appendChild(el);
    }

    // Inject a stylesheet once (deduped by href). put in <head> so it sits in
    // the cascade before any page-inline styles that want to win.
    function ensureStyle(href) {
        if (document.querySelector('link[href="' + href + '"]')) return;
        const el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = href;
        document.head.appendChild(el);
    }

    function ensureBackToTop() {
        if (document.getElementById('gfg-backtop')) return;
        const b = document.createElement('button');
        b.id = 'gfg-backtop';
        b.setAttribute('aria-label', 'Back to top');
        b.innerHTML = '\u2191';
        b.style.cssText = 'position:fixed; right:14px; bottom:14px; z-index:9500; width:42px; height:42px; border-radius:12px; border:1px solid rgba(255,255,255,0.18); background:rgba(243,156,18,0.9); color:#000; font-size:1.1rem; font-weight:900; cursor:pointer; opacity:0; transform:translateY(6px); transition:opacity .25s, transform .25s; pointer-events:none;';
        b.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); };
        document.body.appendChild(b);
        let shown = false, hideTimer = null;
        function show(){ if (shown) return; shown = true; b.style.opacity = '1'; b.style.transform = 'translateY(0)'; b.style.pointerEvents = 'auto'; }
        function hide(){ shown = false; b.style.opacity = '0'; b.style.transform = 'translateY(6px)'; b.style.pointerEvents = 'none'; }
        function onScroll(){
            if (window.scrollY > 320) { show(); if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(hide, 3200); }
            else hide();
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }
    function ensureFavicon() {
        if (document.querySelector('link[rel="icon"]')) return;
        const l = document.createElement('link');
        l.rel = 'icon';
        l.type = 'image/png';
        l.href = '/media/logo.png';
        document.head.appendChild(l);
    }
    // Google AdSense loader, injected into <head> exactly once per page. The
    // script is ALSO injected statically at build time (vite.config.js
    // transformIndexHtml) so Adsense's checker sees it in the served HTML; this
    // runtime fallback only covers any page that somehow lacks the static tag,
    // deduped against BOTH the static tag and a prior injection.
    function ensureAdsenseScript() {
        if (document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]')) return;
        if (document.querySelector('script[data-adsense="1"]')) return;
        const sc = document.createElement('script');
        sc.setAttribute('data-adsense', '1');
        sc.async = true;
        sc.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7686312364288737';
        sc.setAttribute('crossorigin', 'anonymous');
        (document.head || document.documentElement).appendChild(sc);
    }

    // Sitewide tier badge: shows the signed-in user's plan in front of the points
    // pill (Level 0 free gray, Level 2 · 2x gold). PURE cache read — no RPC on load:
    // it reads window.activeTier.get() which is fed by the two RPC triggers
    // (auth change + win) via the central points store, same as M3/M4.
    // The free tier is L0 (the plan ladder starts at L0 free), never L1: an
    // inactive sub means level 0, so the badge must read L0, not L1.
    function updateActiveTierBadge() {
        const el = document.getElementById('active-tier-badge');
        if (!el) return;
        const signedIn = !!(window.currentUser || (window.getDynamicSolanaWallet && window.getDynamicSolanaWallet()) || (window.getDynamicEvmWallet && window.getDynamicEvmWallet()));
        if (!signedIn) { el.style.display = 'none'; return; }
        const tier = (window.activeTier && typeof window.activeTier.get === 'function') ? window.activeTier.get() : null;
        const active = !!tier && tier.active === true && (tier.level || 0) >= 1;
        if (active) {
            el.textContent = 'L' + tier.level + ' · Premium';
            el.style.background = 'rgba(243,156,18,0.18)';
            el.style.border = '1px solid rgba(243,156,18,0.6)';
            el.style.color = '#f87818';
            el.style.display = 'inline-block';
        } else {
            el.textContent = 'L0';
            el.style.background = 'rgba(255,255,255,0.07)';
            el.style.border = '1px solid rgba(255,255,255,0.2)';
            el.style.color = '#999';
            el.style.display = 'inline-block';
        }
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', () => updateActiveTierBadge());
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.indexOf('premium') >= 0) updateActiveTierBadge();
        });
        // Self-healing badge: the header can be re-rendered (auth flows, pages that
        // call initGlobalHeader again), which recreates the badge with its default
        // display:none and hides it. Re-apply every 2s from the PURE cache (no RPC)
        // so it always stays visible and current.
        setInterval(updateActiveTierBadge, 2000);
    }

    window.initGlobalHeader = function (options) {
        // Sitewide colorful gamey theme: injected once on every page so the
        // bright Subway-Surfers backdrop is controlled from ONE css file
        // (public/theme.css). Pages that ship their own dark body background in
        // an inline <style> keep it; theme.css loads right after the shared
        // style.css link so it wins over that link but not over inline styles.
        ensureStyle('/theme.css');
        ensureFavicon();
        ensureBackToTop();

        // Monetag ads gate: paused while Adsense approval is pending (see
        // ad-gate.js ADS_ENABLED flag - flip it back to restore). Once active,
        // every level shows ads (L0 full, L1-L3 less); no level is ad-free.
        ensureScript('/ad-gate.js');

        // Google AdSense loader (sitewide <head>). The publisher script itself
        // serves no ads until an approved ad unit exists; it is the standard
        // Adsense verification + loader that belongs on every page.
        ensureAdsenseScript();

        // Universal footer: same idea as the header, but for the footer - a
        // single file (public/footer.js) rendered on every page automatically
        // (© 2026 - Till Date · GlobalFolkGames + core links). The future
        // refactor will merge header + footer boot into one central script.
        if (!window.gfgFooter) ensureScript('/footer.js');

        // Ensure the universal point modules are present on EVERY page. The
        // header pill reads M3/M4 ledgers via window.localPoints / window.
        // globalLedger, so pages that don't explicitly load them would otherwise
        // sit on a permanent loading state / zero. Loading the module scripts
        // here when absent makes the pill always reflect the real balances.
        // The plan ladder is a data config every subscription consumer reads;
        // load it FIRST so lives/daily/premium never fall back to hardcoded numbers.
        if (!window.gfgPlanLadder) ensureScript('/universal/subscription/plan-ladder.js');
        // GFG-BS settlement rail + match history (universal, game-agnostic).
        if (!window.gfgMatchEngine) ensureScript('/universal/settlement/match-engine.js');
        if (!window.gfgSettlement) ensureScript('/universal/settlement/match-settlement.js');
        if (!window.gfgMatchHistory) ensureScript('/universal/settlement/match-history.js');
        ['/chain-gateway.js', '/universal/identity/handle.js', '/universal/point-sources/referral.js', '/universal/points/local-points.js', '/universal/ledgers/global-ledger.js', '/universal/subscription/premium-ledger.js', '/universal/lives/lives.js', '/universal/lives/daily-reward.js'].forEach(function (src) {
            if (!window.deriveProfileHandle && src.indexOf('handle.js') >= 0) ensureScript(src);
            if (!window.gfgReferral && src.indexOf('referral.js') >= 0) ensureScript(src);
            if (!window.localPoints && src.indexOf('local-points') >= 0) ensureScript(src);
            if (!window.globalLedger && src.indexOf('global-ledger') >= 0) ensureScript(src);
            if (!window.premiumPoints && src.indexOf('premium-ledger') >= 0) ensureScript(src);
            if (!window.gfgLives && src.indexOf('lives/lives.js') >= 0) ensureScript(src);
            if (!window.gfgDaily && src.indexOf('daily-reward') >= 0) ensureScript(src);
        });
        // The central points store (single source of truth for "when does the
        // RPC get consulted"): it binds solely to gfg:auth-changed and resets +
        // refetches the M3/M4 ledgers on a fresh sign-in. On a plain page load
        // it does nothing, so the header never causes page-load RPC. Ensure it
        // everywhere too (idempotent).
        if (!window.pointsStore) ensureScript('/universal/points/points-store.js');
        if (!window.gfgCompetitions) ensureScript('/universal/competitions/competition-engine.js');
        renderHeader(options || {});
        // Tier badge: read the cache only; update when the premium module refreshes.
        setTimeout(updateActiveTierBadge, 0);
        try {
            if (window.premiumPoints && typeof window.premiumPoints.subscribe === 'function') {
                window.premiumPoints.subscribe(() => updateActiveTierBadge());
            }
        } catch(e) {}
    };

})();