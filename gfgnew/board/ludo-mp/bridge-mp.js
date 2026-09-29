// ludo-mp bridge (gfgnew/board/ludo-mp).
//
// Connects the shared ludo-lab board skin to the multiplayer midchain.
// TRUTH RULES (never centralized here):
//   - GFGGames + GFGPlayers are the ONLY source of truth. This file keeps no
//     game state of its own; every number drawn comes from a relay view that
//     itself came from the contracts' pure rules, or from a verified move log.
//   - Every relay view is drawn as-is; rejoin verifies the signed move log
//     client-side (continuity + signatures + on-chain anchors) BEFORE drawing.
//   - The relay executes moves (sponsor-signed log, same as the single-player
//     demo) but CANNOT settle: mpSettle needs every seat's own session-key
//     signature, and the relay holds none of them. A fake result cannot settle.
//   - Seat gate: the relay only acts for the wallet that owns the acting seat.
//   - Nothing here writes to Arc directly; only the sponsor relay transacts
//     (handover + settle), paid from the Vercel env key the browser never sees.
(function () {
    'use strict';

    var RELAY = '/api/foskaay-ggi-sponsor';
    var COLOR_OF = ['green', 'yellow', 'blue', 'red'];
    var SEAT_OF = { green: 0, yellow: 1, blue: 2, red: 3 };

    var SID = null, MY_WALLET = null, MY_KEY = null, MY_SEAT = -1, SEATS = 2;
    var VIEW = null, PLAYERS = [], SKEYS = [];
    var pendingDice = [];
    var busy = false, pollTimer = null;

    window.currentTurn = 'green';
    window.playerProfiles = {
        green: { mode: 'human', isUser: false },
        yellow: { mode: 'human', isUser: false },
        blue: { mode: 'human', isUser: false },
        red: { mode: 'human', isUser: false }
    };
    window.displayDiceOnBoard = false;
    window.isDiceRolled = false;
    window.currentTurnMoves = [];
    window.setupConfigurationLocked = false;
    window.matchOver = false;
    window.isGamePaused = false;
    window.isChainDown = false;
    window.gfgRemoteTurn = function () { return VIEW ? VIEW.turn !== MY_SEAT : false; };
    window.getActiveSeats = function () { return COLOR_OF.slice(0, SEATS); };
    window.getPlayerRank = function (color) {
        if (!VIEW || !VIEW.order) return 0;
        var fc = VIEW.finishCount || 0;
        for (var i = 0; i < fc; i++) {
            if (VIEW.order[i] === SEAT_OF[color]) return i + 1;
        }
        return 0;
    };
    window.finalizeDiceScores = function () {};

    function ui() { return window.gfgLudoUI || {}; }
    function setPrompt(s) { if (ui().prompt) ui().prompt(s); }
    function short(h) { return h ? (h.slice(0, 10) + '...' + h.slice(-6)) : ''; }

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

    function myWallet() {
        return (typeof window.getDynamicEvmWallet === 'function') ? window.getDynamicEvmWallet() : null;
    }

    function sdk() {
        if (window.GGI_SDK && typeof window.GGI_SDK.createSessionKey === 'function') return window.GGI_SDK;
        if (window.FoskaayGGI) {
            var Klass = window.FoskaayGGI.GgiClient || window.FoskaayGGI.default;
            if (Klass) { try { return new Klass({ network: 'testnet' }); } catch (e) {} }
        }
        return null;
    }

    function makeKey() {
        var s = sdk();
        if (s) return s.createSessionKey();
        if (typeof window.ggiCreateSessionKey === 'function') return window.ggiCreateSessionKey();
        throw new Error('session-key SDK not loaded yet');
    }

    // ---- board painting (contract bytes in, pixels out) ----

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
        for (var p = 0; p < 4; p++) {
            var c = COLOR_OF[p];
            window.playerProfiles[c] = { mode: 'human', isUser: p === MY_SEAT };
        }
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

    // ---- turn flow (my seat only; relay rejects anyone else) ----

    function beginTurn() {
        if (!VIEW) return;
        if (VIEW.matchOver) { setTimeout(settle, 0); return; }
        window.setupConfigurationLocked = true;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        stopPoll();
        if (VIEW.turn === MY_SEAT) setPrompt('Your turn (' + COLOR_OF[MY_SEAT] + '): tap the centre of the board to roll.');
        else { setPrompt(COLOR_OF[VIEW.turn] + ' is playing... you watch.'); startPoll(); }
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            if (busy || !SID || !VIEW || VIEW.turn === MY_SEAT || VIEW.matchOver) return;
            relay('mpBoard', { sessionId: SID }).then(function (j) {
                if (j.view.turn !== VIEW.turn || j.view.finishCount !== VIEW.finishCount) {
                    applyBoard(j.view);
                    beginTurn();
                }
            }).catch(function () {});
        }, 3000);
    }

    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    async function rollCurrent() {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        busy = true;
        try {
            var r = await relay('mpRoll', { sessionId: SID, wallet: MY_WALLET });
            applyBoard(r.view);
            pendingDice = [r.dice1, r.dice2];
            window.currentTurnMoves = [r.dice1, r.dice2];
            window.isDiceRolled = true;
            if (ui().log) ui().log('You rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (on-chain dice, free)', 0);
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
        if (!hasLegalMove(MY_SEAT, pendingDice)) setTimeout(passTurn, 900);
        else setPrompt('Your turn: tap a blinking token to move it.');
    }

    async function userMove(tokenIndex) {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        var steps = VIEW.steps[MY_SEAT * 4 + tokenIndex];
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
            var r = await relay('mpMove', { sessionId: SID, wallet: MY_WALLET, seat: MY_SEAT, tokenIndex: tokenIndex, value: die });
            pendingDice.splice(pick, 1);
            applyBoard(r.view);
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die + ' (free)', 0);
            if (pendingDice.length && hasLegalMove(MY_SEAT, pendingDice)) setPrompt('Tap another token for your second dice, or Pass.');
            else setTimeout(passTurn, 500);
        } catch (e) {
            setPrompt('Move rejected: ' + e.message);
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relay('mpPass', { sessionId: SID, wallet: MY_WALLET });
            pendingDice = [];
            window.currentTurnMoves = [];
            window.isDiceRolled = false;
            applyBoard(r.view);
            beginTurn();
        } catch (e) {
            // Not my seat (opponent already moved on): just refresh.
            try {
                var j = await relay('mpBoard', { sessionId: SID });
                applyBoard(j.view);
                beginTurn();
            } catch (e2) { setPrompt('Pass failed: ' + e.message); }
        } finally {
            busy = false;
        }
    }

    async function timeoutSeat() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relay('mpPass', { sessionId: SID, wallet: MY_WALLET, timeout: true });
            applyBoard(r.view);
            beginTurn();
        } catch (e) {
            // Anyone may advance a stalled seat; if the gate refuses, refresh.
            try {
                var j = await relay('mpBoard', { sessionId: SID });
                applyBoard(j.view);
                beginTurn();
            } catch (e2) { setPrompt('Timeout failed: ' + e.message); }
        } finally {
            busy = false;
        }
    }

    async function settle() {
        if (busy || !SID) return;
        busy = true;
        stopPoll();
        setPrompt('Match finished. Collecting every seat signature, then sealing on-chain...');
        try {
            var dg = await relay('mpDigest', { sessionId: SID });
            var s = sdk();
            var mySig = null;
            if (MY_KEY && MY_KEY.privateKey && s && typeof s.signMove === 'function') {
                mySig = await s.signMove(MY_KEY.privateKey, SID, dg.finalHash);
            } else if (typeof window.ggiSignDigest === 'function') {
                mySig = await window.ggiSignDigest(dg.digest);
            }
            if (!mySig) throw new Error('could not sign (session key missing)');
            var others = [];
            try {
                var raw = (document.getElementById('mp-sigs') || {}).value || '';
                others = raw.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
            } catch (e) {}
            var sigs = new Array(SEATS).fill(null);
            sigs[MY_SEAT] = mySig;
            var oi = 0;
            for (var i = 0; i < SEATS; i++) {
                if (sigs[i] == null) { sigs[i] = others[oi] || null; oi++; }
            }
            if (sigs.some(function (x) { return !x; })) {
                setPrompt('Your signature is ready (copied below). Waiting on ' + sigs.filter(function (x) { return !x; }).length + ' more seat(s): paste their signatures and press Settle again.');
                if (ui().log) ui().log('My seat signature: <b>' + short(mySig) + '</b> (full value in the box)', 0);
                var box = document.getElementById('mp-mysig');
                if (box) box.textContent = mySig;
                busy = false;
                return;
            }
            var r = await relay('mpSettle', { sessionId: SID, sigs: sigs });
            if (ui().log) ui().log('GREEN: multiplayer match committed on-chain, every earning seat credited', r.costUsdc6);
            if (ui().tx) { ui().tx(r.tx, 'settled'); }
            var w = VIEW && VIEW.order ? VIEW.order[0] : null;
            setPrompt('Sealed on-chain. ' + (w === MY_SEAT ? 'You win the crown.' : COLOR_OF[w] + ' wins the crown.'));
            if (ui().onSettled) ui().onSettled(w === MY_SEAT, r.tx);
            updatePoints();
        } catch (e) {
            setPrompt('Settle failed: ' + e.message);
        } finally {
            busy = false;
        }
    }

    function updatePoints() {
        var host = document.getElementById('mp-points');
        if (!host || !MY_WALLET) return;
        relay('mpPoints', { player: MY_WALLET, sessionId: SID }).then(function (j) {
            host.innerHTML = 'Your ludo-mp points: <b style="color:#f39c12">' + j.points + '</b>';
        }).catch(function () {});
    }

    // ---- create + join ----

    async function start(seatCount, opponents, soloTest) {
        if (busy) return null;
        busy = true;
        VIEW = null; pendingDice = [];
        try {
            var evm = myWallet();
            if (!evm) {
                setPrompt('Sign in to play. You get an embedded EVM wallet automatically.');
                if (typeof window.openDynamicLogin === 'function') window.openDynamicLogin();
                return null;
            }
            MY_WALLET = evm;
            MY_KEY = makeKey();
            window.ggiSessionKey = MY_KEY;
            var s = sdk();
            if (s) window.GGI_SDK = s;
            var players = [evm];
            var keys = [MY_KEY.address];
            if (soloTest) {
                for (var i = 1; i < seatCount; i++) {
                    var k = makeKey();
                    players.push(k.address);
                    keys.push(k.address);
                    window['mpSoloKey' + i] = k;
                }
                MY_SEAT = 0;
            } else {
                if (!opponents || opponents.length !== seatCount - 1) throw new Error('paste every opponent wallet first');
                for (var o = 0; o < opponents.length; o++) {
                    if (!opponents[o].wallet || !opponents[o].key) throw new Error('opponent ' + (o + 2) + ' needs wallet + session key');
                    players.push(opponents[o].wallet);
                    keys.push(opponents[o].key);
                }
                MY_SEAT = 0;
            }
            var created = await relay('mpCreate', { seatCount: seatCount, players: players, sessionKeys: keys });
            SID = created.sessionId;
            PLAYERS = players;
            SKEYS = keys;
            SEATS = seatCount;
            try { if (history && history.replaceState) history.replaceState(null, '', '/gfgnew/board/ludo-mp/?game=' + SID); } catch (e) {}
            applyBoard(created.view);
            if (ui().log) ui().log('Multiplayer session connected on-chain (fee paid, one transaction)', created.costUsdc6);
            if (ui().ids) ui().ids(SID, '');
            if (ui().tx) ui().tx(created.connectTx, 'connected');
            var code = document.getElementById('mp-code');
            if (code) code.textContent = SID;
            beginTurn();
            updatePoints();
            return created;
        } catch (e) {
            setPrompt('Start failed: ' + e.message);
            return null;
        } finally {
            busy = false;
        }
    }

    async function rejoin(sessionId, wallet) {
        if (busy || !sessionId) return { ok: false, reason: 'no session' };
        busy = true;
        VIEW = null; pendingDice = [];
        try {
            var evm = wallet || myWallet();
            if (!evm) return { ok: false, reason: 'sign in first' };
            var j = await relay('mpRejoin', { sessionId: sessionId, wallet: evm });
            if (!j.ok) { setPrompt(j.reason || 'Cannot rejoin this session.'); return { ok: false, reason: j.reason }; }
            // VERIFY BEFORE DRAW: the relay is an untrusted cache. A tampered
            // log is never rendered.
            if (j.moves && j.moves.length) {
                var s = sdk();
                if (s && typeof s.verifyMoveLog === 'function') {
                    var vr = await s.verifyMoveLog(sessionId, {
                        startHash: j.startHash, moves: j.moves, sessionKeys: j.sessionKeys || [],
                        sponsorAddress: j.sponsorAddress, finalHash: j.finalHash, settled: j.settled
                    });
                    if (!vr.valid) {
                        setPrompt('Rejoin blocked: tampered midchain log (' + vr.reason + ').');
                        if (ui().log) ui().log('MIDCHAIN VERIFY FAILED: ' + vr.reason, 0);
                        return { ok: false, reason: 'verification failed: ' + vr.reason };
                    }
                    if (ui().log) ui().log('Midchain verified: ' + vr.checked + ' signed moves match the on-chain anchors', 0);
                }
            }
            SID = j.sessionId;
            SEATS = j.seatCount;
            PLAYERS = j.players || [];
            SKEYS = j.sessionKeys || [];
            MY_WALLET = evm;
            MY_SEAT = -1;
            for (var i = 0; i < PLAYERS.length; i++) {
                if (String(PLAYERS[i]).toLowerCase() === String(evm).toLowerCase()) MY_SEAT = i;
            }
            if (MY_SEAT < 0) return { ok: false, reason: 'your wallet is not a seat in this match' };
            // My session key: reuse the stored one if this device created it,
            // else the key for this seat must already be mine (solo test) or I
            // hold only my address and sign settle with a fresh key? No: settle
            // must use the committed key. Ask for the key when unknown.
            if (window.ggiSessionKey && SKEYS[MY_SEAT] &&
                String(window.ggiSessionKey.address).toLowerCase() === String(SKEYS[MY_SEAT]).toLowerCase()) {
                MY_KEY = window.ggiSessionKey;
            } else if (window['mpSoloKey' + MY_SEAT]) {
                MY_KEY = window['mpSoloKey' + MY_SEAT];
            } else {
                setPrompt('Joined as ' + COLOR_OF[MY_SEAT] + '. If this device created your seat key, it is ready; otherwise settle signing needs that key.');
                MY_KEY = window.ggiSessionKey || null;
            }
            applyBoard(j.view);
            if (ui().ids) ui().ids(SID, j);
            if (ui().log) ui().log('Rejoined multiplayer session ' + short(SID), 0);
            beginTurn();
            updatePoints();
            return { ok: true };
        } catch (e) {
            setPrompt('Rejoin failed: ' + e.message);
            return { ok: false, reason: e.message };
        } finally {
            busy = false;
        }
    }

    window.rollDiceEngine = function () {
        if (!VIEW || VIEW.turn !== MY_SEAT || window.isDiceRolled) return;
        rollCurrent();
    };

    function onCanvasClick(ev) {
        if (!VIEW || VIEW.turn !== MY_SEAT || window.displayDiceOnBoard || busy) return;
        var canvas = document.getElementById('ludoCanvas');
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
        var y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
        var cell = canvas.width / 15;
        var col = Math.floor(x / cell), row = Math.floor(y / cell);
        for (var i = 0; i < 4; i++) {
            var steps = VIEW.steps[MY_SEAT * 4 + i];
            var pos = steps < 0 ? HOME_YARDS[COLOR_OF[MY_SEAT]][i] : tokenCR(MY_SEAT, steps);
            if (!pos) continue;
            if (pos.c === col && pos.r === row) { userMove(i); return; }
        }
    }

    function wrapDraw() {
        if (typeof window.drawLudoLayout !== 'function') return;
        var orig = window.drawLudoLayout;
        window.drawLudoLayout = function () {
            try { orig(); } catch (e) {}
            if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
            if (typeof window.ensureBoardAnimationLoop === 'function') { try { window.ensureBoardAnimationLoop(); } catch (e) {} }
        };
    }

    window.GFG_MP = {
        start: start,
        rejoin: rejoin,
        pass: passTurn,
        timeout: timeoutSeat,
        settle: settle,
        mySeat: function () { return MY_SEAT; },
        myKeyAddress: function () { return MY_KEY ? MY_KEY.address : null; },
        board: function () { return VIEW; },
        sessionId: function () { return SID; }
    };

    document.addEventListener('DOMContentLoaded', function () {
        wrapDraw();
        var canvas = document.getElementById('ludoCanvas');
        if (canvas) canvas.addEventListener('click', onCanvasClick);
    });
})();
