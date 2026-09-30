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
    // Quadrant map: seat index -> displayed quadrant color. The contract only
    // knows seat numbers; color is pure display, shared via the lobby so every
    // phone paints the same seat in the same quadrant.
    var QUADS = ['green', 'yellow', 'blue', 'red'];
    function quad(s) { return QUADS[s] || COLOR_OF[s] || 'green'; }
    var SEAT_OF = { green: 0, yellow: 1, blue: 2, red: 3 };

    var SID = null, MY_WALLET = null, MY_KEY = null, MY_SEAT = -1, SEATS = 2;
    var VIEW = null, PLAYERS = [], SKEYS = [];
    var SOLO = false, SPONSOR_ADDR = '';
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
    window.getActiveSeats = function () { return QUADS.slice(0, SEATS); };
    window.getPlayerRank = function (color) {
        if (!VIEW || !VIEW.order) return 0;
        var seat = QUADS.indexOf(color);
        if (seat < 0) seat = SEAT_OF[color] || 0;
        var fc = VIEW.finishCount || 0;
        for (var i = 0; i < fc; i++) {
            if (VIEW.order[i] === seat) return i + 1;
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
                if (!j.ok) throw new Error((j && (j.error || j.reason)) || ('relay ' + r.status));
                return j;
            });
        });
    }


    // Live-action retry: safe ONLY for 'unknown session' (thrown before any
    // state change), covering serverless copies that never saw the lobby.
    // Never retries dice/move rejections: those already executed or ruled.
    function relayLive(action, extra, tries) {
        tries = (typeof tries === 'number') ? tries : 6;
        var attempt = function (i) {
            return relay(action, extra).catch(function (e) {
                var msg = (e && e.message) || String(e);
                if (i < tries && /unknown session|lobby not found/i.test(msg)) {
                    return new Promise(function (res) { setTimeout(res, 800); }).then(function () { return attempt(i + 1); });
                }
                throw e;
            });
        };
        return attempt(0);
    }

    // Join retries: serverless relays each hold their own lobby memory, so a
    // fresh lobby may need a few taps to meet the warm instance. Retry on
    // not-found only; anything else fails fast with human words.
    function relayJoin(action, extra, tries) {
        tries = (typeof tries === 'number') ? tries : 8;
        var attempt = function (i) {
            return relay(action, extra).catch(function (e) {
                var msg = (e && e.message) || String(e);
                if (i < tries && /not found|lobby/i.test(msg)) {
                    return new Promise(function (res) { setTimeout(res, 700); }).then(function () { return attempt(i + 1); });
                }
                throw e;
            });
        };
        return attempt(0);
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
        var color = quad(seat);
        if (stepsWalked >= 52) {
            var lane = stepsWalked - 51;
            if (color === 'green') return { c: lane, r: 7 };
            if (color === 'yellow') return { c: 7, r: lane };
            if (color === 'blue') return { c: 14 - lane, r: 7 };
            return { c: 7, r: 14 - lane };
        }
        // Track position follows the SEAT number exactly like the contract
        // ((seat*13 + steps) % 52); only lane/yard geometry follows quadrant.
        var abs = (seat * 13 + stepsWalked) % 52;
        return COMMON_PATH[abs];
    }

    function applyBoard(view) {
        VIEW = view;
        SEATS = view.seatCount;
        var dd1 = document.getElementById('mp-d1');
        var dd2 = document.getElementById('mp-d2');
        if (dd1) dd1.textContent = (view.dieA > 0) ? view.dieA : '-';
        if (dd2) dd2.textContent = (view.dieB > 0) ? view.dieB : '-';
        var t = window.tokens;
        for (var s = 0; s < 4; s++) {
            var color = quad(s);
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
        window.currentTurn = quad(view.turn);
        window.matchOver = !!view.matchOver;
        for (var p = 0; p < 4; p++) {
            var c = quad(p);
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
        setLiveUI(true);
        if (VIEW.matchOver) { setTimeout(settle, 0); return; }
        window.setupConfigurationLocked = true;
        window.isDiceRolled = false;
        window.currentTurnMoves = [];
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        if (typeof window.ensureBoardAnimationLoop === 'function') window.ensureBoardAnimationLoop();
        stopPoll();
        try {
            for (var bs = 0; bs < SEATS; bs++) {
                var bc = quad(bs);
                if (window.playerProfiles[bc]) {
                    window.playerProfiles[bc].mode = 'human';
                    window.playerProfiles[bc].isUser = (bs === MY_SEAT);
                }
            }
        } catch (e) {}
        if (SID) relayLive('mpBoard', { sessionId: SID }).then(function (j) { tickCountdown(j.lastTs, j.turnSecs); }).catch(function () {});
        var turnEl = document.getElementById('mp-turn');
        if (turnEl) turnEl.textContent = (VIEW.turn === MY_SEAT ? 'Your turn' : quad(VIEW.turn) + ' to play') + ' (' + SEATS + 'P)';
        if (VIEW.turn === MY_SEAT) setPrompt('Your turn (' + quad(MY_SEAT) + '): tap the centre of the board to roll.');
        else if (SOLO) { setPrompt(quad(VIEW.turn) + ' (computer) is playing...'); setTimeout(function () { houseTakeTurn(VIEW.turn); }, 900); }
        else { setPrompt(quad(VIEW.turn) + ' is playing... you watch.'); startPoll(); }
    }

    var countTimer = null;
    var ROOMANCHOR = null; // {startHash, sponsorAddress} for log verification
    var pollN = 0;
    var firedKey = '';
    // One shared countdown, from the CONTRACT timer (same numbers on every
    // phone; the page only displays). At zero the turn auto-fires a timeout
    // advance once per turn: the relay dedupes doubles and the contract only
    // advances a truly expired turn, keeping bonus turns intact.
    function tickCountdown(lastTs, turnSecs) {
        if (countTimer) { clearInterval(countTimer); countTimer = null; }
        var el = document.getElementById('mp-countdown');
        if (!el || !lastTs || !turnSecs) { if (el) el.textContent = ''; return; }
        var draw = function () {
            var ms = (lastTs + turnSecs) * 1000 - Date.now();
            if (ms < 0) ms = 0;
            var mm = Math.floor(ms / 60000), ss = Math.floor((ms % 60000) / 1000), mmm = Math.floor(ms % 1000);
            var pad = function (v, n) { v = String(v); while (v.length < n) v = '0' + v; return v; };
            el.textContent = pad(mm, 2) + 'm:' + pad(ss, 2) + 's:' + pad(mmm, 3) + 'ms';
            var key = (SID || '') + ':' + lastTs + ':' + (VIEW ? VIEW.turn : '?');
            if (ms <= 0 && firedKey !== key && SID && VIEW && !VIEW.matchOver) {
                firedKey = key;
                timeoutSeat();
            }
        };
        draw();
        countTimer = setInterval(draw, 100);
    }

    // Full-log adopt: every few polls the whole verified log is cached, so
    // opponent moves witnessed live also survive on this device.
    function adoptFullLog() {
        if (!SID || !ROOMANCHOR) return;
        var s = sdk();
        if (!s || typeof s.verifyMoveLog !== 'function') return;
        relay('mpMoves', { sessionId: SID }).then(function (m) {
            if (!m || !m.found || !m.moves) return;
            s.verifyMoveLog(SID, {
                startHash: ROOMANCHOR.startHash, moves: m.moves, sessionKeys: SKEYS,
                sponsorAddress: ROOMANCHOR.sponsorAddress, finalHash: m.finalHash, settled: m.settled
            }).then(function (vr) {
                if (vr.valid) cacheAdopt(ROOMANCHOR.startHash, m.moves, PLAYERS, SKEYS, SEATS);
            }).catch(function () {});
        }).catch(function () {});
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            if (busy || !SID || !VIEW || VIEW.turn === MY_SEAT || VIEW.matchOver) return;
            relayLive('mpBoard', { sessionId: SID }).then(function (j) {
                if (j.settled) {
                    stopPoll();
                    if (countTimer) { clearInterval(countTimer); countTimer = null; }
                    setPrompt('Sealed on-chain. Open the transaction link below for the record.');
                    if (ui().tx && j.settleTx) ui().tx(j.settleTx, 'settled');
                    updatePoints();
                    return;
                }
                tickCountdown(j.lastTs, j.turnSecs);
                if ((pollN++ % 5) === 0) adoptFullLog();
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
            var r = await relayLive('mpRoll', { sessionId: SID, wallet: MY_WALLET });
            applyBoard(r.view);
            cacheAppend(r.move);
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
            var r = await relayLive('mpMove', { sessionId: SID, wallet: MY_WALLET, seat: MY_SEAT, tokenIndex: tokenIndex, value: die });
            pendingDice.splice(pick, 1);
            applyBoard(r.view);
            cacheAppend(r.move);
            if (ui().log) ui().log('You moved token ' + (tokenIndex + 1) + ' by ' + die + ' (free)', 0);
            if (pendingDice.length && hasLegalMove(MY_SEAT, pendingDice)) setPrompt('Tap another token for your second dice, or Pass.');
            else setTimeout(passTurn, 500);
        } catch (e) {
            setPrompt('Move rejected: ' + e.message);
        } finally {
            busy = false;
        }
    }

    // SOLO computer (same rules, same chain, signed by the relay sponsor key
    // like single-player house seats; earns nothing). Strategy: capture, then
    // yard release on 6, then score to centre, else furthest movable piece.
    function housePickToken(seat, dice) {
        var base = seat * 4;
        var absOf = function (s, st) { return (s * 13 + st) % 52; };
        for (var d = 0; d < dice.length; d++) {
            var val = dice[d];
            for (var i = 0; i < 4; i++) {
                var st = VIEW.steps[base + i];
                if (st < 0 || st >= 52) continue;
                var ne = st + val;
                if (ne > 57 || ne >= 52) continue;
                var land = absOf(seat, ne);
                if (land % 13 === 0) continue;
                for (var s2 = 0; s2 < SEATS; s2++) {
                    if (s2 === seat) continue;
                    for (var t2 = 0; t2 < 4; t2++) {
                        var o = VIEW.steps[s2 * 4 + t2];
                        if (o >= 0 && o < 52 && absOf(s2, o) === land) return { token: i, die: val };
                    }
                }
            }
        }
        for (var d2 = 0; d2 < dice.length; d2++) {
            var v2 = dice[d2];
            if (v2 === 6) {
                for (var j = 0; j < 4; j++) { if (VIEW.steps[base + j] < 0) return { token: j, die: v2 }; }
            }
            for (var k = 0; k < 4; k++) {
                var sc = VIEW.steps[base + k];
                if (sc >= 0 && sc < 57 && sc + v2 === 57) return { token: k, die: v2 };
            }
        }
        var best = -1, bestSteps = -2, bestDie = 0;
        for (var d3 = 0; d3 < dice.length; d3++) {
            var v3 = dice[d3];
            for (var m = 0; m < 4; m++) {
                var sm = VIEW.steps[base + m];
                var movable = (sm < 0) ? (v3 === 6) : (sm < 57 && sm + v3 <= 57);
                if (movable && sm > bestSteps) { bestSteps = sm; best = m; bestDie = v3; }
            }
        }
        if (best < 0) return null;
        return { token: best, die: bestDie };
    }

    async function houseTakeTurn(seat) {
        if (busy || !VIEW || VIEW.matchOver || seat === MY_SEAT) return;
        if (String(PLAYERS[seat] || '').toLowerCase() !== String(SPONSOR_ADDR).toLowerCase()) return;
        busy = true;
        try {
            var wallet = PLAYERS[seat];
            var r = await relayLive('mpRoll', { sessionId: SID, wallet: wallet });
            applyBoard(r.view);
            cacheAppend(r.move);
            var dice = [r.dice1, r.dice2];
            if (ui().log) ui().log(quad(seat) + ' rolled <b>' + r.dice1 + '</b> and <b>' + r.dice2 + '</b> (free)', 0);
            var guard = 0;
            while (dice.length && guard++ < 4) {
                var pick = housePickToken(seat, dice);
                if (!pick) break;
                var mv = await relayLive('mpMove', { sessionId: SID, wallet: wallet, seat: seat, tokenIndex: pick.token, value: pick.die });
                applyBoard(mv.view);
                cacheAppend(mv.move);
                var di = dice.indexOf(pick.die);
                if (di >= 0) dice.splice(di, 1);
            }
            var p = await relayLive('mpPass', { sessionId: SID, wallet: wallet });
            applyBoard(p.view);
            cacheAppend(p.move);
            beginTurn();
        } catch (e) {
            setPrompt('Computer move failed: ' + e.message);
            try {
                var j = await relayLive('mpBoard', { sessionId: SID });
                applyBoard(j.view);
                beginTurn();
            } catch (e2) {}
        } finally {
            busy = false;
        }
    }

    async function passTurn() {
        if (busy || !VIEW) return;
        busy = true;
        try {
            var r = await relayLive('mpPass', { sessionId: SID, wallet: MY_WALLET });
            pendingDice = [];
            window.currentTurnMoves = [];
            window.isDiceRolled = false;
            applyBoard(r.view);
            cacheAppend(r.move);
            beginTurn();
        } catch (e) {
            // Not my seat (opponent already moved on): just refresh.
            try {
                var j = await relayLive('mpBoard', { sessionId: SID });
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
            var r = await relayLive('mpPass', { sessionId: SID, wallet: MY_WALLET, timeout: true });
            applyBoard(r.view);
            cacheAppend(r.move);
            beginTurn();
        } catch (e) {
            // Anyone may advance a stalled seat; if the gate refuses, refresh.
            try {
                var j = await relayLive('mpBoard', { sessionId: SID });
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
            var dg = await relayLive('mpDigest', { sessionId: SID });
            var s = sdk();
            var mySig = null;
            if (MY_KEY && MY_KEY.privateKey && s && typeof s.signMove === 'function') {
                mySig = await s.signMove(MY_KEY.privateKey, SID, dg.finalHash);
            } else if (typeof window.ggiSignDigest === 'function') {
                mySig = await window.ggiSignDigest(dg.digest);
            }
            if (mySig) {
                var r = await relayLive('mpSign', { sessionId: SID, wallet: MY_WALLET, seat: MY_SEAT, sig: mySig });
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
        setPrompt('Sealed on-chain. ' + (w === MY_SEAT ? 'You win the crown.' : quad(w) + ' wins the crown.'));
        if (ui().onSettled) ui().onSettled(w === MY_SEAT, r.tx);
        updatePoints();
        busy = false;
    }

    function pollSettled() {
        var tries = 0;
        var loop = setInterval(function () {
            tries++;
            relayLive('mpSession', { sessionId: SID }).then(function (p) {
                if (p && p.status === 2) {
                    clearInterval(loop);
                    relayLive('mpGame', { sessionId: SID }).then(function () {}).catch(function () {});
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

    // ---- device log cache (persistency, no server store) ----
    // The phone keeps the verified moves it has witnessed, on its own device.
    // The copy is a cache, never truth: re-verified on load before drawing,
    // and only ever submitted to the relay merge which re-verifies everything.
    // Keys never enter the cache (only public addresses travel).
    function cacheKey() { return SID ? ('gfg-mp-' + SID) : null; }
    function cacheLoad() {
        try {
            var raw = SID ? localStorage.getItem(cacheKey()) : null;
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function cacheSave(obj) {
        try { if (SID) localStorage.setItem(cacheKey(), JSON.stringify(obj)); } catch (e) {}
    }
    function cacheAdopt(startHash, moves, players, keys, seats) {
        cacheSave({ startHash: startHash, moves: moves || [], players: players || [], sessionKeys: keys || [], seatCount: seats || SEATS });
    }
    function cacheEnvelope(startHash, players, keys, seats) {
        var c = cacheLoad() || { startHash: startHash, moves: [], players: [], sessionKeys: [], seatCount: seats || SEATS };
        if (startHash) c.startHash = startHash;
        if (players && players.length) c.players = players;
        if (keys && keys.length) c.sessionKeys = keys;
        if (seats) c.seatCount = seats;
        cacheSave(c);
    }
    function cacheAppend(move) {
        if (!move) return;
        var c = cacheLoad() || { startHash: null, moves: [], players: PLAYERS, sessionKeys: SKEYS, seatCount: SEATS };
        var last = c.moves.length ? c.moves[c.moves.length - 1].newHash : c.startHash;
        if (c.moves.length && String(move.prevHash).toLowerCase() !== String(last).toLowerCase()) return; // gap: resync from relay instead
        if (!c.moves.length && c.startHash && String(move.prevHash).toLowerCase() !== String(c.startHash).toLowerCase()) return;
        c.moves.push(move);
        c.players = PLAYERS.length ? PLAYERS : c.players;
        c.sessionKeys = SKEYS.length ? SKEYS : c.sessionKeys;
        cacheSave(c);
    }

    // ---- create + join (lobby, zero copying) ----
    // Host opens a lobby (no handover yet). Joiners tap the shared link, signed
    // in: their wallet + fresh silent key address join automatically. When every
    // seat is filled the HOST device begins (one handover, sponsor pays) and
    // joins lock. Solo test holds every seat on this phone.

    // Setup panels collapse once the match is live so the board, message,
    // turn card and dice fit one phone screen. They return on fresh load.
    function setLiveUI(live) {
        ['mp-panel-lobby', 'mp-panel-join'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.style.display = live ? 'none' : '';
        });
    }

    function lobbyLink() { return SID ? ('/gfgnew/board/ludo-mp/?game=' + SID) : ''; }

    function pollLobby() {
        stopPoll();
        var show = function (p) {
            if (p.quadOrder && p.quadOrder.length) QUADS = p.quadOrder;
            var el = document.getElementById('mp-lobby');
            if (el) el.innerHTML = 'Seats ' + p.players.length + '/' + SEATS + ': ' + p.players.map(function (w, i) {
                return '<b>' + quad(i) + '</b> ' + short(w) + (w === MY_WALLET ? ' (you)' : '');
            }).join(' &nbsp; ') + (p.iid ? ' <span class="ld-muted">relay ' + p.iid + '</span>' : '');
            var bb = document.getElementById('mp-begin');
            if (bb) bb.disabled = !(p.status === 0 && p.players.length >= SEATS && PLAYERS[0] === MY_WALLET);
            // Envelope stays fresh from every lobby sighting (for rebuilds).
            try {
                var c = cacheLoad() || { startHash: null, moves: [], players: [], sessionKeys: [], seatCount: SEATS };
                c.players = p.players; c.seatCount = SEATS;
                cacheSave(c);
            } catch (e) {}
        };
        pollTimer = setInterval(function () {
            if (busy || !SID) return;
            relay('mpLobby', { sessionId: SID }).then(function (p) {
                show(p);
                if (p.status === 1) {
                    stopPoll();
                    relayLive('mpBoard', { sessionId: SID }).then(function (j) {
                        applyBoard(j.view);
                        beginTurn();
                    }).catch(function () {});
                    return;
                }
                // Lobby full: the HOST presses Start match (never automatic).
                if (p.status === 0 && p.players.length >= SEATS) {
                    setPrompt(PLAYERS[0] === MY_WALLET
                        ? 'Lobby full. Press Start match to begin.'
                        : 'Lobby full. Waiting for the host to start the match.');
                }
            }).catch(function () {});
        }, 2500);
    }

    // Manual begin (host only, GFG pattern): the creator presses Start match
    // after the room fills. The relay rejects anyone else.
    async function begin() {
        if (busy || !SID) return null;
        busy = true;
        try {
            var b = await relay('mpBegin', { sessionId: SID, wallet: MY_WALLET });
            stopPoll();
            if (ui().tx) ui().tx(b.connectTx, 'connected');
            if (ui().log) ui().log('Match begun on-chain (fee paid, one transaction)', b.costUsdc6);
            applyBoard(b.view);
            beginTurn();
            return b;
        } catch (e) {
            setPrompt('Begin failed: ' + e.message);
            return null;
        } finally {
            busy = false;
        }
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
            SOLO = !!soloTest;
            if (soloTest) {
                // House seats are the relay sponsor (like single-player
                // computers): relay-signed, on-chain, earning nothing.
                var sp = await relay('mpSponsor', {});
                SPONSOR_ADDR = sp.address;
                for (var i = 1; i < SEATS; i++) {
                    players.push(SPONSOR_ADDR);
                    keys.push(SPONSOR_ADDR);
                }
            }
            MY_SEAT = 0;
            var created = await relay('mpCreate', { seatCount: SEATS, wallet: evm, sessionKey: MY_KEY.address, players: players, sessionKeys: keys, hostQuad: Number((document.getElementById('mp-color') || {}).value || 0) });
            SID = created.sessionId;
            if (created.quadOrder && created.quadOrder.length) QUADS = created.quadOrder;
            PLAYERS = created.players;
            SKEYS = created.players.map(function (_, i) { return (keys[i] || ''); });
            SEATS = created.view.seatCount;
            try { if (history && history.replaceState) history.replaceState(null, '', lobbyLink()); } catch (e) {}
            applyBoard(created.view);
            if (ui().log) ui().log('Lobby open: share the session link below', 0);
            if (ui().ids) ui().ids(SID, '');
            var code = document.getElementById('mp-code');
            if (code) code.textContent = created.code + '  ' + location.origin + lobbyLink();
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
    async function rejoin(sessionId, wallet, quad) {
        if (busy || !sessionId) return { ok: false, reason: 'no session' };
        busy = true;
        VIEW = null; pendingDice = [];
        SID = sessionId;
        try {
            var evm = wallet || myWallet();
            if (!evm) return { ok: false, reason: 'sign in first' };
            if (!window.ggiSessionKey) {
                try { window.ggiSessionKey = makeKey(); } catch (e) { return { ok: false, reason: 'key engine loading, try again' }; }
            }
            var j = await relayJoin('mpRejoin', { sessionId: sessionId, wallet: evm });
            if (!j.ok) {
                // Relay lost this session: rebuild from this device's verified
                // copy (re-verified server-side by the merge), then continue.
                var c0 = cacheLoad();
                if (c0 && c0.moves && c0.moves.length) {
                    setPrompt('Relay lost this session. Rebuilding from verified copies...');
                    try {
                        await relay('mpResync', { sessionId: sessionId, envelope: { players: c0.players, sessionKeys: c0.sessionKeys, seatCount: c0.seatCount }, moves: c0.moves });
                        j = await relayJoin('mpRejoin', { sessionId: sessionId, wallet: evm });
                    } catch (e2) { setPrompt('Rebuild failed: ' + e2.message); return { ok: false, reason: e2.message }; }
                }
                if (!j.ok) { setPrompt(j.reason || 'Cannot rejoin this session.'); return { ok: false, reason: j.reason }; }
            }
            var seated = (j.players || []).some(function (w) { return String(w).toLowerCase() === String(evm).toLowerCase(); });
            if (!seated && j.status === 0) {
                var jj = await relayJoin('mpJoin', { sessionId: sessionId, wallet: evm, sessionKey: window.ggiSessionKey.address, quad: quad || '' });
                if (!jj || jj.seat == null || jj.seat < 0) { setPrompt((jj && jj.error) || 'Join failed (seats may be full).'); return { ok: false, reason: (jj && jj.error) || 'join failed' }; }
                if (ui().log) ui().log('Joined as ' + quad(jj.seat) + ' (seat ' + jj.seat + ')', 0);
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
            cacheAdopt(j.startHash, j.moves || [], j.players || [], j.sessionKeys || [], j.seatCount);
            ROOMANCHOR = { startHash: j.startHash, sponsorAddress: j.sponsorAddress || '' };
            SID = j.sessionId;
            try { if (history && history.replaceState) history.replaceState(null, '', lobbyLink()); } catch (e) {}
            SEATS = j.seatCount;
            if (j.quadOrder && j.quadOrder.length) QUADS = j.quadOrder;
            if (j.quadOrder && j.quadOrder.length) QUADS = j.quadOrder;
            PLAYERS = j.players || [];
            SKEYS = j.sessionKeys || [];
            MY_WALLET = evm;
            MY_SEAT = -1;
            for (var i = 0; i < PLAYERS.length; i++) {
                if (String(PLAYERS[i]).toLowerCase() === String(evm).toLowerCase()) MY_SEAT = i;
            }
            if (MY_SEAT < 0) return { ok: false, reason: 'your wallet is not a seat in this match' };
            cacheEnvelope(j.startHash, j.players || [], j.sessionKeys || [], j.seatCount);
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
                if (ui().log) ui().log('In lobby as ' + quad(MY_SEAT), 0);
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
            var pos = steps < 0 ? HOME_YARDS[quad(MY_SEAT)][i] : tokenCR(MY_SEAT, steps);
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
        begin: begin,
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
