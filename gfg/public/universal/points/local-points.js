// public/universal/points/local-points.js
// M3 — LOCAL POINTS MODULE (universal, game-agnostic).
//
// Consumes the universal result seam (M2): subscribes to window.onGameResult
// ONCE and banks local points for the 'user' seat from verified finishes.
// A game never ships reward code — ANY M1 game (Ludo, Ayo Olopon, ...) plugs in
// here by emitting the same envelope; this module owns the per-game scoring
// table, the two-track on-chain ledger and the DOM slots.
//
// On-chain: per-game PlayerPoints PDA (seed [gfgpoints, game_tag, player])
// holding BOTH tracks gasless on the MagicBlock ER:
//   - local_pure_lifetime     (unspendable lifetime wins in that game)
//   - local_spendable_balance (the spendable split, drawn only by that game's
//                              own in-game spends via localPoints.spend)
//
// Gating: a finish only banks when the envelope carries a valid on-chain
// proof signature (proof-of-play). match_ref = first 8 bytes of that signature
// binds the award to the exact winning roll and makes the bank idempotent.
//
// Exposes window.localPoints = { get(gameTag), spend(gameTag, amount, reason,
// ref), subscribe(cb) } and fills any DOM slot marked data-local-points-pure /
// data-local-points-spendable on any game page.
(function () {

    var DEFAULT_TAG = 'ludo';

    // Per-game scoring table (M3 module config — the GAME never knows points
    // rules; adding a game = add its table here, the game only emits the seam).
    // key = gameId from the M2 envelope. gameTag = the on-chain seed tag.
    var GAMES = {
        ludo: {
            gameTag: 'ludo',
            // Ranked rewards by position, 1-indexed, per mode (players length).
            // 4P graduated: 1st=100 / 2nd=50 / 3rd=25 / 4th=0. The game auto-ends
            // once 3 winners emerge, so the last seat earns nothing. 2P: the
            // game auto-ends the moment 1st emerges, so 2nd earns nothing too.
            positions: {
                4: { 1: 100, 2: 50, 3: 25, 4: 0 },
                2: { 1: 100, 2: 0 },
            },
            reasons: { win1st: 1, win2nd: 2, win3rd: 3 },
        },
        chess: {
            gameTag: 'chess',
            // Win = 1st place. A draw publishes BOTH seats at position 1, so a
            // draw shares the win pool (M3 owner-tuneable). 2 seats only.
            positions: {
                2: { 1: 100, 2: 0 },
            },
            reasons: { win1st: 1, win2nd: 2, win3rd: 3 },
        },
    };

    // Track which match_refs were already banked (in-memory + localStorage) so
    // a reload or duplicate seam event never double-banks. The program also
    // guards via last_match_ref on-chain; this is the cheap client-side layer.
    var PROCESSED_KEY = 'gfg_local_points_processed_v1';
    var processed = {};
    try {
        processed = JSON.parse(window.localStorage.getItem(PROCESSED_KEY) || '{}') || {};
    } catch (e) { processed = {}; }

    function persistProcessed() {
        try { window.localStorage.setItem(PROCESSED_KEY, JSON.stringify(processed)); } catch (e) { /* ignore */ }
    }

    // Ledger cache, keyed by WALLET so a shared browser never shows one signed-in
    // user's numbers to another. cacheStore = { <wallet> : { gameTag: ledger } }.
    var CACHE_KEY = 'gfg_local_points_cache_v2';
    var cacheStore = {};
    var cached = {};        // current wallet's gameTag -> ledger snapshot
    var subscribers = [];   // callbacks invoked after a bank / spend / refresh
    var lastAward = null;   // last successfully banked award (shown by ceremonies)
    var lastSeenAward = null; // award computed for the most recent finish (shown as "banking..." before it lands)
    var lastError = null;   // last bank failure reason (ceremony shows it when the write hiccups)

    // SINGLE-SOURCE-OF-TRUTH RPC ECONOMY (owner design, 2026-08-18): the
    // localStorage cache is the ONLY display source. Pages read it with
    // get() (pure read, never fetches). The RPC is hit ONLY when:
    //   1. the ledger is FIRST checked for this wallet after a login page boot
    //      (so a silently restored session / new device never shows a wrong
    //      zero), and
    //   2. right after a bank/spend write (so the board posts the new balance).
    // A player who doesn't win all day costs ~1-3 RPC hits for the whole
    // browser, not one per page view. __meta.checkedTags records which games
    // were already verified so we never re-fetch them per page load. A
    // zero-result (no account yet) is legitimately "checked" for display,
    // but it does NOT freeze the wallet: a zero checkpoint is re-verified at
    // each wallet-ready boot / auth change, so an on-chain balance that
    // existed before the module was wired (migration-era ledgers) shows up
    // once the wallet is ready, and a transient outage never freezes a fresh
    // zero forever. Populated ledgers stay cached until the next win/spend.
    var refreshInFlight = {};  // gameTag -> in-flight refresh promise (dedup)

    // __meta lives INSIDE the wallet's cache slice so wallet isolation holds:
    //   cacheStore[wk] = cached = { ludo: ledger, ..., __meta: { checkedTags: { ludo: {at, any} } } }
    // It is written on the `cached` slice object itself so persistCache()
    // (which persists `cached`) carries it to storage in the same write.
    function metaFor() {
        if (!cached || typeof cached !== 'object') cached = {};
        if (!cached.__meta) cached.__meta = { checkedTags: {} };
        return cached.__meta;
    }
    function markChecked(gameTag, any) {
        var m = metaFor();
        if (!m.checkedTags) m.checkedTags = {};
        m.checkedTags[gameTag] = { at: Date.now(), any: !!any };
        persistCache();
    }
    // A ledger display may render a "no rewards yet" line once a game has been
    // checked (even with nothing on-chain); before that it can only say "loading".
    function hasChecked(gameTag) {
        var c = metaFor().checkedTags && metaFor().checkedTags[gameTag];
        return !!c;
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
    // after login + after a bank/spend). The address comes ONLY from the LIVE
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

    // Point `cached` at the current wallet's slice (empty until that wallet's
    // ledger has been fetched).
    function syncCacheToWallet() {
        var wk = walletKey();
        cached = (cacheStore[wk] && typeof cacheStore[wk] === 'object') ? cacheStore[wk] : {};
    }

    loadCache();
    syncCacheToWallet();

    function persistCache() {
        try {
            var wk = walletKey();
            if (!cacheStore[wk]) cacheStore[wk] = {};
            cacheStore[wk] = cached;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheStore));
        } catch (e) { /* ignore */ }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Resolve the points module config for an envelope's gameId. Unknown games
    // are ignored (no scoring table yet = no points).
    function configFor(gameId) {
        return GAMES[gameId] || null;
    }

    // The 'user' seat earns AT ITS OWN finishing position, and only the user
    // seat ever earns (house/local seats earn nothing regardless of position).
    function computeAward(env) {
        var cfg = configFor(env.gameId);
        if (!cfg) return null;
        var user = null;
        for (var i = 0; i < env.players.length; i++) {
            if (env.players[i].actor === 'user') { user = env.players[i]; break; }
        }
        if (!user) return null;                      // no signed-in 'You' seat
        if (typeof user.position !== 'number') return null;
        var n = env.players.length;
        var mode = n <= 2 ? 2 : 4;
        var table = cfg.positions[mode] || cfg.positions[4] || {};
        var points = table[user.position] || 0;
        if (points <= 0) return null;                // nothing to bank
        // Position-aware reason: 1st=WIN_1ST, 2nd=WIN_2ND, 3rd=WIN_3RD (the
        // program stores any u8; the old code labelled every placed finish
        // WIN_1ST, which mislabelled 2nd/3rd awards).
        var reason = cfg.reasons.win1st;
        if (cfg.reasons.win2nd && user.position === 2) reason = cfg.reasons.win2nd;
        if (cfg.reasons.win3rd && user.position === 3) reason = cfg.reasons.win3rd;
        return {
            seat: user.seat,
            identity: user.identity != null ? String(user.identity) : null,
            gameTag: cfg.gameTag,
            points: points,
            reason: reason,
            position: user.position,
            at: Date.now(),
        };
    }

    // MULTIPLAYER: every 'user' seat earns at its OWN position. Solo (one user)
    // returns a single-element array, behaviour identical to computeAward.
    function computeAwards(env) {
        var cfg = configFor(env.gameId);
        if (!cfg) return [];
        var n = env.players.length;
        var mode = n <= 2 ? 2 : 4;
        var table = cfg.positions[mode] || cfg.positions[4] || {};
        var out = [];
        for (var i = 0; i < env.players.length; i++) {
            var p = env.players[i];
            if (!p || p.actor !== 'user') continue;   // house/local never earn
            if (typeof p.position !== 'number') continue;
            // Identity is optional: it flows through when the game shipped the
            // on-chain seat -> wallet map (M12), but the actual bank ALWAYS
            // signs with THIS device's session key (per-device crediting), so a
            // solo 'user' seat without an explicit identity still banks.
            var id = (p.identity != null && p.identity !== '') ? String(p.identity) : resolveUserIdentityFallback();
            var points = table[p.position] || 0;
            if (points <= 0) continue;
            var reason = cfg.reasons.win1st;
            if (cfg.reasons.win2nd && p.position === 2) reason = cfg.reasons.win2nd;
            if (cfg.reasons.win3rd && p.position === 3) reason = cfg.reasons.win3rd;
            out.push({
                seat: p.seat,
                identity: id,
                gameTag: cfg.gameTag,
                points: points,
                reason: reason,
                position: p.position,
                at: Date.now(),
            });
        }
        return out;
    }

    // Fallback identity for a user seat without an explicit wallet (Solo path).
    function resolveUserIdentityFallback() {
        try {
            if (window.currentProfile && window.currentProfile.solana_wallet) return window.currentProfile.solana_wallet;
            if (window.getDynamicSolanaWallet) {
                var w = window.getDynamicSolanaWallet();
                if (w) return (typeof w === 'string') ? w : (w.address || null);
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Match-ref from the proof signature (first 8 bytes as u64) — matches the
    // client's matchRefFromSignature used by the game's own reward wiring.
    function matchRefFor(proofSig) {
        if (!proofSig) return '0';
        // ARC (arcv2m17 audit): on Arc the proof token is a HEX seed hash, not a
        // base58 signature, so the Solana SDK math would give a wrong ref. The
        // gateway returns a valid numeric ref for Arc (and the same base58 math
        // on Solana), so always prefer it.
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
            // bs58-free fallback: decode the first 8 bytes into a u64 string.
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
        return !!(window.gfgChain && typeof window.gfgChain.recordPoints === 'function');
    }

    async function refreshLedger(gameTag, force) {
        gameTag = gameTag || DEFAULT_TAG;
        if (refreshInFlight[gameTag]) return refreshInFlight[gameTag]; // share the in-flight fetch
        var firstCheck = !hasChecked(gameTag); // notify once when a zero check lands
        refreshInFlight[gameTag] = (async function () {
            var ledger = null;
            // ARC (arcv2m17 audit): read through the chain gateway, NEVER the
            // Solana SDK. The old code called sdk.fetchPointsPdaFor unconditionally,
            // so every page on an Arc build issued a Solana read. On Arc the
            // gateway returns the same shape (pureLifetime/spendableBalance).
            var onArc = false;
            try { onArc = !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { onArc = false; }
            if (onArc) {
                try {
                    var arcLedger = (window.gfgChain.fetchLedger) ? await window.gfgChain.fetchLedger(gameTag) : null;
                    if (arcLedger) {
                        cached[gameTag] = arcLedger;
                        if (hasRealWallet()) markChecked(gameTag, true);
                        persistCache();
                        fillSlots(gameTag, arcLedger);
                        notify(gameTag, arcLedger);
                        return arcLedger;
                    }
                } catch (e) { /* soft: fall through to the cached render below */ }
                if (hasRealWallet()) markChecked(gameTag, false);
                if (firstCheck) notify(gameTag, null, null);
                return cached[gameTag] || null;
            }
            try {
                // READ BY WALLET ADDRESS first (no signing session required —
                // mirrors the recovery page). Falls back to the sign-in-scoped
                // fetch for SDK builds without the address-based reader.
                var addr = readAddress();
                var sdk = window.magicblockDice;
                console.log('[local-points] refresh start: readAddress() =', addr, '| magicblockDice =', !!(sdk && sdk.isConfigured && sdk.isConfigured()));
                if (addr && sdk && typeof sdk.fetchPointsPdaFor === 'function') {
                    ledger = await sdk.fetchPointsPdaFor(gameTag, addr);
                }
                if (!ledger && sdk && typeof sdk.fetchPointsPda === 'function') {
                    ledger = await sdk.fetchPointsPda(gameTag);
                }
                if (ledger) {
                    cached[gameTag] = ledger;
                    if (hasRealWallet()) markChecked(gameTag, true);
                    persistCache();
                    fillSlots(gameTag, ledger);
                    notify(gameTag, ledger);
                    return ledger;
                }
            } catch (e) { /* ledger not readable yet (not onboarded / wallet busy) */ }
            // Not readable this instant (wallet not restored, ER down, or the
            // account simply doesn't exist yet). Keep rendering the last-known
            // value so the DOM never sits on static 0 / em-dash. A wallet
            // present + reachable fetch counts as "checked" (even a no-account
            // zero is a genuine answer) so we don't refetch it on every load;
            // network-y errors leave the marker unset so the next page retries.
            if (hasRealWallet()) markChecked(gameTag, false);
            if (firstCheck) notify(gameTag, null, null); // pages flip their "loading" line to "no rewards yet"
            var fallback = cached[gameTag] || null;
            if (fallback) fillSlots(gameTag, fallback);
            return fallback;
        })();
        try {
            return await refreshInFlight[gameTag];
        } finally {
            delete refreshInFlight[gameTag];
        }
    }

    // Bank a verified finish. Never throws to the game — M3 banking is a
    // soft-fail best-effort gasless write that must never block the win UX.
    // Resilient: retries the write (the on-chain DuplicateMatchRef guard keeps
    // retries idempotent) and, if every attempt errored, re-reads the ledger in
    // case the write actually landed (e.g. a confirm-timeout false failure).
    async function bank(env) {
        // MULTIPLAYER-AWARE: computeAwards returns one award per 'user' seat
        // (each device's own seat). On a device hosting exactly one user seat
        // this is identical to computeAward; it also banks every user seat when
        // a single device legitimately carries multiple user seats.
        var awards = computeAwards(env);
        if (!awards || !awards.length) return null;
        var award = awards[0];
        lastSeenAward = award;
        var proofSig = env.proof && env.proof.signature;
        if (!proofSig) {
            lastError = 'finish has no on-chain proof signature';
            console.warn('[local-points] finish has no on-chain proof signature — not banking', env.gameId);
            return null;
        }
        var matchRef = matchRefFor(proofSig);
        if (processed[matchRef]) {
            // Already banked this match_ref (e.g. the same finish fired the seam
            // twice, or a reload). Surface the earlier success to the UI anyway.
            lastError = null;
            lastAward = {
                gameTag: award.gameTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                matchRef: matchRef,
                at: Date.now(),
            };
            notify(award.gameTag, cached[award.gameTag] || null, lastAward);
            return null;
        }
        if (!magicReady()) {
            // magicblockDice not initialized yet (module script loads before
            // main.js). Retry a few times, then give up for this event.
            for (var attempt = 0; attempt < 5; attempt++) {
                await new Promise(function (r) { setTimeout(r, 800); });
                if (magicReady()) break;
            }
            if (!magicReady()) {
                lastError = 'magicblockDice not ready';
                console.warn('[local-points] magicblockDice not ready — skipping bank', env.gameId);
                return null;
            }
        }

        // Tell the win ceremony the award is being written (it opens right
        // after the seam fires, so this shows the in-flight state).
        notify(award.gameTag, null, {
            gameTag: award.gameTag, points: award.points, position: award.position,
            reason: award.reason, matchRef: matchRef, status: 'banking', at: Date.now(),
        });

        var attempts = 0;
        var lastErr = null;
        // MULTIPLAYER: an award may carry the seat's OWN wallet (from the
        // on-chain seat->wallet map). Bank it to THAT wallet, not this device's,
        // so every logged-in player is credited at their own wallet no matter
        // who created the match. Solo identity is null -> this device's wallet.
        var authority = (award && award.identity) ? award.identity : null;
        while (attempts < 3) {
            attempts++;
            try {
                var sig = await window.gfgChain.recordPoints(
                    award.gameTag, award.points, award.reason, matchRef, authority,
                );
                processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
                persistProcessed();
                lastError = null;
                lastAward = {
                    gameTag: award.gameTag,
                    points: award.points,
                    position: award.position,
                    reason: award.reason,
                    matchRef: matchRef,
                    identity: award.identity || null,
                    at: Date.now(),
                };
                console.log('[local-points] banked ' + award.points + 'pt (ludo ' + award.position + 'st place, user seat' + (award.identity ? ' ' + award.identity : '') + ') — ' + (sig || 'no sig'));
                var ledger = await refreshLedger(award.gameTag, true);
                notify(award.gameTag, ledger, lastAward);
                // Multi-seat: bank the remaining user seats too (each to ITS OWN wallet).
                for (var k = 1; k < awards.length; k++) {
                    try {
                        var aw = awards[k];
                        await window.gfgChain.recordPoints(
                            aw.gameTag, aw.points, aw.reason, matchRef + k,
                            (aw && aw.identity) ? aw.identity : null,
                        );
                    } catch (e) { /* soft */ }
                }
                return sig || null;
            } catch (e) {
                lastErr = (e && (e.message || e)) || String(e);
                console.warn('[local-points] bank attempt ' + attempts + '/3 failed (soft-fail):', lastErr);
                if (attempts < 3) await new Promise(function (r) { setTimeout(r, 1200); });
            }
        }

        // Every attempt errored, but the write may have landed anyway (ER
        // confirm-timeout false failure). Re-read the ledger: if this match_ref
        // is now on-chain, treat the bank as successful.
        var reLedger = await refreshLedger(award.gameTag, true);
        if (reLedger && String(reLedger.lastMatchRef || '') === String(matchRef)) {
            lastError = null;
            lastAward = {
                gameTag: award.gameTag,
                points: award.points,
                position: award.position,
                reason: award.reason,
                matchRef: matchRef,
                at: Date.now(),
            };
            processed[matchRef] = { gameId: env.gameId, points: award.points, at: Date.now() };
            persistProcessed();
            notify(award.gameTag, reLedger, lastAward);
            return null;
        }
        lastError = lastErr || 'on-chain write failed after retries';
        console.warn('[local-points] bank failed after retries:', lastError);
        notify(award.gameTag, reLedger, {
            gameTag: award.gameTag, points: award.points, position: award.position,
            reason: award.reason, matchRef: matchRef, status: 'failed', error: lastError, at: Date.now(),
        });
        return null;
    }

    function fillSlots(gameTag, ledger) {
        var pureEls = document.querySelectorAll('[data-local-points-pure]');
        var spendEls = document.querySelectorAll('[data-local-points-spendable]');
        var tagEls = document.querySelectorAll('[data-local-points-game]');
        var lastEls = document.querySelectorAll('[data-local-points-last]');
        for (var i = 0; i < pureEls.length; i++) pureEls[i].textContent = ledger.pureLifetime || 0;
        for (var j = 0; j < spendEls.length; j++) spendEls[j].textContent = ledger.spendableBalance || 0;
        for (var k = 0; k < tagEls.length; k++) tagEls[k].textContent = gameTag;
        for (var m = 0; m < lastEls.length; m++) {
            lastEls[m].textContent = ledger.lastPoints ? ('+ ' + ledger.lastPoints + ' pts') : '—';
        }
    }

    function notify(gameTag, ledger, award) {
        subscribers.slice().forEach(function (cb) {
            try { cb(gameTag, ledger, award || null); } catch (e) { /* ignore */ }
        });
    }

    // ---- public API -----------------------------------------------------
    window.localPoints = {
        // Latest known ledger for a game (or null). PURE cache read — never
        // fetches (single source of truth: the RPC is only consulted on the
        // first check after login and after a bank/spend write). Returns the
        // wallet-keyed snapshot from localStorage instantly.
        get: function (gameTag) {
            return cached[gameTag || DEFAULT_TAG] || null;
        },
        // True once this game has been verified for the current wallet (even
        // with nothing on-chain yet), so displays can show a real "no rewards
        // yet" instead of an eternal loading line. False = still unknown.
        checked: function (gameTag) {
            return hasChecked(gameTag || DEFAULT_TAG);
        },
        // Blocking fetch of the ledger for a game (own account, gasless).
        // Explicit fresh read — pages never need it, but tools/debugging do.
        // Dedupes against a fetch already in flight.
        fetch: function (gameTag) {
            return refreshLedger((gameTag || DEFAULT_TAG), true);
        },
        // Clear THIS wallet's stored consumption snapshot(s) so the next
        // render shows "no snapshot yet" until a fresh fetch lands. Called by
        // the central store (points-store.js) on a fresh sign-in — it wipes
        // any stale cached number so the new on-chain read is what's shown,
        // never the previous session's leftovers. Pure local op, no RPC.
        reset: function (gameTag) {
            var wk = walletKey();
            if (gameTag) {
                var tag = gameTag || DEFAULT_TAG;
                delete cached[tag];
                if (cacheStore[wk] && typeof cacheStore[wk] === 'object') delete cacheStore[wk][tag];
                var m = metaFor();
                if (m.checkedTags) delete m.checkedTags[tag];
            } else {
                // Wipe this wallet's whole slice + check markers (all games).
                cached = {};
                if (cacheStore[wk] && typeof cacheStore[wk] === 'object') cacheStore[wk] = {};
                var meta = metaFor();
                if (meta.checkedTags) meta.checkedTags = {};
            }
            persistCache();
            var t = gameTag || DEFAULT_TAG;
            fillSlots(t, { pureLifetime: 0, spendableBalance: 0, lastPoints: 0 });
            notify(t, null, null);
            return true;
        },
        // Spendable draw-down for that game's own in-game spends. `ref` is the
        // purchase reference that makes the spend replayable. Soft-fail.
        spend: async function (gameTag, amount, reason, ref) {
            var tag = gameTag || DEFAULT_TAG;
            if (!magicReady()) return null;
            try {
                // ARC (arcv2m17 audit): spend through the gateway, never the
                // Solana SDK. gfgChain.spendLocal routes to the Arc adapter on
                // Arc and to the ER session key on Solana.
                var sig = await window.gfgChain.spendLocal(tag, amount, reason, ref);
                await refreshLedger(tag, true);
                return sig || null;
            } catch (e) {
                console.warn('[local-points] spend failed (soft-fail):', e.message || e);
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
        // Last successfully banked award (shown by ceremonies), or null.
        get lastAward() { return lastAward; },
        // Award computed for the most recent finish (may still be banking or
        // failed — the ceremony uses it to show the in-flight state), or null.
        get lastSeenAward() { return lastSeenAward; },
        // Last bank failure reason (null when the last bank succeeded). Useful
        // for the ceremony to explain a pending state honestly.
        get lastError() { return lastError; },
        // Forget the transient award/error state. Games call this when a new
        // match starts so a previous finish's "banked/failed" line can never
        // leak into the next ceremony.
        clearTransient: function () {
            lastAward = null;
            lastSeenAward = null;
            lastError = null;
        },
    };

    // ---- seam subscription (the one plug) -------------------------------
    if (window.onGameResult) {
        window.onGameResult(function (env) {
            if (env && env.schema === 'gfg:game-result@1') bank(env);
        });
    }

    // The game tag to display/fetch on this page (defaults to 'ludo').
    function pickGameTag() {
        var tag = DEFAULT_TAG;
        var auto = document.querySelector('[data-local-points-game]');
        if (auto) tag = auto.getAttribute('data-local-points-game') || tag;
        return tag;
    }

    // Render the current wallet's cached ledger into the DOM slots so a page
    // shows the last-known numbers even before the first fresh fetch lands.
    function renderCached(tag) {
        if (cached[tag]) fillSlots(tag, cached[tag]);
    }

    // Refresh ONCE when the module is usable AND the Dynamic session/wallet has
    // been restored. On a plain page load the wallet arrives AFTER
    // DOMContentLoaded (async session restore), and gfg:auth-changed only
    // fires on interactive sign-in/out — so without this poll a silently
    // restored session could leave the board stuck. It is the ONLY page-load
    // fetch: limited to the first check for the wallet (and the zero-ledger
    // recheck at every wallet-ready boot). After that every page view reads
    // the cached board and never consults the RPC until the next win/spend.
    // CENTRAL STORE DISPLAY CONTRACT (owner-approved 2026-08-19): a page load
    // NEVER consults the RPC. This poll only swaps the in-memory cache slice to
    // the restored wallet's snapshot and renders it (a silently restored
    // session shows the last-known localStorage numbers instantly). The RPC is
    // consulted ONLY by the central store on a fresh sign-in
    // (public/universal/points/points-store.js -> localPoints.fetch) and by the
    // win/spend path inside this module. The address-diff guard keeps this the
    // ONLY page-load cache sync (per wallet), and focus/pageshow re-arm the
    // poll so a session that finishes restoring after the initial deadline
    // still gets its cached slice shown exactly once.
    var pollActive = false;
    var lastReadWallet = null;
    function refreshWhenWalletReady(tag, timeoutMs) {
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
                    renderCached(tag);
                    // The cached slice now points at the live wallet's snapshot
                    // (or null for a new wallet). TELL subscribers so cache-driven
                    // cards that rendered earlier re-render with the real ledger
                    // instead of locking onto a pre-swap "no snapshot yet".
                    // Cache-only, zero RPC — mirrors the storage handler below.
                    notify(tag, cached[tag] || null, lastAward || null);
                }
                pollActive = false;
                return;
            }
            if (Date.now() < deadline) setTimeout(poll, 700);
            else pollActive = false;
        })();
    }

    function handleDomReady() {
        var tag = pickGameTag();
        renderCached(tag);
        refreshWhenWalletReady(tag);
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
    // slice to the new wallet. The RPC is NOT touched here: a fresh sign-in is
    // owned by the central store (public/universal/points/points-store.js),
    // which resets the stored points then fetches fresh. Signed-out visitors
    // map to the empty 'anon' slice, so a logged-out shared browser never
    // renders another user's cached numbers.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('gfg:auth-changed', function () {
            syncCacheToWallet();
            var tag = pickGameTag();
            renderCached(tag);
        });
    }

    // Cross-tab sync: when another tab banks/spends it writes the SAME
    // localStorage board; a storage event repoints this tab's cache to the new
    // numbers with no RPC call at all.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', function (e) {
            if (e.key !== CACHE_KEY) return;
            loadCache();
            syncCacheToWallet();
            var tag = pickGameTag();
            renderCached(tag);
            notify(tag, cached[tag] || null, lastAward || null);
        });
    }

})();
