// Foskaay GGI Ludo demo bridge.
//
// Connects the ludo-lab board/dice skin to the Foskaay GGI Midchain. The GAME is
// a pure contract (FoskaayGGILudo): every roll and move runs via eth_call for
// free, and the relay hash-chains and signs each new state. Only the connect
// (handover + fee) and the settle are transactions. There is no replay.
//
// The board shown here is ALWAYS the contract's own decoded state (bytes on
// chain, rendered here). Nothing is invented on this page and nothing is stored
// in localStorage.
(function () {
    'use strict';

    var RELAY = '/api/foskaay-ggi-sponsor';
    var COLOR_OF = ['green', 'yellow', 'blue', 'red'];
    var SEAT_OF = { green: 0, yellow: 1, blue: 2, red: 3 };

    var SID = null, USER = null, SESSION_KEY = null, USERSEAT = 0, SEATS = 2;
    var VIEW = null;
    var pendingDice = [];
    var busy = false;

    // ---- globals board.js / paths.js read ----
    window.currentTurn = 'green';
    window.playerProfiles = {
        green: { mode: 'computer', isUser: false },
        yellow: { mode: 'computer', isUser: false },
        blue: { mode: 'computer', isUser: false },
        red: { mode: 'computer', isUser: false }
    };
    window.displayDiceOnBoard = false;
    window.isDiceRolled = false;
    window.currentTurnMoves = [];
    window.setupConfigurationLocked = false;
    window.matchOver = false;
    window.isGamePaused = false;
    window.isChainDown = false;
    window.gfgRemoteTurn = function () { return false; };
    window.getActiveSeats = function () { return COLOR_OF.slice(0, SEATS); };
    window.getPlayerRank = function (color) {
        if (!VIEW || !VIEW.order) return 0;
        var fc = VIEW.finishCount || 0;
        for (var i = 0; i < fc; i++) {
            if (VIEW.order[i] === SEAT_OF[color]) return i + 1;
        }
        return 0;
    };
    window.finalizeDiceScores = function () {}; // dice values are already the chain's

    function ui() { return window.gfgLudoUI || {}; }
    function setPrompt(s) { if (ui().prompt) ui().prompt(s); }
    // A relay cold start loses the in-memory session. Never freeze the page:
    // tell the player to start a new match and re-arm the UI.
    function handleLost(e) {
        setPrompt('This session was lost on the server. Start a new match.');
        window.matchOver = true;
        window.isDiceRolled = false;
        pendingDice = [];
        if (ui().sessionLost) ui().sessionLost();
        if (ui().log) ui().log('Session lost (relay restarted): ' + ((e && e.message) || e), 0);
    }
    function isLostError(e) { return (e && /unknown session/i.test(e.message || String(e))); }

    function relay(action, extra) {
        var body = Object.assign({ action: action }, extra || {});
        return fetch(RELAY, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) {
            return r.json().then(function (j) {
                if (!j.ok) throw new Error(j.error || ('relay ' + r.status));
                return j;
            });
        });
    }

    // Vercel serves multiple relay instances, each with its own in-memory session.
    // A request that lands on the "wrong" instance says unknown session; retrying
    // a few times usually reaches the warm instance that still holds the match, so
    // new games no longer freeze after a few moves.
    function relayRetry(action, extra) {
        var tries = 4;
        var attempt = function (i) {
            return relay(action, extra).catch(function (e) {
                var msg = (e && e.message) || String(e);
                if (i < tries && /unknown session/i.test(msg)) {
                    return new Promise(function (res) { setTimeout(res, 250 * i + 150); }).then(function () { return attempt(i + 1); });
                }
                throw e;
            });
        };
        return attempt(0);
    }

    function tokenCR(seat, stepsWalked) {
        var color = COLOR_OF[seat];
        if (stepsWalked >= 52) {
            var lane = stepsWalked - 51;
            if (color === 'green') return { c: lane, r: 7 };
            if (color === 'yellow') return { c: 7, r: lane };
            if (color === 'blue') return { c: 14 - lane, r: 7 };
            return { c: 7, r: 14 - lane };
        }
        var abs = (START_INDEX[color] + stepsWalked) % 52;
        return COMMON_PATH[abs];
    }

    // Paint the contract board (decoded bytes) into the skin's token model.
    function applyBoard(view) {
        VIEW = view;
        SEATS = view.seatCount;
        var t = window.tokens;
        for (var s = 0; s < 4; s++) {
            var color = COLOR_OF[s];
            for (var i = 0; i < 4; i++) {
                var steps = view.steps[s * 4 + i];
                var tok = t[color][i];
                if (steps < 0) {
                    tok.stepsWalked = 0;
                    tok.pathIndex = -1;
                    tok.c = HOME_YARDS[color][i].c;
                    tok.r = HOME_YARDS[color][i].r;
                } else {
                    tok.stepsWalked = steps;
                    tok.pathIndex = steps >= 57 ? -2 : ((SEAT_OF[color] * 13 + steps) % 52);
                    var cr = tokenCR(s, steps);
                    tok.c = cr.c;
                    tok.r = cr.r;
                }
            }
        }
        window.currentTurn = COLOR_OF[view.turn] || 'green';
        window.matchOver = !!view.matchOver;
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
    }

    function hasLegalMove(seat, dice) {
        for (var i = 0; i < 4; i++) {
            var steps = VIEW.steps[seat * 4 + i];
            for (var d = 0; d < dice.length; d++) {
                var val = dice[d];
                if (steps < 0) { if (val === 6) return true; }
                else if (steps < 57 && steps + val <= 57) return true;
            }
        }
        return false;
    }

    // ---- the turn flow ----

    function beginTurn() {
        if (!VIEW) return;
        if (VIEW.matchOver) { setTimeout(settle, 0); return; } // after the current call's finally clears busy
        window.setupConfigurationLocked = true;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        if (VIEW.turn === USERSEAT) setPrompt('Your turn: tap the centre of the board to roll.');
        else { setPrompt(COLOR_OF[VIEW.turn] + ' is playing...'); setTimeout(rollCurrent, 800); }
    }

    async function rollCurrent() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relayRetry('demoRoll', { sessionId: SID });
            applyBoard(r.view);
            pendingDice = [r.dice1, r.dice2];
            window.currentTurnMoves = [r.dice1, r.dice2];
            window.isDiceRolled = true;
            if (ui().log) ui().log('Rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (on-chain dice, free)', 0);
            if (typeof window.showDiceTumble === 'function') window.showDiceTumble(r.dice1, r.dice2);
            setTimeout(afterDiceWindow, 3600);
        } catch (e) {
            if (isLostError(e)) { handleLost(e); return; }
            setPrompt('Roll failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    function afterDiceWindow() {
        window.displayDiceOnBoard = false;
        window.currentTurnMoves = pendingDice.slice();
        window.isDiceRolled = true;
        if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        if (VIEW.turn !== USERSEAT) {
            setTimeout(computerPlay, 700);
        } else if (!hasLegalMove(USERSEAT, pendingDice)) {
            setTimeout(passTurn, 900);
        } else {
            setPrompt('Your turn: tap a blinking token to move it.');
        }
    }

    async function userMove(tokenIndex) {
        if (busy || !VIEW || VIEW.turn !== USERSEAT) return;
        var seat = USERSEAT;
        var steps = VIEW.steps[seat * 4 + tokenIndex];
        var pick = -1;
        for (var d = 0; d < pendingDice.length; d++) {
            var val = pendingDice[d];
            if (steps < 0) { if (val === 6) { pick = d; break; } }
            else if (steps < 57 && steps + val <= 57) { pick = d; break; }
        }
        if (pick < 0) return;
        var die = pendingDice[pick];
        busy = true;
        try {
            var r = await relayRetry('demoMove', { sessionId: SID, seat: seat, tokenIndex: tokenIndex, value: die });
            pendingDice.splice(pick, 1);
            applyBoard(r.view);
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die + ' (free)', 0);
            if (pendingDice.length && hasLegalMove(seat, pendingDice)) {
                setPrompt('Tap another token to use your second dice, or press Pass.');
            } else {
                setTimeout(passTurn, 500);
            }
        } catch (e) {
            if (isLostError(e)) { handleLost(e); return; }
            setPrompt('Move rejected: ' + e.message);
        } finally {
            busy = false;
        }
    }

    // The computer's strategy, ported from GFG ludo-lab: prefer a capture, then
