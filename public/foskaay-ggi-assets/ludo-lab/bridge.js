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
            var r = await relay('demoRoll', { sessionId: SID });
            applyBoard(r.view);
            pendingDice = [r.dice1, r.dice2];
            window.currentTurnMoves = [r.dice1, r.dice2];
            window.isDiceRolled = true;
            if (ui().log) ui().log('Rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (on-chain dice, free)', 0);
            if (typeof window.showDiceTumble === 'function') window.showDiceTumble(r.dice1, r.dice2);
            setTimeout(afterDiceWindow, 3600);
        } catch (e) {
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
            var r = await relay('demoMove', { sessionId: SID, seat: seat, tokenIndex: tokenIndex, value: die });
            pendingDice.splice(pick, 1);
            applyBoard(r.view);
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die + ' (free)', 0);
            if (pendingDice.length && hasLegalMove(seat, pendingDice)) {
                setPrompt('Tap another token to use your second dice, or press Pass.');
            } else {
                setTimeout(passTurn, 500);
            }
        } catch (e) {
            setPrompt('Move rejected: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function computerPlay() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var seat = VIEW.turn;
            for (var d = 0; d < pendingDice.length; d++) {
                var val = pendingDice[d];
                var t = -1;
                for (var i = 0; i < 4; i++) {
                    var s = VIEW.steps[seat * 4 + i];
                    if (s < 0) { if (val === 6) { t = i; break; } }
                    else if (s < 57 && s + val <= 57) { t = i; break; }
                }
                if (t < 0) continue;
                var r = await relay('demoMove', { sessionId: SID, seat: seat, tokenIndex: t, value: val });
                applyBoard(r.view);
            }
            setTimeout(passTurn, 500);
        } catch (e) {
            setPrompt('Computer move failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relay('demoPass', { sessionId: SID });
            pendingDice = [];
            window.currentTurnMoves = [];
            window.isDiceRolled = false;
            applyBoard(r.view);
            beginTurn();
        } catch (e) {
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
                if (dg && dg.digest && window.GGI_SDK && typeof window.GGI_SDK.signMove === 'function' && window.ggiSessionKey) sig = await window.GGI_SDK.signMove(window.ggiSessionKey, SID, dg.finalHash);
                else if (dg && dg.digest && typeof window.ggiSignDigest === 'function') sig = await window.ggiSignDigest(dg.digest);
            } catch (e) { /* fall back to the relay signing the user seat */ }
            var r = await relay('demoSettle', { sessionId: SID, sig: sig });
            if (ui().log) ui().log('Settled on-chain: result sealed', r.costUsdc6);
            if (ui().gas) ui().gas(r.costUsdc6, 'sealed');
            if (ui().tx) ui().tx(r.tx, 'settled');
            var won = VIEW.order && VIEW.order[0] === USERSEAT;
            setPrompt(won ? 'Sealed. You won the crown.' : 'Sealed. The match is over.');
            if (ui().onSettled) ui().onSettled(won, r.tx);
        } catch (e) {
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
                if (Klass) { try { sdk = new Klass({ network: 'testnet' }); } catch (e) {} }
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
        pass: passTurn,
        settle: settle,
        userSeat: function () { return USERSEAT; },
        board: function () { return VIEW; },
        sessionId: function () { return SID; }
    };

    document.addEventListener('DOMContentLoaded', function () {
        wrapDraw();
        var canvas = document.getElementById('ludoCanvas');
        if (canvas) canvas.addEventListener('click', onCanvasClick);
    });
})();
