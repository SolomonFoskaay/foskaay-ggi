// public/universal/multiplayer/multiplayer.js
// M12 — standalone game-agnostic multiplayer RAIL (AGM-FREE).
//
// The game owns everything (turn order, move meaning, rules, UI). This rail
// only: creates+delegates the match board (relay/sponsor, one-time base cost),
// and then every match write runs GASLESS on the ER signed by the PLAYER's
// session key (join/begin/commit/finish) — the program enforces seat authority
// (signer == players[seat]), so a wrong device can never commit another
// player's seat. The rail knows NOTHING about Ludo/Ayo: it transports opaque
// 32-byte commits + facts. A separate AGM (money) plug attaches later.
//
// ERROR SURFACING (hackathon-visible): every failure returns {okay:false,
// error} AND fires a DOM CustomEvent('gfg:mp-error', {detail:{error, action}})
// so any device can render it — never console-only, never silent.
//
// API (window.gfgMultiplayer):
//   create({gameId, seats, host, turnSecs, maxMatchSecs}) -> {okay, code, matchRef, pda}
//   join(gameId, code, seat, handle) -> {okay, matchRef, pda, seat}   (gasless ER, player signs)
//   begin(move) -> {okay}                                             (host signs, gasless ER)
//   commitMove({gameId, matchRef, seat}, bytes) -> {okay, sig|error}   (seat holder signs)
//   subscribe(matchRef, onUpdate, onError) -> unsubscribe
//   finish({gameId, matchRef}, winnerSeat) -> {okay, sig|error}        (seat holder signs)
//   state(matchRef) -> Promise<board facts|null>
//
// Per-game ADAPTER (inside the game, NOT here): a game registers
//   window.gfgMultiplayerAdapter(gameId) with encodeMove / applyOpponent /
//   currentSeat / isFinished — the rail never inspects move bytes.

