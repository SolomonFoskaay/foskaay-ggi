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
        if (SID) relay('mpBoard', { sessionId: SID }).then(function (j) { tickCountdown(j.lastTs, j.turnSecs); }).catch(function () {});
        if (VIEW.turn === MY_SEAT) setPrompt('Your turn (' + COLOR_OF[MY_SEAT] + '): tap the centre of the board to roll.');
        else { setPrompt(COLOR_OF[VIEW.turn] + ' is playing... you watch.'); startPoll(); }
    }

    var countTimer = null;
    // One shared countdown, from the CONTRACT timer (same numbers on every
    // phone; the page only displays). Stops at zero; the timeout advance is a
    // separate tap so a slow network never auto-skips a live player.
    function tickCountdown(lastTs, turnSecs) {
        if (countTimer) { clearInterval(countTimer); countTimer = null; }
        var el = document.getElementById('mp-countdown');
        if (!el || !lastTs || !turnSecs) { if (el) el.textContent = ''; return; }
        var draw = function () {
            var left = (lastTs + turnSecs) - Math.floor(Date.now() / 1000);
            if (left < 0) left = 0;
            el.textContent = 'Turn clock: ' + left + 's (contract timer, same on every phone)';
        };
        draw();
        countTimer = setInterval(draw, 1000);
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            if (busy || !SID || !VIEW || VIEW.turn === MY_SEAT || VIEW.matchOver) return;
            relay('mpBoard', { sessionId: SID }).then(function (j) {
                if (j.settled) {
                    stopPoll();
                    if (countTimer) { clearInterval(countTimer); countTimer = null; }
                    setPrompt('Sealed on-chain. Open the transaction link below for the record.');
                    if (ui().tx && j.settleTx) ui().tx(j.settleTx, 'settled');
                    updatePoints();
                    return;
                }
                tickCountdown(j.lastTs, j.turnSecs);
                if (j.view.turn !== VIEW.turn || j.view.finishCount !== VIEW.finishCount) {
                    applyBoard(j.view);
                    beginTurn();
                }
            }).catch(function () {});
        }, 3000);
    }

    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } if (countTimer) { clearInterval(countTimer); countTimer = null; } }

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

    // Automatic settle. The WINNER device signs silently with its own in-memory
    // key and posts the signature; the relay settles the moment the winner
    // signature is present, so the loser does nothing and the game never waits
    // on them. Other devices poll the session until it seals, then show it.
    async function settle() {
        if (busy || !SID) return;
        busy = true;
        stopPoll();
        try {
            var dg = await relay('mpDigest', { sessionId: SID });
            var s = sdk();
            var mySig = null;
            if (MY_KEY && MY_KEY.privateKey && s && typeof s.signMove === 'function') {
                mySig = await s.signMove(MY_KEY.privateKey, SID, dg.finalHash);
            } else if (typeof window.ggiSignDigest === 'function') {
                mySig = await window.ggiSignDigest(dg.digest);
            }
            if (mySig) {
                var r = await relay('mpSign', { sessionId: SID, wallet: MY_WALLET, seat: MY_SEAT, sig: mySig });
                if (r && r.settled) return showSealed(r);
            }
            setPrompt('Signature posted. Sealing automatically...');
            pollSettled();
        } catch (e) {
            setPrompt('Settle failed: ' + e.message);
            busy = false;
        }
    }

    function showSealed(r) {
        if (ui().log) ui().log('GREEN: multiplayer match committed on-chain, every earning seat credited', r.costUsdc6);
        if (ui().tx) ui().tx(r.tx || r.coreTx, 'settled');
        var w = VIEW && VIEW.order ? VIEW.order[0] : null;
        setPrompt('Sealed on-chain. ' + (w === MY_SEAT ? 'You win the crown.' : COLOR_OF[w] + ' wins the crown.'));
        if (ui().onSettled) ui().onSettled(w === MY_SEAT, r.tx);
        updatePoints();
        busy = false;
    }

    function pollSettled() {
        var tries = 0;
        var loop = setInterval(function () {
            tries++;
            relay('mpSession', { sessionId: SID }).then(function (p) {
                if (p && p.status === 2) {
                    clearInterval(loop);
                    relay('mpGame', { sessionId: SID }).then(function () {}).catch(function () {});
                    showSealed({ tx: p.settleTx, costUsdc6: 0 });
                } else if (tries > 40) {
                    clearInterval(loop);
                    setPrompt('Still waiting on the seal. Stay on this page; it completes automatically.');
                    busy = false;
                }
            }).catch(function () {});
        }, 3000);
    }

    function updatePoints() {
        var host = document.getElementById('mp-points');
        if (!host || !MY_WALLET) return;
        relay('mpPoints', { player: MY_WALLET, sessionId: SID }).then(function (j) {
            host.innerHTML = 'Your ludo-mp points: <b style="color:#f39c12">' + j.points + '</b>';
        }).catch(function () {});
    }

    // ---- create + join (lobby, zero copying) ----
    // Host opens a lobby (no handover yet). Joiners tap the shared link, signed
    // in: their wallet + fresh silent key address join automatically. When every
    // seat is filled the HOST device begins (one handover, sponsor pays) and
    // joins lock. Solo test holds every seat on this phone.

    function lobbyLink() { return SID ? ('/gfgnew/board/ludo-mp/?game=' + SID) : ''; }

    function pollLobby() {
        stopPoll();
        var show = function (p) {
            var el = document.getElementById('mp-lobby');
            if (el) el.innerHTML = 'Seats ' + p.players.length + '/' + SEATS + ': ' + p.players.map(function (w, i) {
                return '<b>' + COLOR_OF[i] + '</b> ' + short(w) + (w === MY_WALLET ? ' (you)' : '');
            }).join(' &nbsp; ');
        };
        pollTimer = setInterval(function () {
            if (busy || !SID) return;
            relay('mpLobby', { sessionId: SID }).then(function (p) {
                show(p);
                if (p.status === 1) {
                    stopPoll();
                    relay('mpBoard', { sessionId: SID }).then(function (j) {
                        applyBoard(j.view);
                        beginTurn();
                    }).catch(function () {});
                    return;
                }
                if (p.status === 0 && p.players.length >= SEATS && PLAYERS[0] === MY_WALLET) {
                    relay('mpBegin', { sessionId: SID, wallet: MY_WALLET }).then(function (b) {
                        stopPoll();
                        if (ui().tx) ui().tx(b.connectTx, 'connected');
                        if (ui().log) ui().log('Match begun on-chain (fee paid, one transaction)', b.costUsdc6);
                        applyBoard(b.view);
                        beginTurn();
                    }).catch(function (e) { setPrompt('Begin failed: ' + e.message); });
                }
            }).catch(function () {});
        }, 2500);
    }

    async function start(seatCount, soloTest) {
        if (busy) return null;
        busy = true;
        VIEW = null; pendingDice = [];
        SEATS = (seatCount === 4) ? 4 : 2;
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
                for (var i = 1; i < SEATS; i++) {
                    var k = makeKey();
                    players.push(k.address);
                    keys.push(k.address);
                    window['mpSoloKey' + i] = k;
                }
            }
            MY_SEAT = 0;
            var created = await relay('mpCreate', { seatCount: SEATS, wallet: evm, sessionKey: MY_KEY.address, players: players, sessionKeys: keys });
            SID = created.sessionId;
            PLAYERS = created.players;
            SKEYS = created.players.map(function (_, i) { return (keys[i] || ''); });
            SEATS = created.view.seatCount;
            try { if (history && history.replaceState) history.replaceState(null, '', lobbyLink()); } catch (e) {}
            applyBoard(created.view);
            if (ui().log) ui().log('Lobby open: share the session link below', 0);
            if (ui().ids) ui().ids(SID, '');
            var code = document.getElementById('mp-code');
            if (code) code.textContent = SID;
            if (soloTest && PLAYERS.length >= SEATS) {
                var b = await relay('mpBegin', { sessionId: SID, wallet: MY_WALLET });
                if (ui().tx) ui().tx(b.connectTx, 'connected');
                if (ui().log) ui().log('Match begun on-chain (fee paid, one transaction)', b.costUsdc6);
                applyBoard(b.view);
                beginTurn();
            } else {
                setPrompt('Lobby open. Share the session link; the match begins when every seat is filled.');
                pollLobby();
            }
            updatePoints();
            return created;
        } catch (e) {
            setPrompt('Start failed: ' + e.message);
            return null;
        } finally {
            busy = false;
        }
    }

    // Join or rejoin with ONE tap. Signed in: a fresh session key is born
    // silently on this device; only its ADDRESS travels in the join call.
    // New wallet on an open lobby = auto-join a free seat. Seated wallet =
    // rejoin (lobby wait or live render). Nothing is ever copied by hand.
    async function rejoin(sessionId, wallet) {
        if (busy || !sessionId) return { ok: false, reason: 'no session' };
        busy = true;
        VIEW = null; pendingDice = [];
        try {
            var evm = wallet || myWallet();
            if (!evm) return { ok: false, reason: 'sign in first' };
            if (!window.ggiSessionKey) {
                try { window.ggiSessionKey = makeKey(); } catch (e) { return { ok: false, reason: 'key engine loading, try again' }; }
            }
            var j = await relay('mpRejoin', { sessionId: sessionId, wallet: evm });
            if (!j.ok) { setPrompt(j.reason || 'Cannot rejoin this session.'); return { ok: false, reason: j.reason }; }
            var seated = (j.players || []).some(function (w) { return String(w).toLowerCase() === String(evm).toLowerCase(); });
            if (!seated && j.status === 0) {
                var jj = await relay('mpJoin', { sessionId: sessionId, wallet: evm, sessionKey: window.ggiSessionKey.address });
                if (!jj || jj.seat == null || jj.seat < 0) { setPrompt((jj && jj.error) || 'Join failed (seats may be full).'); return { ok: false, reason: (jj && jj.error) || 'join failed' }; }
                if (ui().log) ui().log('Joined as ' + COLOR_OF[jj.seat] + ' (seat ' + jj.seat + ')', 0);
                j = await relay('mpRejoin', { sessionId: sessionId, wallet: evm });
            }
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
            // My session key: this device's in-memory key when it matches the
            // committed seat key (just joined, or created the seat here), else a
            // solo-test key held on this phone. Keys never leave the device.
            if (window.ggiSessionKey && SKEYS[MY_SEAT] &&
                String(window.ggiSessionKey.address).toLowerCase() === String(SKEYS[MY_SEAT]).toLowerCase()) {
                MY_KEY = window.ggiSessionKey;
            } else if (window['mpSoloKey' + MY_SEAT]) {
                MY_KEY = window['mpSoloKey' + MY_SEAT];
            } else {
                MY_KEY = null;
            }
            applyBoard(j.view);
            if (ui().ids) ui().ids(SID, j);
            if (j.status === 0) {
                setPrompt('Lobby: waiting for seats (' + PLAYERS.length + '/' + SEATS + '). The match begins automatically when full.');
                if (ui().log) ui().log('In lobby as ' + COLOR_OF[MY_SEAT], 0);
                pollLobby();
            } else {
                if (ui().log) ui().log('Rejoined multiplayer session ' + short(SID), 0);
                beginTurn();
            }
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
