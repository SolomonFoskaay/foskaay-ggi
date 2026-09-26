// public/games/ludo-lab/mechanics/state/arc-game-flow.js
// arcv2m1 / GFG-BS bridge: makes the LIVE Ludo game use the GAME-AGNOSTIC
// settlement rail. Loaded LAST, and a NO-OP unless window.gfgChain.isArc() is
// true, so the live Solana game is completely untouched.
//
// GASLESS MODEL (owner-locked 2026-09-19): a match costs TWO transactions TOTAL,
// no matter how many moves or dice rolls:
//   - match start  -> ONE start commit (via window.gfgSettlement.start())
//   - match finish -> ONE co-signed settlement (via window.gfgSettlement.finish())
// EVERYTHING IN BETWEEN IS FREE: moves, dice rolls, turn changes, the turn
// clock, captures, passes. Nothing is written during play.
//
// The old per-action calls (openGame/seatUp/beginGame/commitMove/expireTurn/
// settleGameOrder) are NO LONGER USED here. They remain in the contract only as
// legacy; the hot path never calls them.
//
// This bridge is Ludo-specific ONLY in how it feeds the rail (turn order, finish
// order). The rail itself is universal: any game calls start()/move()/finish().
(function () {
    var POLL_MS = 1000;

    var cfg = null;
    var st = { matchRef: null, seatColors: [], started: false, settled: false, lastTurn: null, lastMoveSig: null };
    var gateInFlight = false; // re-entrancy guard for the async lives gate
    var startInFlight = false; // guard: the start commit is async (~3s); the 1s
    // tick must not fire a SECOND start for the same match. Without this the
    // duplicate lost the race and reverted on-chain with Exists() (one wasted tx).
    var lastStartRef = null; // the matchRef a start commit was already attempted for

    function isArc() { try { return !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()); } catch (e) { return false; } }
    function wallet() { try { return (window.gfgChainAdapter && window.gfgChainAdapter.walletAddress && window.gfgChainAdapter.walletAddress()) || null; } catch (e) { return null; } }
    function seatColors() { try { var a = window.getActiveSeats ? window.getActiveSeats() : null; if (a && a.length) return a.slice(0, 4); } catch (e) {} return ['green', 'yellow', 'blue', 'red']; }
    function curTurn() { try { return (window.getGameCurrentTurn && window.getGameCurrentTurn()) || null; } catch (e) { return null; } }
    async function loadCfg() {
        if (cfg) return cfg;
        try { cfg = await (await fetch('/arc-config.json', { cache: 'no-store' })).json(); } catch (e) { cfg = null; }
        return cfg;
    }
    function sponsor() { try { return cfg.rails.evm.sponsor; } catch (e) { return null; } }
    function ownerFor(color) {
        var isUser = !!(window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].isUser === true);
        return isUser ? wallet() : sponsor();
    }
    function matchActive() {
        try { return !!(window.__soloTurnArmed && window.__soloTurnArmed()); } catch (e) { return false; }
    }

    // 1) MATCH START: ONE start commit on the generic rail. No per-seat, no
    // beginGame, no per-turn calls ever again.
    async function ensureStarted() {
        if (st.started || !matchActive()) return;
        // Single-flight: a start commit takes ~3s, but this is called on a 1s
        // tick. If one is already in flight, do nothing (no duplicate on-chain
        // tx). Same for a ref we already attempted.
        if (startInFlight) return;
        var w = wallet(); if (!w) return;
        if (!window.gfgSettlement || !window.gfgMatchEngine) {
            // Do NOT fail silently: if the rail is missing, retry on the next tick
            // (the scripts may still be loading). Never write a half-start.
            return;
        }
        await loadCfg();
        var colors = seatColors();
        var ref = window.gfgGameMatchRef || Date.now();
        if (lastStartRef === ref) return; // already committed this match
        window.gfgGameMatchRef = ref;
        st.matchRef = ref; st.seatColors = colors;
        startInFlight = true;
        // Open the off-chain engine for this match (zero chain cost).
        try {
            window.gfgMatchEngine.open({
                gameTag: 'ludo', matchRef: ref, seats: colors.length,
                players: colors.map(ownerFor), turnSecs: 45,
                seatColors: colors,
            });
        } catch (e) { /* soft */ }
        // Publish the on-chain gameId used by the dice seed, so dice and the
        // settlement refer to the same match.
        try { window.__gfgGameId = window.gfgSettlement.state ? null : window.__gfgGameId; } catch (e) {}
        var r;
        try {
            r = await window.gfgSettlement.start({
                gameTag: 'ludo', matchRef: ref,
                p1: ownerFor(colors[0]), p2: ownerFor(colors[1] || colors[0]),
                seats: colors.length, ttlSecs: 3600,
            });
        } finally {
            startInFlight = false;
        }
        st.started = true;
        lastStartRef = ref;
        st.lastTurn = curTurn();
        console.log('[arc-flow] start commit', r && r.gameId, (r && r.tx) ? 'tx ' + r.tx : '(soft-failed)');
    }

    // 2) MOVES: recorded OFF-CHAIN ONLY. No transaction, no gas, ever.
    function recordMove(seat, moveObj) {
        if (!st.started || st.settled) return;
        try { if (window.gfgMatchEngine) window.gfgMatchEngine.move(seat, moveObj); } catch (e) { /* soft */ }
    }
    function syncTurn() {
        if (!st.started || st.settled) return;
        var turn = curTurn();
        if (!turn || turn === st.lastTurn) return;
        var colors = st.seatColors.length ? st.seatColors : seatColors();
        var prevIdx = colors.indexOf(st.lastTurn);
        var nextIdx = colors.indexOf(turn);
        st.lastTurn = turn;
        if (prevIdx < 0 || nextIdx < 0) return;
        // Record the handover as an off-chain move (so the digest reflects it).
        // A double (same seat keeps turn) is recorded too, so the log is faithful.
        recordMove(prevIdx, { pass: prevIdx, to: nextIdx, t: Date.now() });
        try { if (window.gfgMatchEngine) window.gfgMatchEngine.setTurn(nextIdx); } catch (e) { /* soft */ }
    }

    // 3) FINISH: ONE co-signed settlement for the whole match.
    async function finishOnchain() {
        if (!st.started || st.settled || !st.matchRef) return;
        if (!window.gfgSettlement || !window.gfgMatchEngine) return;
        var colors = st.seatColors.length ? st.seatColors : seatColors();
        var orderColors = (window.getFinishOrder && window.getFinishOrder()) || [];
        var orderIdx = [];
        for (var i = 0; i < orderColors.length; i++) {
            var idx = colors.indexOf(orderColors[i]);
            if (idx >= 0) orderIdx.push(idx);
        }
        if (!orderIdx.length) return;
        await loadCfg();
        // Close the off-chain engine with the result (the digest now covers it).
        try {
            window.gfgMatchEngine.close({
                finishOrder: orderIdx,
                winner: orderIdx[0],
                seats: colors.length,
                endedAt: Date.now(),
            });
        } catch (e) { /* soft */ }
        var r = await window.gfgSettlement.finish({});
        if (r && r.ok) {
            st.settled = true;
            console.log('[arc-flow] co-signed settlement', r.gameId, 'tx ' + r.tx);
            // OPPORTUNISTIC WINDOW FLUSH (no cron, per the project rule): after a
            // real settlement lands, ask the relayer whether the window is ready
            // (100 matches OR 1h old). It flushes ONLY when ready and NEVER an
            // empty window, so this adds no cost on a quiet day. This is what
            // makes the batch self-close from real activity instead of a button.
            tickBatch();
        } else {
            console.warn('[arc-flow] settlement soft-fail:', r && r.error);
        }
    }

    // Fire-and-forget window tick: the relayer decides (full OR aged) and skips
    // an empty window. Soft-fail; never blocks the ceremony.
    function tickBatch() {
        try {
            fetch('/api/arc', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'tickBatch' }),
            }).then(function (res) { return res.json(); }).then(function (j) {
                if (j && j.flushed) console.log('[arc-flow] window flushed', j.pending, 'match(es), tx ' + j.txHash);
                else if (j) console.log('[arc-flow] window not ready:', j.reason || 'waiting', j.pending != null ? '(' + j.pending + ' pending)' : '');
            }).catch(function () { /* soft */ });
        } catch (e) { /* soft */ }
    }

    function wrapCeremony() {
        var orig = window.showResultCeremony;
        if (typeof orig !== 'function' || orig.__arcWrapped) return;
        window.showResultCeremony = function () {
            try { finishOnchain(); } catch (e) {}
            return orig.apply(this, arguments);
        };
        window.showResultCeremony.__arcWrapped = true;
    }

    function reset() { st = { matchRef: null, seatColors: [], started: false, settled: false, lastTurn: null, lastMoveSig: null }; }

    // 5) LIVES GATE: the CHAIN is the authority. Before the local board starts,
    // await chargeLife. If the contract reverts (NoLives) the match is blocked
    // with the lives overlay; a modified client cannot skip it, because the
    // charge is what lets the game proceed. A transient network error does NOT
    // hard-block play (the local meter still gates), matching the soft-fail
    // contract everywhere else in the Arc rail.
    function blockNoLives() {
        try {
            if (typeof window.showLivesBlocked === 'function') window.showLivesBlocked(true);
            else if (typeof window.showAuthBanner === 'function') {
                window.showAuthBanner('No lives left today. Your meter refills at midnight (GMT).\n\nGo Premium for more lives.', true);
            }
        } catch (e) { /* soft */ }
    }
    function gateThenStart(orig, args) {
        // Re-entrancy guard: the gate is async, so a rapid double-tap before
        // setupConfigurationLocked is set must NOT charge twice.
        if (gateInFlight) return null;
        // Multiplayer exemption: an invited device (not the host seat 0) starts
        // its board to mirror the shared game; the HOST already consumed the
        // entry life on-chain, so the joiner must never be charged or blocked.
        try {
            var a = window.gfgLudoAdapter;
            var isMp = !!(a && typeof a.isActive === 'function' && a.isActive());
            var isHost = !!(a && typeof a.seat === 'function' && a.seat() === 0);
            if (isMp && !isHost) return orig.apply(window, args);
        } catch (e) { /* soft: fall through to the gate */ }
        var ref = window.gfgGameMatchRef || Date.now();
        window.gfgGameMatchRef = ref;
        gateInFlight = true;
        return Promise.resolve()
            .then(function () { return window.gfgChain.chargeLife(ref); })
            .then(function () {
                // Charged (or unlimited): let the normal start proceed, and tell
                // the game core the gate already charged so it never double-charges.
                window.__gfgArcLifeGateHandled = ref;
                gateInFlight = false;
                // FIX (3v): the chain HAS charged the life now, so refresh the
                // lives meter IMMEDIATELY. Without this it only updated on a
                // later match completion, so lives looked late or doubled. This
                // is game-agnostic: any game using this rail gets the same fix.
                try {
                    if (window.__gfgLivesSyncFromChain) window.__gfgLivesSyncFromChain();
                    window.dispatchEvent(new CustomEvent('gfg:life-charged', { detail: { matchRef: ref } }));
                } catch (e) { /* soft */ }
                return orig.apply(window, args);
            })
            .catch(function (e) {
                gateInFlight = false;
                var msg = (e && (e.message || e.shortMessage)) || String(e);
                if (/nolives|no lives|lives/i.test(msg)) {
                    console.warn('[arc-flow] lives gate blocked the match:', msg);
                    blockNoLives();
                    return null;
                }
                // Network/transient: do not break play; the local meter still gates.
                console.warn('[arc-flow] lives gate soft-fail (proceeding):', msg);
                return orig.apply(window, args);
            });
    }
    var startWrapped = false;
    function wrapStart() {
        if (startWrapped) return;
        var orig = window.initiateArenaMatch;
        if (typeof orig !== 'function') return; // not defined yet; retry later
        window.initiateArenaMatch = function () {
            if (!isArc()) return orig.apply(this, arguments);
            return gateThenStart(orig, arguments);
        };
        startWrapped = true;
    }

    function tick() {
        if (!isArc()) return;
        try { ensureStarted(); } catch (e) {}
        try { syncTurn(); } catch (e) {}
    }

    // The page ends a match with Play Again -> reset the local bridge state.
    try {
        var origPlayAgain = window.playAgainAfterCeremony;
        if (typeof origPlayAgain === 'function' && !origPlayAgain.__arcWrapped) {
            window.playAgainAfterCeremony = function () { try { reset(); startInFlight = false; lastStartRef = null; } catch (e) {} return origPlayAgain.apply(this, arguments); };
            window.playAgainAfterCeremony.__arcWrapped = true;
        }
    } catch (e) { /* soft */ }

    try { wrapCeremony(); } catch (e) {}
    try { wrapStart(); } catch (e) {}
    // The page may define initiateArenaMatch after this file loads; re-wrap
    // until it is present and still unguarded.
    try { setInterval(function () { if (!window.initiateArenaMatch || !window.initiateArenaMatch.__arcGated) wrapStart(); }, 2000); } catch (e) {}
    try { setInterval(function () { if (window.playAgainAfterCeremony !== undefined) wrapCeremony(); }, 2000); } catch (e) {}
    try { setInterval(tick, POLL_MS); } catch (e) {}
})();