(function () {
    if (window.gfgMultiplayer) return; // already loaded

    const GAME = 1; // M1 source_code default; games pass gameId for their own

    function log() { try { console.log.apply(console, ['[MP]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }

    function emitError(action, error) {
        const msg = (error && error.message) || String(error || 'unknown multiplayer error');
        log('ERROR [' + action + '] ' + msg);
        try {
            window.dispatchEvent(new CustomEvent('gfg:mp-error', { detail: { action: action, error: msg } }));
        } catch (e) { /* soft */ }
        try {
            if (typeof window.mpSetStatus === 'function') window.mpSetStatus(msg);
        } catch (e) { /* soft */ }
    }

    function api(action, body) {
        return fetch('/api/multiplayer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, body || {})),
        }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; });
    }

    function dice() { return (typeof window.magicblockDice === 'object' && window.magicblockDice) ? window.magicblockDice : null; }

    // ---- create / join ----
    // Create = relay runs start_match + delegate (sponsor pays the ONLY base
    // costs of a match). host is the creator's wallet (seat 0) — the program
    // locks it as the host, so begin can only be signed by the host's device.
    async function create(opts) {
        opts = opts || {};
        var matchRef = Date.now();
        var host = opts.host || null;
        var r = await api('create', {
            game: opts.gameId || GAME,
            matchRef: matchRef,
            host: host,
            seats: opts.seats || 2,
            stakeUsdCents: 0,               // free standalone; AGM raises this later
            // arc2m1 timer: pass 0 so the PROGRAM decides turn_secs (its own
            // DEFAULT_TURN_SECS). No off-chain fallback here - the board is the
            // single source of truth, read back for display only.
            turnSecs: 0,
            maxMatchSecs: opts.maxMatchSecs || 3600,
        });
        if (!r.ok) { emitError('create', r.error || 'create failed'); return { okay: false, error: r.error }; }
        var code = (matchRef).toString(36).toUpperCase();
        return { okay: true, code: code, matchRef: matchRef, pda: r.pda };
    }

    // code -> matchRef (exact inverse of create's encode)
    function codeToRef(code) {
        try {
            var v = parseInt(String(code || '').toLowerCase(), 36);
            return (v && v > 0) ? v : 0;
        } catch (e) { return 0; }
    }

    // Join = validate the code against the board, then the JOINER signs
    // join_match gasless on the ER (their wallet + handle land in the seat).
    async function join(gameId, code, seat, handle) {
        var ref = codeToRef(code);
        if (!ref) { emitError('join', 'invalid code'); return { okay: false, error: 'invalid code (expected base36 match ref)' }; }
        var s = await state(ref);
        if (!s || !s.ok) { emitError('join', s.error || 'no open match with that code'); return { okay: false, error: 'no open match with that code' }; }
        if (s.status !== 0) { emitError('join', 'match already started'); return { okay: false, error: 'match already started - no new joins' }; }
        var si = (typeof seat === 'number') ? seat : -1;
        if (si === -1) {
            // Auto-pick the first free seat.
            for (var i = 0; i < (s.seats || 2); i++) {
                if (!(s.players || [])[i]) { si = i; break; }
            }
            if (si === -1) { emitError('join', 'all seats taken'); return { okay: false, error: 'all seats are taken' }; }
        }
        var md = dice();
        if (!md || typeof md.joinBoardMatch !== 'function') {
            emitError('join', 'on-chain rail not ready on this device');
            return { okay: false, error: 'on-chain rail not ready on this device' };
        }
        try {
            await md.joinBoardMatch(gameId || GAME, ref, si, handle);
            return { okay: true, matchRef: ref, pda: s.pda, seat: si };
        } catch (e) {
            emitError('join', e);
            return { okay: false, error: (e && e.message) || String(e) };
        }
    }

    // ---- moves (gasless ER, PLAYER signs) ----
    function commitMove(move, moveHash) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        var seat = (move && typeof move.seat === 'number') ? move.seat : 0;
        if (!ref) { emitError('commitMove', 'no matchRef'); return Promise.resolve({ okay: false, error: 'no matchRef' }); }
        var md = dice();
        if (!md || typeof md.commitBoardMove !== 'function') {
            emitError('commitMove', 'on-chain rail not ready on this device');
            return Promise.resolve({ okay: false, error: 'on-chain rail not ready' });
        }
        return md.commitBoardMove(gameId, ref, seat, moveHash).then(function (r) {
            return r && r.ok ? { okay: true, sig: r.sig } : { okay: false, error: (r && r.error) || 'commit failed' };
        }).catch(function (e) {
            emitError('commitMove', e);
            return { okay: false, error: (e && e.message) || String(e) };
        });
    }

    // ---- subscribe: poll the board on the ER for opponent moves ----
    // Fires on move_count CHANGE, on begin (status 0->1), and on finish
    // (winner_seat set) so BOTH devices see start + result in real time.
    function subscribe(matchRef, onUpdate, onError, pollMs) {
        pollMs = pollMs || 1200;
        var seen = -1;
        var seenStatus = null;
        var seenWinner = null;
        var stop = false;
        (function loop() {
            if (stop) return;
            api('state', { game: GAME, matchRef: matchRef }).then(function (s) {
                if (stop) return;
                if (s && s.ok) {
                    var changed = (s.move_count !== seen) || (s.status !== seenStatus) || (s.winner_seat !== seenWinner);
                    if (changed) {
                        seen = s.move_count;
                        seenStatus = s.status;
                        seenWinner = s.winner_seat;
                        onUpdate(s);
                    }
                } else if (onError) { onError(s && s.error || 'board state unavailable'); }
                setTimeout(loop, pollMs);
            }).catch(function () { if (!stop) setTimeout(loop, pollMs); });
        })();
        return function () { stop = true; };
    }

    // ---- finish ----
    async function finish(move, winnerSeat) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        if (!ref) { emitError('finish', 'no matchRef'); return { okay: false, error: 'no matchRef' }; }
        var md = dice();
        if (!md || typeof md.finishBoardMatch !== 'function') {
            emitError('finish', 'on-chain rail not ready on this device');
            return { okay: false, error: 'on-chain rail not ready' };
        }
        try {
            var r = await md.finishBoardMatch(gameId, ref, winnerSeat);
            return r && r.ok ? { okay: true, sig: r.sig } : { okay: false, error: (r && r.error) || 'finish failed' };
        } catch (e) {
            emitError('finish', e);
            return { okay: false, error: (e && e.message) || String(e) };
        }
    }

    async function state(matchRef) {
        var r = await api('state', { game: GAME, matchRef: matchRef });
        return r && r.ok ? r : null;
    }

    // ---- arc2m1 turn timer (Option B): permissionless force-pass of a lapsed
    // turn. The rail stays game-agnostic - it only transports the action to the
    // game-core SDK (magicblockDice.expireBoardTurn); the PROGRAM verifies the
    // active seat's deadline has genuinely passed, so this is a safe safety net
    // for a player who never moves. Normal play re-stamps the deadline in
    // commit_move, so active turns are unaffected. Synchronized counter-approval.
    async function expireTurn(matchRef) {
        var ref = Number(matchRef);
        if (!ref) { emitError('expireTurn', 'no matchRef'); return { okay: false, error: 'no matchRef' }; }
        var md = dice();
        if (!md || typeof md.expireBoardTurn !== 'function') {
            emitError('expireTurn', 'on-chain timer not ready on this device');
            return { okay: false, error: 'on-chain timer not ready' };
        }
        try {
            var r = await md.expireBoardTurn(GAME, ref);
            return r && r.ok ? { okay: true, sig: r.sig } : { okay: false, error: (r && r.error) || 'expire failed' };
        } catch (e) {
            emitError('expireTurn', e);
            return { okay: false, error: (e && e.message) || String(e) };
        }
    }

    // ---- begin (host starts the live match; status 0 -> 1; host signs) ----
    async function begin(move) {
        var gameId = (move && move.gameId) || GAME;
        var ref = move && move.matchRef;
        if (!ref) { emitError('begin', 'no matchRef'); return { okay: false, error: 'no matchRef' }; }
        var md = dice();
        if (!md || typeof md.beginBoardMatch !== 'function') {
            emitError('begin', 'on-chain rail not ready on this device');
            return { okay: false, error: 'on-chain rail not ready' };
        }
        try {
            var r = await md.beginBoardMatch(gameId, ref);
            return r && r.ok ? { okay: true, started: true } : { okay: false, error: (r && r.error) || 'begin failed' };
        } catch (e) {
            emitError('begin', e);
            return { okay: false, error: (e && e.message) || String(e) };
        }
    }

    window.gfgMultiplayer = {
        create: create,
        join: join,
        begin: begin,
        commitMove: commitMove,
        subscribe: subscribe,
        finish: finish,
        state: state,
        expireTurn: expireTurn,
        hash32: function (s) {
            var out = new Uint8Array(32);
            var src = String(s || '') + '|' + Date.now();
            for (var i = 0; i < 32; i++) { out[i] = (i < src.length) ? (src.charCodeAt(i) % 256) : 0; }
            return Array.from(out);
        },
        GAME: GAME,
    };

    log('multiplayer rail loaded (M12, game-agnostic, player-signed gasless ER)');
})();