// release from the yard on a 6, then score into the centre, else advance the
// furthest piece. It re-evaluates after every move, so it coordinates tokens.
    function computerTokenFor(seat, value) {
        var base = seat * 4;
        // Strategy 1: capture (land on an opponent on the common track, off a safe box).
        var absOf = function (seatId, steps) { return (seatId * 13 + steps) % 52; };
        for (var i = 0; i < 4; i++) {
            var st = VIEW.steps[base + i];
            if (st < 0 || st >= 52) continue;
            var ne = st + value;
            if (ne > 57 || ne >= 52) continue; // stays on the common track
            var land = absOf(seat, ne);
            if (land % 13 === 0) continue; // safe start boxes
            for (var s2 = 0; s2 < VIEW.seatCount; s2++) {
                if (s2 === seat) continue;
                for (var t2 = 0; t2 < 4; t2++) {
                    var o = VIEW.steps[s2 * 4 + t2];
                    if (o >= 0 && o < 52 && absOf(s2, o) === land) return i;
                }
            }
        }
        // Strategy 2: on a 6, bring a yard token out.
        if (value === 6) {
            for (var j = 0; j < 4; j++) { if (VIEW.steps[base + j] < 0) return j; }
        }
        // Strategy 3: score a piece into the centre.
        for (var k = 0; k < 4; k++) {
            var sc = VIEW.steps[base + k];
            if (sc >= 0 && sc < 57 && sc + value === 57) return k;
        }
        // Strategy 4: advance the furthest movable piece.
        var best = -1, bestSteps = -1;
        for (var m = 0; m < 4; m++) {
            var sm = VIEW.steps[base + m];
            var movable = (sm < 0) ? (value === 6) : (sm < 57 && sm + value <= 57);
            if (movable && sm > bestSteps) { bestSteps = sm; best = m; }
        }
        return best;
    }

    async function computerPlay() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var seat = VIEW.turn;
            for (var d = 0; d < pendingDice.length; d++) {
                var val = pendingDice[d];
                var t = computerTokenFor(seat, val);
                if (t < 0) continue;
                var r = await relayRetry('demoMove', { sessionId: SID, seat: seat, tokenIndex: t, value: val });
                applyBoard(r.view);
            }
            setTimeout(passTurn, 500);
        } catch (e) {
            if (isLostError(e)) { handleLost(e); return; }
            setPrompt('Computer move failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relayRetry('demoPass', { sessionId: SID });
            pendingDice = [];
            window.currentTurnMoves = [];
            window.isDiceRolled = false;
            applyBoard(r.view);
            beginTurn();
        } catch (e) {
            if (isLostError(e)) { handleLost(e); return; }
            setPrompt('Pass failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function settle() {
        if (busy || !SID) return;
        busy = true;
        setPrompt('Match finished. Sealing the result on-chain...');
        try {
            // Phase 4: the user seat signs the final settle hash with its own
            // session key; the house seats are signed by the sponsor relay.
            var sig = null;
            try {
                var dg = await relay('demoDigest', { sessionId: SID });
                // Sign the RELAY's digest (the relay knows the active network) so
                // mainnet and testnet signatures always agree. ggiSignDigest signs
                // with the session key created at start.
                if (dg && dg.digest && typeof window.ggiSignDigest === 'function') sig = await window.ggiSignDigest(dg.digest);
                else if (dg && dg.digest && window.GGI_SDK && typeof window.GGI_SDK.signMove === 'function' && window.ggiSessionKey) sig = await window.GGI_SDK.signMove(window.ggiSessionKey, SID, dg.finalHash);
            } catch (e) { /* fall back to the relay signing the user seat */ }
            var r = await relayRetry('demoSettle', { sessionId: SID, sig: sig });
            if (ui().log) ui().log('GREEN: match committed on-chain, points credited', r.costUsdc6);
            if (ui().gas) ui().gas(r.costUsdc6, 'sealed');
            if (ui().tx) ui().tx(r.tx, 'settled');
            var winnerColor = null;
            if (VIEW && VIEW.order && VIEW.order.length) {
                var w = VIEW.order[0];
                winnerColor = COLOR_OF[w] != null ? COLOR_OF[w] : null;
            }
            var won = winnerColor === COLOR_OF[USERSEAT];
            var baseMsg = winnerColor
                ? (winnerColor.toUpperCase() + ': ' + (won ? 'you win the crown' : 'wins the crown, first place'))
                : 'match over';
            setPrompt('Sealed on-chain. ' + baseMsg + '.');
            if (ui().log) ui().log((winnerColor ? winnerColor.toUpperCase() + ': ' : '') + 'on-chain record sealed', 0);
            if (ui().onSettled) ui().onSettled(won, r.tx);
        } catch (e) {
            if (isLostError(e)) { handleLost(e); return; }
            setPrompt('Settle failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    // board.js's centre tap calls this for the roll control.
    window.rollDiceEngine = function () {
        if (!VIEW || VIEW.turn !== USERSEAT || window.isDiceRolled) return;
        rollCurrent();
    };

    function onCanvasClick(ev) {
        if (!VIEW || VIEW.turn !== USERSEAT || window.displayDiceOnBoard || busy) return;
        var canvas = document.getElementById('ludoCanvas');
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
        var y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
        var cell = canvas.width / 15;
        var col = Math.floor(x / cell), row = Math.floor(y / cell);
        for (var i = 0; i < 4; i++) {
            var steps = VIEW.steps[USERSEAT * 4 + i];
            var pos = steps < 0 ? HOME_YARDS[COLOR_OF[USERSEAT]][i] : tokenCR(USERSEAT, steps);
            if (!pos) continue;
            if (pos.c === col && pos.r === row) { userMove(i); return; }
        }
    }

    // Start a fresh match: connect on the rail + hand over the game (one step).
    async function start(seatCount, userSeat) {
        if (busy) return null;
        busy = true;
        VIEW = null; pendingDice = [];
        SEATS = seatCount; USERSEAT = userSeat;
        for (var s = 0; s < 4; s++) {
            var c = COLOR_OF[s];
            window.playerProfiles[c] = { mode: s === userSeat ? 'human' : 'computer', isUser: s === userSeat };
        }
        window.matchOver = false;
        window.displayDiceOnBoard = false;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        try {
            // Phase 4: the real player seat is the signed-in Dynamic EVM wallet.
            var evm = (typeof window.getDynamicEvmWallet === 'function') ? window.getDynamicEvmWallet() : null;
            if (!(window.currentUser || evm)) {
                setPrompt('Sign in to play. You get an embedded EVM wallet automatically.');
                if (typeof window.openDynamicLogin === 'function') window.openDynamicLogin();
                return null;
            }
            USER = evm || (window.currentUser && window.currentUser.evm) || null;
            // Use the published @foskaay/ggi-sdk the way an outside developer
            // would (loaded from the npm CDN), so the demo exercises the SDK.
            var sdk = window.GGI_SDK;
            if (!sdk && window.FoskaayGGI) {
                var Klass = window.FoskaayGGI.GgiClient || window.FoskaayGGI.default;
                if (Klass) { try { sdk = new Klass({ network: window.GGI_NETWORK || 'mainnet' }); } catch (e) {} }
            }
            window.GGI_SDK = sdk;
            var sk = null;
            if (sdk && typeof sdk.createSessionKey === 'function') sk = sdk.createSessionKey();
            else if (typeof window.ggiCreateSessionKey === 'function') sk = window.ggiCreateSessionKey();
            window.ggiSessionKey = sk;
            SESSION_KEY = sk ? sk.address : USER;
            var created = await relay('demoCreate', { seatCount: seatCount, userSeat: userSeat, user: USER, sessionKey: SESSION_KEY });
            SID = created.sessionId;
            applyBoard(created.view);
            if (ui().log) ui().log('Session connected on-chain (fee paid, one transaction)', created.costUsdc6);
            if (ui().gas) ui().gas(created.costUsdc6, 'connected');
            if (ui().ids) ui().ids(SID, '');
            if (ui().tx) ui().tx(created.connectTx, 'connected');
            beginTurn();
            return created;
        } catch (e) {
            setPrompt('Start failed: ' + e.message);
            return null;
        } finally {
            busy = false;
        }
    }

    // Keep the CSS-3D dice in sync on every redraw, and keep the blink loop alive
    // (that is what makes movable tokens and the centre die pulse).
    function wrapDraw() {
        if (typeof window.drawLudoLayout !== 'function') return;
        var orig = window.drawLudoLayout;
        window.drawLudoLayout = function () {
            try { orig(); } catch (e) {}
            if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
            if (typeof window.ensureBoardAnimationLoop === 'function') { try { window.ensureBoardAnimationLoop(); } catch (e) {} }
        };
    }

    window.GFG_LUDO = {
        start: start,
        rejoin: rejoin,
        pass: passTurn,
        settle: settle,
        userSeat: function () { return USERSEAT; },
        board: function () { return VIEW; },
        sessionId: function () { return SID; }
    };

    // REJOIN a live session from its own URL (?game=). Reconstruct the SAME board
    // from the relay and continue it (the session keeps its identity).
    async function rejoin(sessionId, wallet) {
        if (busy || !sessionId) return { ok: false, reason: 'no session' };
        busy = true;
        VIEW = null; pendingDice = [];
        try {
            var evm = wallet || ((typeof window.getDynamicEvmWallet === 'function') ? window.getDynamicEvmWallet() : null);
            if (!(window.currentUser || evm)) { setPrompt('Sign in to rejoin your session.'); return { ok: false, reason: 'not signed in' }; }
            var j = await relay('demoRejoin', { sessionId: sessionId, wallet: evm });
            if (!j.ok) { setPrompt(j.reason || 'Cannot rejoin this session.'); return { ok: false, reason: j.reason }; }
            SID = j.sessionId; SEATS = j.seatCount; USERSEAT = j.userSeat;
            for (var s = 0; s < 4; s++) {
                var c = COLOR_OF[s];
                window.playerProfiles[c] = { mode: s === j.userSeat ? 'human' : 'computer', isUser: s === j.userSeat };
            }
            window.matchOver = false; window.displayDiceOnBoard = false; window.isDiceRolled = false; window.currentTurnMoves = [];
            window.ggiSessionKey = (typeof window.ggiCreateSessionKey === 'function') ? window.ggiCreateSessionKey() : null;
            applyBoard(j.view);
            if (ui().ids) ui().ids(SID, j);
            if (ui().log) ui().log('Rejoined session ' + String(SID).slice(0, 10) + '...', 0);
            beginTurn();
            return { ok: true };
        } catch (e) {
            setPrompt('Rejoin failed: ' + e.message);
            return { ok: false, reason: e.message };
        } finally {
            busy = false;
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        wrapDraw();
        var canvas = document.getElementById('ludoCanvas');
        if (canvas) canvas.addEventListener('click', onCanvasClick);
    });
})();
