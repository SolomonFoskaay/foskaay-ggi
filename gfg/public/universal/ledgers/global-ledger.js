// public/universal/ledgers/global-ledger.js
// M4 — GLOBAL LEDGERS MODULE (universal, game-agnostic).
//
// Consumes the universal result seam (M2): subscribes to window.onGameResult
// ONCE and credits the player's GLOBAL POINTS PDA for verified user-seat wins.
// A game never ships reward code — ANY M1 game plugs in here by emitting the
// same envelope; this module owns the global scoring logic and the 3-ledger
// on-chain API.
//
// On-chain: GlobalPoints PDA (seed [gfgpoints, 'global', player]) holding
// THREE tracks gasless on the MagicBlock ER:
//   - global_pure_lifetime      (M4a: sum of verified game wins across all games,
//                                no multiplier, no bonus — honest skill total)
//   - global_lifetime           (M4b: every point earned from any source, unspendable
//                                permanent reputation number)
//   - global_spendable_balance  (M4c: spendable track, goes up and down)
//
// Flow-up contract (multiplier-blind):
//   - kind 0 (GAME WIN): credits M4a pure + M4b lifetime + M4c spendable.
//   - kind 1 (OTHER — signup/referral/giveaway/tier_boost): credits M4b + M4c
//     only. M4a pure is never multiplied or bonus-inflated.
//   The Active Tier multiplier (M5) applies as a SEPARATE kind-1 credit, so
//   M4a pure can NEVER be multiplied by construction.
//
// Architecture contract (M3 → M4):
//   M4 does NOT compute awards or duplicate scoring tables. When the M2 seam
//   fires, M4 reads M3's computed award (window.localPoints.lastAward) which
//   already has: gameTag, points, position, reason, matchRef. M4 uses gameTag
//   as the on-chain source identity (M3 is the scorer, M4 is the bank).
//
// Exposes window.globalLedger = { get(), credit({...}), spend(amount, reason,
// ref), subscribe(cb), lastCredit, lastSeenCredit, lastError, clearTransient() }
// and fills any DOM slot marked data-global-pure / data-global-lifetime /
// data-global-spendable on any page.
(function () {

    // M4 source-code enum (mirrors the program's u8 source_code).
    // Game wins: the gameId from the M2 envelope IS the source identity.
    // Non-game sources: defined by M5/M6.
    var SOURCE_CODES = {
        ludo: 1,
        ayo_olopon: 2,
        signup_bonus: 10,
        referral: 11,
        giveaway: 12,
        tier_boost: 13,
        daily_reward: 14,
    };

    function sourceCodeFor(gameId) {
        if (SOURCE_CODES[gameId] != null) return SOURCE_CODES[gameId];
        return 0; // unknown source
    }

    // Client-side dedup (in-memory + localStorage) so a reload or duplicate
    // seam event never double-credits. The program also guards via
    // last_match_ref on-chain; this is the cheap client layer.
    var PROCESSED_KEY = 'gfg_global_ledger_processed_v1';
    var processed = {};
    try {
        processed = JSON.parse(window.localStorage.getItem(PROCESSED_KEY) || '{}') || {};
    } catch (e) { processed = {}; }

    function persistProcessed() {
        try { window.localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed)); } catch (e) { /* ignore */ }
    }

    var CACHE_KEY = 'gfg_global_ledger_cache_v2';
    var cacheStore = {};       // wallet -> ledger snapshot (latest known)
    var cached = null;         // current wallet's ledger snapshot
    var subscribers = [];     // callbacks invoked after a credit / spend / refresh
    var lastCredit = null;    // last successfully credited (shown by ceremonies)
    var lastSeenCredit = null; // credit computed for the most recent finish
    var lastError = null;     // last credit failure reason

    // SINGLE-SOURCE-OF-TRUTH RPC ECONOMY (owner design, 2026-08-18): the
    // localStorage cache is the ONLY display source. Pages read it with
    // get() (pure read, never fetches). The RPC is hit ONLY when:
    //   1. the ledger is FIRST checked for this wallet after a login page boot
    //      (so a silently restored session / new device never shows a wrong
    //      zero), and
    //   2. right after a credit/spend write (so the board posts the new number).
    // A player who doesn't win all day costs ~1-3 RPC hits for the whole
    // browser, not one per page view. A zero-result (no account yet) is
    // legitimately "checked" too, and is re-verified at the next wallet-ready
    // boot (reads now go BY WALLET ADDRESS, so a transient outage can never
    // freeze a fresh zero forever and a migration-era balance surfaces).
    // Populated ledgers stay cached until the next win/spend. The check-time
    // marker lives in a SEPARATE localStorage key so the v2 ledger-slice shape
    // (wallet -> ledger) stays untouched.
    var META_KEY = 'gfg_global_ledger_meta_v2';
    var metaStore = {};        // wallet -> { at, any }
    var refreshInFlight = null; // in-flight refresh promise (dedup)

    function loadMeta() {
        try {
            metaStore = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {};
        } catch (e) { metaStore = {}; }
    }
    function markChecked(any) {
        metaStore[walletKey()] = { at: Date.now(), any: !!any };
        try { localStorage.setItem(META_KEY, JSON.stringify(metaStore)); } catch (e) { /* ignore */ }
    }
    // True once this wallet has been verified at all (even with nothing
    // on-chain), so displays can show a real "no ledger yet" instead of
    // loading forever.
    function hasChecked() {
        return !!metaStore[walletKey()];
    }
    // True when there is a live player wallet behind the current cache slice
    // (dynamic wallet or profile wallet), false for a logged-out 'anon' state.
    function hasRealWallet() {
        return readAddress() !== null;
    }

    // READ STABILITY (owner-approved 2026-08-19, mirrors the recovery page):
    // on-chain reads must NOT wait for the Dynamic SIGNING session to confirm
    // identity. A ledger is PUBLIC data (the PDA derives from the wallet
    // ADDRESS), so the module reads BY WALLET ADDRESS over the ER as soon as it
    // knows the address, and only ever at the two agreed moments (first check
    // after login + after a credit/spend). The address comes ONLY from the LIVE
    // session (Dynamic wallet, else the loaded profile) — NEVER from a
    // persisted "last wallet" hint. On a shared device a stale hint would leak
    // the previous user's numbers to the next visitor after a silent session
    // expiry; the wallet-ready poll (30s + focus/pageshow re-arm) still covers
    // slow restores, so no hint is needed.
    // Exact (case-sensitive) wallet address for PDA derivation + on-chain
    // reads. Kept separate from walletKey() (lowercased cache-isolation key).
    function readAddress() {
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

    // Best-known caller identity for cache isolation: the Dynamic Solana wallet
    // address when available, else the profile wallet, else 'anon'.
    function walletKey() {
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

    // Point `cached` at the current wallet's slice so a silently restored
    // session (or a shared browser) never shows another user's numbers.
    function syncCacheToWallet() {
        var wk = walletKey();
        var entry = cacheStore[wk];
        cached = (entry && typeof entry === 'object' && entry.spendableBalance != null) ? entry : null;
    }

    loadCache();
    syncCacheToWallet();
    loadMeta();

    function persistCache(ledger) {
        try {
            cacheStore[walletKey()] = ledger;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheStore));
        } catch (e) { /* ignore */ }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function matchRefFor(proofSig) {
        if (!proofSig) return '0';
        // ARC (arcv2m17 audit): on Arc the proof token is a hex seed hash, so the
        // Solana base58 math gives a wrong ref. Prefer the gateway's stable ref
        // on both rails.
        try {
            if (window.gfgChain && typeof window.gfgChain.matchRefFromSignature === 'function') {
                return String(window.gfgChain.matchRefFromSignature(proofSig));
            }
        } catch (e) { /* fall through */ }
        try {
            if (window.magicblockDice && typeof window.magicblockDice.matchRefFromSignature === 'function') {
                return String(window.magicblockDice.matchRefFromSignature(proofSig));
            }
        } catch (e) { /* fall through to base58 math */ }
        try {
            var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
            var bytes = [];
            for (var i = 0; i < proofSig.length; i++) {
                var c = ALPHABET.indexOf(proofSig[i]);
                if (c < 0) return '0';
                for (var j = 0; j < bytes.length; j++) bytes[j] = bytes[j] * 58 + c;
                bytes.unshift(c);
            }
            while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
            var out = 0n;
            var order = 1n;
            for (var k = 0; k < bytes.length && k < 8; k++) {
                out += BigInt(bytes[k]) * order;
                order *= 256n;
            }
            return out.toString();
        } catch (e) { return '0'; }
    }

    function magicReady() {
        return !!(window.gfgChain && typeof window.gfgChain.recordGlobal === 'function');
    }

    async function refreshLedger(force) {
        if (refreshInFlight) return refreshInFlight; // share the in-flight fetch
        var firstCheck = !hasChecked(); // notify once when a zero check lands
        refreshInFlight = (async function () {
            var ledger = null;
            // ARC (arcv2m17 audit): read through the chain gateway, NEVER the
            // Solana SDK. The old code called sdk.fetchGlobalPointsPdaFor
            // unconditionally, so every page on an Arc build hit Solana.
            var onArc = false;
            try { onArc = !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { onArc = false; }
            if (onArc) {
                try {
                    var arcLedger = (window.gfgChain.fetchGlobalLedger) ? await window.gfgChain.fetchGlobalLedger() : null;
                    if (arcLedger) {
                        cached = arcLedger;
                        if (hasRealWallet()) markChecked(true);
                        persistCache(arcLedger);
                        fillSlots(arcLedger);
                        notify(arcLedger);
                        return arcLedger;
                    }
                } catch (e) { /* soft */ }
                if (hasRealWallet()) markChecked(false);
                if (firstCheck) notify(null);
                return cached || null;
            }
            try {
                // READ BY WALLET ADDRESS first (no signing session required —
                // mirrors the recovery page). Falls back to the sign-in-scoped
                // fetch for SDK builds without the address-based reader.
                var addr = readAddress();
                var sdk = window.magicblockDice;
                console.log('[global-ledger] refresh start: readAddress() =', addr, '| magicblockDice =', !!(sdk && sdk.isConfigured && sdk.isConfigured()));
                if (addr && sdk && typeof sdk.fetchGlobalPointsPdaFor === 'function') {
                    ledger = await sdk.fetchGlobalPointsPdaFor(addr);
                }
                if (!ledger && sdk && typeof sdk.fetchGlobalPointsPda === 'function') {
                    ledger = await sdk.fetchGlobalPointsPda();
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
            // Not readable this instant (wallet not restored, ER down, or the
            // account doesn't exist yet). Keep rendering the last-known value
            // so pages never sit on static 0 / 'Loading…'. A wallet present +
            // reachable fetch counts as "checked" even for a zero result so we
            // don't refetch it on every load; network-y errors leave the marker
            // unset so the next page retries.
            if (hasRealWallet()) markChecked(false);
            if (firstCheck) notify(null, null); // pages flip their "loading" line to "no ledger yet"
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

    // Bank a verified finish into the GLOBAL ledger. Soft-fail: never throws
    // to the game. Uses kind=0 (GAME WIN) to credit all 3 ledgers.
    //
    // Architecture contract: M4 reads M3's lastAward (set synchronously when
    // M3's handler fires before ours). M3 already computed {gameTag, points,
    // position, reason, matchRef} from its own scoring table. M4 is the bank,
    // not the scorer — it uses gameTag as source identity and points as-is.
    // M3's award for THIS envelope. M4 is the bank, not the scorer — the award
    // comes from M3 (which banks the SAME match from the SAME seam envelope).
    // Accept an award ONLY when it belongs to this match: exact match_ref match
    // on lastAward (M3 sets matchRef once the write lands), or the very recent
    // lastSeenAward (M3 sets it synchronously when its bank starts and its
    // award carries no matchRef). A stale award is never credited.
    function pickM3Award(matchRef) {
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

    async function bank(env) {
        var proofSig = env.proof && env.proof.signature;
        if (!proofSig) {
            lastError = 'finish has no on-chain proof signature';
            console.warn('[global-ledger] finish has no on-chain proof signature — not crediting', env.gameId);
            return null;
        }
        var matchRef = matchRefFor(proofSig);

        // Resolve M3's award for THIS envelope. M3's handler runs BEFORE M4's in
        // the same seam pass and sets lastSeenAward synchronously, so read it
        // NOW; only if it isn't there yet (M3 still walking to its first await)
        // poll briefly for it.
        var award = pickM3Award(matchRef);
        if (!award) {
            var awardDeadline = Date.now() + 2000;
            while (Date.now() < awardDeadline) {
                await new Promise(function (r) { setTimeout(r, 80); });
                award = pickM3Award(matchRef);
                if (award) break;
            }
        }
        if (!award || !award.gameTag || !award.points || award.points <= 0) {
            lastError = 'M3 award not available or points <= 0';
            console.warn('[global-ledger] M3 award not available for', env.gameId, '— skipping credit');
            return null;
        }

        // Map M3's gameTag to the on-chain source_code enum.
        var sourceTag = award.gameTag; // e.g. 'ludo', 'ayo_olopon'
        var sourceCode = sourceCodeFor(sourceTag);
        if (sourceCode === 0) {
            lastError = 'unknown source code for gameTag: ' + sourceTag;
            console.warn('[global-ledger] unknown source code for gameTag:', sourceTag);
            return null;
        }

        lastSeenCredit = {
            sourceTag: sourceTag,
            points: award.points,
            position: award.position,
            reason: award.reason,
            kind: 0,
            matchRef: matchRef,
        };

        if (processed[matchRef]) {
            lastError = null;
            lastCredit = lastSeenCredit;
            notify(cached, lastCredit);
            return null;
        }
        if (!magicReady()) {
            for (var attempt = 0; attempt < 5; attempt++) {
                await new Promise(function (r) { setTimeout(r, 800); });
                if (magicReady()) break;
            }
            if (!magicReady()) {
                lastError = 'magicblockDice not ready';
                console.warn('[global-ledger] magicblockDice not ready — skipping credit', env.gameId);
                return null;
            }
        }

        // Notify subscribers the credit is in-flight.
        notify(null, {
            sourceTag: sourceTag,
            points: award.points,
            position: award.position,
            reason: award.reason,
            kind: 0,
            matchRef: matchRef,
            status: 'banking',
            at: Date.now(),
        });

        var attempts = 0;
        var lastErr = null;
        while (attempts < 3) {
            attempts++;
            try {
                // kind=0: GAME WIN — credits M4a pure + M4b lifetime + M4c spendable
                // MULTIPLAYER: credit the seat's OWN wallet when the M3 award
                // carries an identity (on-chain seat->wallet); solo = device wallet.
                var gAuth = (award && award.identity) ? award.identity : null;
                var sig = await window.gfgChain.recordGlobal(
                    0, sourceCode, award.points, award.reason, matchRef, gAuth,
                );
                processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
                persistProcessed();
                lastError = null;
                lastCredit = {
                    sourceTag: sourceTag,
                    points: award.points,
                    position: award.position,
                    reason: award.reason,
                    kind: 0,
                    matchRef: matchRef,
                    at: Date.now(),
                };
                console.log('[global-ledger] credited ' + award.points + 'pt (' + sourceTag + ' source=' + sourceCode + ', kind=0 game win) — ' + (sig || 'no sig'));
                var ledger = await refreshLedger(true);
                notify(ledger, lastCredit);
                return sig || null;
            } catch (e) {
                lastErr = (e && (e.message || e)) || String(e);
                console.warn('[global-ledger] credit attempt ' + attempts + '/3 failed (soft-fail):', lastErr);
                if (attempts < 3) await new Promise(function (r) { setTimeout(r, 1200); });
            }
        }

        // Every attempt errored — re-read to check if the write landed anyway.
        var reLedger = await refreshLedger(true);
        if (reLedger && String(reLedger.lastMatchRef || '') === String(matchRef)) {
            lastError = null;
            lastCredit = {
                sourceTag: sourceTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                kind: 0,
                matchRef: matchRef,
                at: Date.now(),
            };
            processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
            persistProcessed();
            notify(reLedger, lastCredit);
            return null;
        }
        lastError = lastErr || 'on-chain write failed after retries';
        console.warn('[global-ledger] credit failed after retries:', lastError);
        notify(reLedger, {
            sourceTag: sourceTag,
            points: award.points,
            position: award.position,
            reason: award.reason,
            kind: 0,
            matchRef: matchRef,
            status: 'failed',
            error: lastError,
            at: Date.now(),
        });
        return null;
    }

    function fillSlots(ledger) {
        var pureEls = document.querySelectorAll('[data-global-pure]');
        var lifeEls = document.querySelectorAll('[data-global-lifetime]');
        var spendEls = document.querySelectorAll('[data-global-spendable]');
        var lastEls = document.querySelectorAll('[data-global-last]');
        for (var i = 0; i < pureEls.length; i++) pureEls[i].textContent = ledger.pureLifetime || 0;
        for (var j = 0; j < lifeEls.length; j++) lifeEls[j].textContent = ledger.lifetime || 0;
        for (var k = 0; k < spendEls.length; k++) spendEls[k].textContent = ledger.spendableBalance || 0;
        for (var m = 0; m < lastEls.length; m++) {
            lastEls[m].textContent = ledger.lastPoints ? ('+ ' + ledger.lastPoints + ' pts') : '\u2014';
        }
    }

    function notify(ledger, credit) {
        subscribers.slice().forEach(function (cb) {
            try { cb(ledger || cached, credit || null); } catch (e) { /* ignore */ }
        });
    }

    // ---- public API -----------------------------------------------------
    window.globalLedger = {
        // Latest known ledger snapshot (or null). PURE cache read — never
        // fetches (single source of truth: the RPC is only consulted on the
        // first check after login and after a credit/spend write). Returns the
        // wallet-keyed snapshot from localStorage instantly.
        get: function () {
            return cached || null;
        },
        // True once this wallet has been verified (even with nothing on-chain
        // yet), so displays can show a real "no ledger yet" instead of an
        // eternal loading line. False = still unknown.
        checked: function () {
            return hasChecked();
        },
        // Blocking fetch of the global ledger (own account, gasless). Explicit
        // fresh read — pages never need it, but tools/debugging do. Dedupes
        // against a fetch already in flight.
        fetch: function () {
            return refreshLedger(true);
        },
        // Clear THIS wallet's stored snapshot + check marker so the next render
        // shows "no snapshot yet" until a fresh fetch lands. Called by the
        // central store (points-store.js) on a fresh sign-in — it wipes any
        // stale cached number so the new on-chain read is what's shown, never
        // the previous session's leftovers. Pure local op, no RPC.
        reset: function () {
            cached = null;
            var wk = walletKey();
            delete cacheStore[wk];
            delete metaStore[wk];
            try { localStorage.setItem(META_KEY, JSON.stringify(metaStore)); } catch (e) { /* ignore */ }
            fillSlots({ pureLifetime: 0, lifetime: 0, spendableBalance: 0, lastPoints: 0 });
            notify(null, null);
            return true;
        },
        // Programmatic credit (for M5 tier boost, M6 signup/referral/giveaway).
        // kind: 0 = game win, 1 = other. source: source-code enum (u8).
        // Points, reason, matchRef: same as the on-chain instruction.
        credit: async function (opts) {
            if (!magicReady()) return null;
            var kind = opts.kind != null ? opts.kind : 1;
            var sourceTag = opts.source || 'platform';
            var sourceCode = opts.sourceCode != null ? opts.sourceCode : (SOURCE_CODES[sourceTag] || 0);
            if (sourceCode === 0) {
                console.warn('[global-ledger] unknown source code for:', sourceTag);
                return null;
            }
            var points = opts.points || 0;
            var reason = opts.reason || 0;
            var matchRef = opts.matchRef || '0';
            try {
                var sig = await window.gfgChain.recordGlobal(
                    kind, sourceCode, points, reason, matchRef,
                );
                await refreshLedger(true);
                return sig || null;
            } catch (e) {
                console.warn('[global-ledger] credit failed (soft-fail):', e.message || e);
                return null;
            }
        },
        // Global spendable draw-down. Soft-fail. On Arc the relayer signs and the
        // contract's Insufficient check guards the balance.
        spend: async function (amount, reason, ref) {
            if (!magicReady()) return null;
            try {
                var sig;
                if (window.gfgChain && typeof window.gfgChain.spendGlobal === 'function') {
                    sig = await window.gfgChain.spendGlobal(amount, reason, ref);
                } else {
                    sig = await window.magicblockDice.spendGlobal(amount, reason, ref);
                }
                await refreshLedger(true);
                return sig || null;
            } catch (e) {
                console.warn('[global-ledger] spend failed (soft-fail):', e.message || e);
                return null;
            }
        },
        // Subscribe to ledger updates. Returns an unsubscribe function.
        subscribe: function (cb) {
            if (typeof cb === 'function') subscribers.push(cb);
            return function () {
                var i = subscribers.indexOf(cb);
                if (i >= 0) subscribers.splice(i, 1);
            };
        },
        get lastCredit() { return lastCredit; },
        get lastSeenCredit() { return lastSeenCredit; },
        get lastError() { return lastError; },
        clearTransient: function () {
            lastCredit = null;
            lastSeenCredit = null;
            lastError = null;
        },
    };

    // ---- seam subscription (the one plug) -------------------------------
    if (window.onGameResult) {
        window.onGameResult(function (env) {
            if (env && env.schema === 'gfg:game-result@1') bank(env);
        });
    }

    // Render the current wallet's cached ledger into the DOM slots so a page
    // shows the last-known numbers even before the first fresh fetch lands.
    function renderCached() {
        if (cached) fillSlots(cached);
    }

    // CENTRAL STORE DISPLAY CONTRACT (owner-approved 2026-08-19): a page load
    // NEVER consults the RPC. This poll only swaps the in-memory cache to the
    // restored wallet's snapshot and renders it (a silently restored session
    // shows the last-known localStorage numbers instantly). The RPC is
    // consulted ONLY by the central store on a fresh sign-in
    // (public/universal/points/points-store.js -> globalLedger.fetch) and by
    // the credit/spend path inside this module. The address-diff guard keeps
    // this the ONLY page-load cache sync (per wallet), and focus/pageshow
    // re-arm the poll so a session that finishes restoring after the initial
    // deadline still gets its cached snapshot shown exactly once.
    var pollActive = false;
    var lastReadWallet = null;
    function refreshWhenWalletReady(timeoutMs) {
        if (pollActive) return;
        pollActive = true;
        var deadline = Date.now() + (timeoutMs || 30000);
        (function poll() {
            var sdk = window.magicblockDice;
            var addr = readAddress();
            if (addr && sdk &&
                typeof sdk.isConfigured === 'function' && sdk.isConfigured()) {
                if (addr !== lastReadWallet) {
                    lastReadWallet = addr;
                    syncCacheToWallet();
                    renderCached();
                    // The cached slice now points at the live wallet's snapshot
                    // (or null for a new wallet). TELL subscribers so cache-driven
                    // cards that rendered earlier (e.g. the profile/points M4
                    // card at wallet-ready) re-render with the real ledger
                    // instead of locking onto a pre-swap "no ledger yet".
                    // Cache-only, zero RPC — mirrors the storage handler below.
                    notify(cached, null);
                }
                pollActive = false;
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
            else pollActive = false;
        })();
    }

    function handleDomReady() {
        renderCached();
        refreshWhenWalletReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', handleDomReady);
    } else {
        handleDomReady();
    }

    // A mobile session that finishes restoring after the initial deadline (or
    // a tab that sat in the background) re-arms the poll. The address-diff
    // guard means this adds NO extra RPC when the wallet is already handled.
    if (typeof window.addEventListener === 'function') {
        ['pageshow', 'focus'].forEach(function (ev) {
            window.addEventListener(ev, function () { handleDomReady(); });
        });
    }

    // On auth change (sign-in / sign-out on the same page) swap the cached
    // snapshot to the new wallet. The RPC is NOT touched here: a fresh
    // sign-in is owned by the central store (public/universal/points/
    // points-store.js), which resets the stored ledger then fetches fresh.
    // Signed-out visitors map to the empty 'anon' state, so a logged-out
    // shared browser never renders another user's cached numbers.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            syncCacheToWallet();
            renderCached();
        });
    }

    // Cross-tab sync: when another tab credits/spends it writes the SAME
    // localStorage board; a storage event repoints this tab's cache to the new
    // numbers with no RPC call at all.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key !== CACHE_KEY) return;
            loadCache();
            syncCacheToWallet();
            renderCached();
            notify(cached, lastCredit || null);
        });
    }

})();
