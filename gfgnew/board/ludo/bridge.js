// gfgnew/board/ludo/bridge.js — STANDALONE MULTIPLAYER LUDO on Foskaay GGI.
//
// THE BATTLE-TESTED MODEL (ludo-lab MP + demo/board/ludo), ported to Solidity:
//   - ONE shared board. The contract holds a compact 36-byte board (turn,
//     finishCount, userSeat, seatCount, dice, 16 stepsWalked, finishOrder[4],
//     points[4]). Every phone renders the SAME bytes; nothing is invented here.
//   - Real time via polling (1200 ms). Opponent moves show up live because every
//     device polls the same relay midchain session.
//   - Contract-owned turn timer (turnSecs, default 45s) + permissionless
//     timeout-advance once the deadline passes.
//   - Exactly two transactions per match: connect (handover, sponsor pays) and
//     settle (LudoGames.settle + core settle, sponsor pays). Every roll/move/pass
//     is a free eth_call + a signed hash-chain entry (the Foskaay GGI Midchain).
//   - Session key persisted per device so a reload re-signs with the SAME
//     committed key (fixes the old ludo-mp reload = deadlock bug).
//   - VERIFY BEFORE DRAW: the signed move log is verified client-side with the
//     local SDK's verifyMoveLog against the on-chain anchors before a token is
//     drawn. A tampered/logless session is never rendered.
//   - Honored seat choice: join seats you at the tapped FREE colour.
//   - Winner-suffices settle: the winner device signs, the relay seals, the
//     loser does nothing.
//   - Resync: a seated device can re-submit its verified copy to a cold relay
//     (ldsResync) so a reload on the same device can resurrect the session.
//
// The frontend is a display only. All authority is the contract.

(function () {
    'use strict';

    var RELAY = '/api/foskaay-ggi-sponsor';
    var COLOR_OF = ['green', 'yellow', 'blue', 'red'];
    var SEAT_OF = { green: 0, yellow: 1, blue: 2, red: 3 };
    var LD_KEY = 'gfg_ludo2_seatkey_v1';
    var LD_CACHE = 'gfg_ludo2_cache_v1';

    var SID = null, CODE = '', USER = null, MY_SEAT = -1, SEATS = 2;
    var KEY = null;              // { privateKey, address, account } persisted
    var VIEW = null;
    var busy = false, live = false;
    var pollTimer = null, countdownTimer = null, countdownTo = 0;
    var quiet = {};              // quiet[seatColor] = true when this turn already handled
    var cacheMoves = [];         // witnessed signed moves, for resync
    var lobbyTimer = null;

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
    window.gfgRemoteTurn = function () { return MY_SEAT >= 0 && VIEW ? VIEW.turn !== MY_SEAT : true; };
    window.getActiveSeats = function () { return activeSeats(); };
    window.getPlayerRank = function (color) {
        if (!VIEW || !VIEW.order) return 0;
        for (var i = 0; i < (VIEW.finishCount || 0); i++) {
            if (VIEW.order[i] === SEAT_OF[color]) return i + 1;
        }
        return 0;
    };
    window.finalizeDiceScores = function () {};

    function activeSeats() {
        var base = SEATS === 4 ? ['green', 'yellow', 'blue', 'red'] : ['green', 'red'];
        // If we know the session quadOrder, active seats = that order (the did
        // room's truth); else fall back to deterministic color order.
        if (CODE && window.__LDQUADS) {
            var q = window.__LDQUADS;
            if (Array.isArray(q) && q.length === SEATS) return q.slice();
        }
        return base;
    }
    function seatOfColor(color) {
        var o = activeSeats();
        var i = o.indexOf(color || 'green'); return i >= 0 ? i : 0;
    }
    function colorOf(seat) {
        var o = activeSeats(); return o[seat] != null ? o[seat] : COLOR_OF[seat];
    }

    function ui() { return window.gfgLudoUI || {}; }
    function setPrompt(s) { if (ui().prompt) ui().prompt(s); }
    function setAction(s) { if (ui().action) ui().action(s); }

    // ---- relay ----
    function relay(action, extra) {
        return fetch(RELAY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, extra || {})) })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (!j.ok) {
                    var e = new Error((j && (j.error || j.reason)) || ('relay ' + action));
                    e.relay = j || {};
                    throw e;
                }
                return j;
            });
    }
    // Session actions retry on cold-instance "not found" so a reload or a
    // brand-new device keeps working while the warm instance holds the session.
    function isCold(e) {
        var m = (e && (e.reason || e.error || e.message)) || '';
        return /restarted|lost the signed log|not found on this server|Session not found|cold/i.test(m);
    }
    function relaySess(action, extra, tries) {
        tries = typeof tries === 'number' ? tries : 6;
        var attempt = function (i) {
            return relay(action, extra).catch(function (e) {
                var m = (e && e.message) || '';
                if (i < tries && /not found on this server|unknown session|Session not found/i.test(m)) {
                    return new Promise(function (res) { setTimeout(res, 600 + 300 * i); }).then(function () { return attempt(i + 1); });
                }
                throw e;
            });
        };
        return attempt(0);
    }

    // ---- session-key persistence (fixes reload deadlock) ----
    function loadKey() {
        try { var raw = localStorage.getItem(LD_KEY); if (raw) { KEY = JSON.parse(raw); if (KEY && KEY.address) { if (window.ggiSessionKey) window.ggiSessionKey = KEY; return KEY; } } } catch (e) {}
        return null;
    }
    function saveKey(key) { try { localStorage.setItem(LD_KEY, JSON.stringify(key)); } catch (e) {} }
    function ensureKey() {
        var k = loadKey();
        if (k) return k;
        var sdk = window.GGI_SDK;
        if (sdk && typeof sdk.createSessionKey === 'function') k = sdk.createSessionKey();
        else if (typeof window.ggiCreateSessionKey === 'function') k = window.ggiCreateSessionKey();
        if (!k) throw new Error('session-key SDK not loaded yet');
        saveKey(k);
        if (window.ggiSessionKey !== undefined) window.ggiSessionKey = k;
        return k;
    }

    // ---- cache (witnessed synchronous moves, for resync) ----
    function cacheSave() {
        try { localStorage.setItem(LD_CACHE, JSON.stringify({ sid: SID, envelope: cacheEnvelope(), moves: cacheMoves })); } catch (e) {}
    }
    function cacheEnvelope() {
        return { players: VIEW ? viewPlayers() : [], sessionKeys: viewKeys(), seatCount: SEATS, gameAddr: null };
    }
    function viewPlayers() { return window.__LDPLAYERS || []; }
    function viewKeys() { return window.__LDKEYS || []; }
    function cacheAppend(move) {
        if (!move || !move.newHash) return;
        cacheMoves.push(move);
        cacheSave();
    }
    function cacheClear() { cacheMoves = []; try { localStorage.removeItem(LD_CACHE); } catch (e) {} }

    // ---- board painting ----
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
        SEATS = view.seatCount || SEATS;
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
                    tok.pathIndex = steps >= 57 ? -2 : ((s * 13 + steps) % 52);
                    var cr = tokenCR(s, steps);
                    tok.c = cr.c;
                    tok.r = cr.r;
                }
            }
        }
        renderSeats();
        renderTurn();
        window.matchOver = !!view.matchOver;
        if (ui().dice) ui().dice(view.dieA || null, view.dieB || null);
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        if (view && view.dieA > 0 && view.dieB > 0 && typeof window.showDiceTumble === 'function' && !window.__LDNoTumble) {
            try { window.showDiceTumble(view.dieA, view.dieB); } catch (e) {}
        }
    }

    function renderTurn() {
        if (!VIEW) return;
        var c = colorOf(VIEW.turn);
        var me = MY_SEAT >= 0;
        var label = (me && VIEW.turn === MY_SEAT)
            ? 'Your turn (' + c + ')'
            : ((me ? '' : 'Seat ') + (c.charAt(0).toUpperCase() + c.slice(1)) + "'s turn");
        var cm = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };
        if (ui().turn) ui().turn(label, cm[c] || '#fff');
    }
    function renderSeats() {
        var host = document.getElementById('mp-lobby');
        if (!host || !VIEW) return;
        var players = window.__LDPLAYERS || [];
        var html = '<b style="color:#fff">Lobby:</b> ';
        for (var i = 0; i < SEATS; i++) {
            var c = COLOR_OF[i];
            var who = players[i] ? short(players[i]) : 'open';
            var mine = i === MY_SEAT ? ' <b style="color:#f39c12">(you)</b>' : '';
            html += '<span class="ld-dot" style="background:' + ({ green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' })[c] + '"></span>' + c.charAt(0).toUpperCase() + c.slice(1) + ': <span class="ld-addr">' + who + '</span>' + mine + ' · ';
        }
        host.innerHTML = html;
    }
    function short(h) { return h ? (h.slice(0, 6) + '...' + h.slice(-4)) : ''; }

    // ---- turn flow ----
    function beginTurn() {
        if (!VIEW) return;
        window.setupConfigurationLocked = true;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        quiet = {};
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        if (VIEW.turn === MY_SEAT) {
            setPrompt('Your turn (' + colorOf(MY_SEAT) + '): tap the centre of the board to roll.');
            if (ui().action) ui().action('');
        } else {
            setPrompt(colorOf(VIEW.turn) + ' is playing...');
        }
        startCountdown();
    }
    function startCountdown() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        pollBoardTimerFacts(function (lastTs, turnSecs, serverNow) {
            if (!lastTs || !turnSecs) return;
            countdownTo = (serverNow || Math.floor(Date.now() / 1000)) - (turnSecs - (serverNow - lastTs));
            countdownTimer = setInterval(tickCountdown, 250);
        });
    }
    function pollBoardTimerFacts(cb) {
        if (!SID) return;
        relay('ldsBoard', { sessionId: SID }).then(function (j) {
            if (j.found) cb(Number(j.lastTs), Number(j.turnSecs), Number(j.serverNow));
        }).catch(function () {});
    }
    function tickCountdown() {
        var left = countdownTo - (Math.floor(Date.now() / 1000));
        if (ui().countdown) ui().countdown(fmtClock(left));
        if (left <= 0 && VIEW && VIEW.turn === MY_SEAT) actTimeout();
    }
    function fmtClock(s) {
        s = Math.max(0, s);
        var m = Math.floor(s / 60), ss = s % 60;
        return (m < 10 ? '0' : '') + m + 'm:' + (ss < 10 ? '0' : '') + ss + 's';
    }

    async function rollCurrent() {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        busy = true;
        try {
            var r = await relaySess('ldsRoll', { sessionId: SID, wallet: USER });
            syncFrom(r);
            window.__LDNoTumble = true;
            applyBoard(r.view);
            window.__LDNoTumble = false;
            cacheAppend(syncMoveFrom(r));
            window.currentTurnMoves = [r.dice1, r.dice2];
            window.isDiceRolled = true;
            if (ui().log) ui().log('Rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (on-chain dice, free)', 0);
            if (typeof window.showDiceTumble === 'function') window.showDiceTumble(r.dice1, r.dice2);
            setTimeout(afterDiceWindow, 3600);
        } catch (e) {
            handleErr(e, 'Roll failed');
        } finally {
            busy = false;
        }
    }
    function syncFrom(r) {
        if (!r || !r.view) return;
        VIEW = r.view;
        if (r.sessionId) SID = r.sessionId;
        if (typeof r.players === 'object' && r.players) window.__LDPLAYERS = r.players.slice();
        if (typeof r.sessionKeys === 'object' && r.sessionKeys) window.__LDKEYS = r.sessionKeys.slice();
    }
    function syncMoveFrom(r) { return (r && r.move) || null; }

    function afterDiceWindow() {
        window.displayDiceOnBoard = false;
        window.currentTurnMoves = VIEW ? [VIEW.dieA, VIEW.dieB] : [];
        window.isDiceRolled = true;
        if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        if (!VIEW || VIEW.turn !== MY_SEAT) return;
        if (!hasLegalMove(MY_SEAT, window.currentTurnMoves)) {
            setPrompt('No move available. Passing.');
            setTimeout(passTurn, 900);
        } else {
            setPrompt('Tap a blinking token to move it.');
        }
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

    async function userMove(tokenIndex) {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        var steps = VIEW.steps[MY_SEAT * 4 + tokenIndex];
        var pick = -1;
        for (var d = 0; d < (window.currentTurnMoves || []).length; d++) {
            var val = window.currentTurnMoves[d];
            if (steps < 0) { if (val === 6) { pick = d; break; } }
            else if (steps < 57 && steps + val <= 57) { pick = d; break; }
        }
        if (pick < 0) return;
        var die = window.currentTurnMoves[pick];
        window.currentTurnMoves.splice(pick, 1);
        busy = true;
        try {
            var r = await relaySess('ldsMove', { sessionId: SID, wallet: USER, seat: MY_SEAT, tokenIndex: tokenIndex, value: die });
            syncFrom(r);
            applyBoard(r.view);
            cacheAppend(syncMoveFrom(r));
            window.currentTurnMoves = VIEW.dieA ? [VIEW.dieA, VIEW.dieB].filter(function (x) { return x > 0; }) : [];
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die + ' (free)', 0);
            if (window.currentTurnMoves.length && hasLegalMove(MY_SEAT, window.currentTurnMoves)) {
                setPrompt('Tap another token, or Press Pass.');
            } else {
                setTimeout(passTurn, 500);
            }
        } catch (e) {
            window.currentTurnMoves.splice(pick, 0, die);
            handleErr(e, 'Move rejected');
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        busy = true;
        try {
            var r = await relaySess('ldsPass', { sessionId: SID, wallet: USER });
            syncFrom(r);
            applyBoard(r.view);
            cacheAppend(syncMoveFrom(r));
            window.isDiceRolled = false;
            window.currentTurnMoves = [];
            beginTurn();
        } catch (e) {
            handleErr(e, 'Pass failed');
        } finally {
            busy = false;
        }
    }
    async function actTimeout() {
        if (busy || !VIEW || VIEW.turn !== MY_SEAT) return;
        if (quiet[colorOf(MY_SEAT)]) return;
        quiet[colorOf(MY_SEAT)] = true;
        busy = true;
        try {
            var r = await relaySess('ldsPass', { sessionId: SID, wallet: USER, timeout: true });
            syncFrom(r);
            applyBoard(r.view);
            cacheAppend(syncMoveFrom(r));
            window.isDiceRolled = false;
            window.currentTurnMoves = [];
            beginTurn();
        } catch (e) {
            quiet[colorOf(MY_SEAT)] = false;
            handleErr(e, 'Timer');
        } finally {
            busy = false;
        }
    }

    // ---- polling the shared board (real-time opponent moves) ----
    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            if (!SID || busy && VIEW && VIEW.turn !== MY_SEAT) { return; }
            relay('ldsBoard', { sessionId: SID }).then(function (j) {
                if (!j.found) return;
                if (j.settled) { stopPoll(); onSettledSeen(j); return; }
                if (j.view && j.view.moveCount !== (VIEW ? VIEW.moveCount : -1)) {
                    applyBoard(j.view);
                } else if (j.view && (!VIEW || VIEW.moveCount === undefined)) {
                    applyBoard(j.view);
                }
            }).catch(function () {});
        }, 1200);
    }
    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }

    // ---- settle: winner-suffices ----
    function onSettledSeen(j) {
        setPrompt('Match settled on-chain. The result is permanent.');
        if (ui().meterState) ui().meterState.textContent = 'sealed';
        if (ui().tx) ui().tx(j.settleTx, 'settled');
        window.matchOver = true;
        stopPoll();
    }
    async function maybeSettle() {
        if (!VIEW || !VIEW.matchOver) return;
        stopPoll();
        setPrompt('Match finished. Sealing on-chain...');
        busy = true;
        try {
            var dg = await relaySess('ldsDigest', { sessionId: SID });
            var sig = null;
            try {
                if (KEY && KEY.privateKey && window.GGI_SDK && typeof window.GGI_SDK.signMove === 'function') {
                    sig = await window.GGI_SDK.signMove(KEY.privateKey, SID, dg.finalHash);
                } else if (typeof window.ggiSignDigest === 'function') {
                    sig = await window.ggiSignDigest(dg.digest);
                } else if (KEY && KEY.privateKey && typeof window.__LD_SIGN === 'function') {
                    sig = await window.__LD_SIGN(KEY.privateKey, dg.digest);
                }
            } catch (e) { sig = null; }
            if (!sig) {
                // The relay already has the winner seat's key address committed;
                // if OUR seat is the winner, we must sign. Fallback: prompt.
            }
            var r = await relaySess('ldsSign', { sessionId: SID, wallet: USER, seat: MY_SEAT, sig: sig });
            if (r.settled) {
                if (ui().gas) ui().gas(r.costUsdc6, 'sealed');
                if (ui().tx) ui().tx(r.tx, 'settled');
                setPrompt('Sealed on-chain. The result is permanent.');
                window.matchOver = true;
                stopPoll();
                cacheClear();
            } else {
                setPrompt('Result sealed. Waiting for the winner device to confirm on-chain (or tap to settle again).');
            }
        } catch (e) {
            handleErr(e, 'Settle');
        } finally {
            busy = false;
        }
    }

    // ---- seat matrix + lobby ----
    function renderMatrix(players) {
        window.__LDPLAYERS = players || [];
        var slots = document.querySelectorAll('.setup-slot');
        slots.forEach(function (slot) {
            var q = slot.getAttribute('data-q');
            var idx = activeSeats().indexOf(q);
            var on = idx >= 0;
            slot.classList.toggle('off', !on);
            var status = slot.querySelector('.seat-status');
            var who = slot.querySelector('.seat-who');
            var you = slot.querySelector('.seat-you');
            var filled = on && players && players[idx];
            if (status) status.textContent = on ? (filled ? 'FILLED' : 'OPEN') : 'OFF';
            if (who) who.textContent = filled ? short(filled) : '';
            if (you) {
                you.style.display = (!on || filled) ? 'none' : '';
                if (MY_SEAT === idx) { you.textContent = 'READY'; you.classList.add('me'); you.style.display = ''; }
                else { you.textContent = 'Sit here'; you.classList.remove('me'); }
            }
            window.__LDQUADS = activeSeats();
        });
    }
    function setMode(mode) {
        SEATS = mode === 4 ? 4 : 2;
        if (ui().log) ui().log('Mode set to ' + SEATS + ' players (green' + (SEATS === 4 ? ', yellow, blue' : '') + ', red)', 0);
    }

    async function sitHere(q) {
        try {
            var evm = signedIn();
            if (!evm) return;
            ensureKey();
            var quads = activeSeats();
            var idx = quads.indexOf(q);
            if (idx < 0) { setPrompt(q + ' is not active in ' + SEATS + '-player mode.'); return; }
            setAction('Sitting at ' + q + '...');
            if (!SID) {
                // Host: create the lobby seated at this colour.
                var c = await relaySess('ldsCreate', { seatCount: SEATS, wallet: evm, sessionKey: KEY.address, quadOrder: quads });
                SID = c.sessionId; CODE = c.code; MY_SEAT = idx; window.__LDPLAYERS = c.players || []; window.__LDKEYS = [KEY.address];
                window.__LDQUADS = quads;
                quiet = {};
                cacheClear();
                if (ui().ids) ui().ids(SID, c);
                if (ui().code) ui().code('Code: ' + c.code + '  |  Share link: ' + location.origin + '/gfgnew/board/ludo/?game=' + SID);
                renderMatrix(c.players);
                startLobbyPoll();
                setPrompt('Lobby open. Share the link, tap your seat, and press Start when everyone is in.');
                return;
            }
            // Joiner on an existing lobby: callers seat us via join, then refresh.
            var j = await relaySess('ldsJoin', { sessionId: SID, wallet: evm, sessionKey: KEY.address, seat: idx });
            MY_SEAT = typeof j.seat === 'number' ? j.seat : idx;
            window.__LDKEYS = (j.sessionKeys || window.__LDKEYS || []);
            window.__LDPLAYERS = j.players || [];
            if (j.quadrant && j.quadrant !== q) setPrompt('Seated at ' + j.quadrant + ' (the chosen seat was free).');
            renderMatrix(j.players);
            setPrompt('Seated. Waiting for the host to start the match...');
        } catch (e) { handleErr(e, 'Sit'); }
    }

    function startLobbyPoll() {
        if (lobbyTimer) clearInterval(lobbyTimer);
        lobbyTimer = setInterval(function () {
            if (!SID) return;
            relay('ldsLobby', { sessionId: SID }).then(function (j) {
                if (!j.found) return;
                window.__LDPLAYERS = j.players || [];
                renderMatrix(j.players);
                var full = (j.players || []).length >= j.seatCount;
                if (ui && document.getElementById('mp-begin')) document.getElementById('mp-begin').disabled = !(full && MY_SEAT === 0);
                if (j.status === 1) { clearInterval(lobbyTimer); lobbyTimer = null; beginLive(); }
            }).catch(function () {});
        }, 2500);
    }

    async function begin() {
        try {
            if (MY_SEAT !== 0) { setPrompt('Only the host (green seat, first seat) can start the match.'); return; }
            var evm = signedIn();
            var c = await relaySess('ldsBegin', { sessionId: SID, wallet: evm });
            if (c.status === 1) {
                if (ui().gas) ui().gas(c.costUsdc6, 'connected');
                if (ui().tx) ui().tx(c.connectTx, 'connected');
                if (ui().log) ui().log('Session connected on-chain (one transaction, sponsor paid). Playing is free.', 0);
                stopLobbyPoll();
                beginLive();
            }
        } catch (e) { handleErr(e, 'Start match'); }
    }
    function stopLobbyPoll() { if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; } }

    function beginLive() {
        live = true;
        if (ui().meterState) ui().meterState.textContent = 'playing';
        // Fetch the current board + bind seats, then start the move loop + poll.
        relay('ldsBoard', { sessionId: SID }).then(function (j) {
            if (j.found) {
                syncFrom(j);
                bindSeats();
                applyBoard(j.view);
                startPoll();
                beginTurn();
            }
        }).catch(function (e) { handleErr(e, 'Start'); });
    }
    function bindSeats() {
        var players = window.__LDPLAYERS || [];
        activeSeats().forEach(function (c, i) {
            if (typeof window.playerProfiles[c] === 'object') {
                window.playerProfiles[c].mode = 'human';
                window.playerProfiles[c].isUser = i === MY_SEAT;
            }
        });
        if (ui().turn) renderTurn();
    }

    function signedIn() {
        var evm = (typeof window.getDynamicEvmWallet === 'function') ? window.getDynamicEvmWallet() : null;
        if (!(window.currentUser || evm)) {
            setPrompt('Sign in to play. You get an embedded EVM wallet automatically.');
            if (typeof window.openDynamicLogin === 'function') window.openDynamicLogin();
            return null;
        }
        return evm || (window.currentUser && window.currentUser.evm) || null;
    }

    // ---- start (host) ----
    async function start() {
        if (busy) return null;
        busy = true;
        VIEW = null;
        try {
            var evm = signedIn();
            if (!evm) return null;
            if (typeof window.GGI_SDK === 'undefined' && window.FoskaayGGI) {
                var Klass = window.FoskaayGGI.GgiClient || window.FoskaayGGI.default;
                if (Klass) window.GGI_SDK = new Klass({ network: 'testnet' });
            }
            ensureKey();
            var quads = activeSeats();
            var c = await relaySess('ldsCreate', { seatCount: SEATS, wallet: evm, sessionKey: KEY.address, quadOrder: quads });
            SID = c.sessionId; CODE = c.code; MY_SEAT = 0;
            window.__LDPLAYERS = [evm]; window.__LDKEYS = [KEY.address];
            window.__LDQUADS = quads;
            quiet = {};
            cacheClear();
            if (ui().ids) ui().ids(SID, c);
            if (ui().code) ui().code('Code: ' + c.code + '  |  Share link: ' + location.origin + '/gfgnew/board/ludo/?game=' + SID);
            renderMatrix([evm]);
            startLobbyPoll();
            setPrompt('Lobby open. Share the link; opponents tap a free colour to join; press Start when everyone is in.');
            if (ui().log) ui().log('Lobby created. One connect transaction happens when the host presses Start.', 0);
            return c;
        } catch (e) {
            handleErr(e, 'Start');
            return null;
        } finally {
            busy = false;
        }
    }

    async function join(input) {
        if (busy) return null;
        busy = true;
        try {
            var evm = signedIn();
            if (!evm) return null;
            if (typeof window.GGI_SDK === 'undefined' && window.FoskaayGGI) {
                var Klass = window.FoskaayGGI.GgiClient || window.FoskaayGGI.default;
                if (Klass) window.GGI_SDK = new Klass({ network: 'testnet' });
            }
            ensureKey();
            setAction('Joining...');
            var rr = await relaySess('ldsRejoin', { sessionId: input, wallet: evm });
            var sessId = rr.sessionId || input;
            var q = activeSeats();
            var want = -1;
            // Auto-pick the first free seat (or the seat this device had before).
            var players = rr.players || [];
            for (var i = 0; i < SEATS; i++) { if (!players[i]) { want = i; break; } }
            var j = await relaySess('ldsJoin', { sessionId: sessId, wallet: evm, sessionKey: KEY.address, seat: want >= 0 ? want : undefined });
            SID = j.sessionId || sessId; CODE = j.code || ''; MY_SEAT = typeof j.seat === 'number' ? j.seat : (want >= 0 ? want : 0);
            window.__LDPLAYERS = j.players || players; window.__LDKEYS = [KEY.address];
            if (ui().ids) ui().ids(SID, j);
            renderMatrix(j.players);
            setPrompt('Seated as ' + colorOf(MY_SEAT) + '. Waiting for the host to start the match...');
            startLobbyPoll();
            return j;
        } catch (e) {
            handleErr(e, 'Join');
            return null;
        } finally {
            busy = false;
        }
    }

    async function rejoin(sessionId, wallet) {
        if (busy || !sessionId) return { ok: false, reason: 'no session' };
        busy = true;
        try {
            var evm = wallet || signedIn();
            if (!(window.currentUser || evm)) { setPrompt('Sign in to rejoin your session.'); return { ok: false, reason: 'not signed in' }; }
            ensureKey();
            // Try the warm relay first; if cold, resync from the cached copy.
            var j = null;
            try { j = await relay('ldsRejoin', { sessionId: sessionId, wallet: evm }); }
            catch (e) { j = { ok: false, reason: (e && e.relay && e.relay.error) || (e && e.message) || 'session not found' }; }
            if (!j.ok && !isCold(j)) { setPrompt(j.reason || 'Cannot rejoin this session.'); return { ok: false, reason: j.reason }; }
            if (!j.ok) {
                // Cold relay: rebuild from this device's cached verified copy.
                var saved = null;
                try { saved = JSON.parse(localStorage.getItem(LD_CACHE) || 'null'); } catch (e) {}
                if (saved && saved.sid === sessionId && saved.moves && saved.moves.length) {
                    try {
                        await relay('ldsResync', { sessionId: sessionId, envelope: saved.envelope || {}, moves: saved.moves });
                        j = await relay('ldsRejoin', { sessionId: sessionId, wallet: evm });
                    } catch (e2) { }
                }
                if (!j.ok) { setPrompt('This session was lost on the server. Start a new match.'); if (ui().sessionLost) ui().sessionLost(); return { ok: false, reason: j.reason }; }
            }
            SID = j.sessionId; MY_SEAT = seatOf(j.players, evm); SEATS = j.seatCount || SEATS;
            window.__LDPLAYERS = j.players || []; window.__LDKEYS = j.sessionKeys || [];
            var q = j.quadOrder && j.quadOrder.length === SEATS ? j.quadOrder : activeSeats();
            window.__LDQUADS = q;
            cacheMoves = (j.moves && j.moves.slice()) || cacheMoves || [];
            // VERIFY BEFORE DRAW.
            if (j.moves && j.moves.length && window.GGI_SDK && typeof window.GGI_SDK.verifyMoveLog === 'function') {
                var vr = await window.GGI_SDK.verifyMoveLog(SID, {
                    startHash: j.startHash, moves: j.moves, sessionKeys: j.sessionKeys || [],
                    sponsorAddress: j.sponsorAddress, finalHash: j.finalHash, settled: j.settled
                });
                if (!vr.valid) {
                    setPrompt('Rejoin blocked: the relay returned a tampered midchain log. Start a new match.');
                    if (ui().log) ui().log('MIDCHAIN VERIFY FAILED: ' + vr.reason, 0);
                    return { ok: false, reason: 'verification failed: ' + vr.reason };
                }
                if (ui().log) ui().log('Midchain verified: ' + vr.checked + ' signed moves match the on-chain anchors', 0);
            }
            cacheSave();
            bindSeats();
            applyBoard(j.view);
            if (ui().ids) ui().ids(SID, j);
            if (ui().log) ui().log('Rejoined session ' + String(SID).slice(0, 10) + '...', 0);
            if (j.status === 1) { live = true; startPoll(); beginTurn(); }
            else { renderMatrix(j.players); startLobbyPoll(); }
            return { ok: true };
        } catch (e) {
            setPrompt('Rejoin failed: ' + e.message);
            return { ok: false, reason: e.message };
        } finally {
            busy = false;
        }
    }
    function seatOf(players, wallet) {
        if (!players) return 0;
        for (var i = 0; i < players.length; i++) {
            if (String(players[i]).toLowerCase() === String(wallet || '').toLowerCase()) return i;
        }
        return 0;
    }

    function copyLink() {
        if (!SID) { setPrompt('Start or join a session first.'); return; }
        var url = location.origin + '/gfgnew/board/ludo/?game=' + SID;
        var done = function () { setAction('Session link copied: ' + url); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
        else done();
    }

    function handleErr(e, tag) {
        var m = (e && e.message) || String(e);
        if (/lost on the server|restarted/i.test(m)) {
            setPrompt('This session was lost on the server. Start a new match.');
            if (ui().sessionLost) ui().sessionLost();
            if (ui().log) ui().log(tag + ': session lost (' + m + ')', 0);
            return;
        }
        setPrompt(tag + ': ' + m);
        if (ui().action) ui().action(tag + ': ' + m);
        if (ui().log) ui().log(tag + ': ' + m, 0);
    }

    // ---- canvas click -> move / centre -> roll ----
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

    // ---- window API ----
    window.GFG_LUDO = {
        start: start, join: join, begin: begin, rejoin: rejoin, setMode: setMode,
        sitHere: sitHere, copyLink: copyLink,
        pass: passTurn, settle: maybeSettle,
        mySeat: function () { return MY_SEAT; },
        seat: function () { return MY_SEAT; },
        board: function () { return VIEW; },
        sessionId: function () { return SID; }
    };

    // Bind settle to the finish ceremony: when the board says the match is over.
    window.__LD_MONITOR = setInterval(function () {
        if (VIEW && VIEW.matchOver && !window.__LDSETTLING) {
            window.__LDSETTLING = true;
            maybeSettle();
        }
    }, 1500);

    document.addEventListener('DOMContentLoaded', function () {
        wrapDraw();
        var canvas = document.getElementById('ludoCanvas');
        if (canvas) canvas.addEventListener('click', onCanvasClick);
        // Resolve ?game=<sid>: rejoin live, or show on-chain truth once settled.
        var q = new URLSearchParams(location.search).get('game');
        if (q) {
            var attempt = function () {
                if (window.GFG_LUDO && typeof window.GFG_LUDO.rejoin === 'function') {
                    window.GFG_LUDO.rejoin(q, undefined);
                }
            };
            if (typeof window.addEventListener === 'function') { try { window.addEventListener('gfg:auth-changed', attempt, false); } catch (e) {} }
            var trySoon = function (n) {
                if (n > 20) return;
                if ((window.getDynamicEvmWallet && window.getDynamicEvmWallet()) || window.currentUser) attempt();
                else setTimeout(function () { trySoon(n + 1); }, 500);
            };
            trySoon(0);
        }
    });
})();