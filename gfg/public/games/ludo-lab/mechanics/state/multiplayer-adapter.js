// public/games/ludo-lab/mechanics/state/multiplayer-adapter.js
// M12 arc2m12b — Ludo ADAPTER for the universal multiplayer rail.
//
// The rail stays game-agnostic (it only commits 32-byte move checkpoints to
// the delegated board). THIS adapter knows Ludo: it serializes a move into the
// 32 bytes so the OPPONENT can decode and replay it, and it drives the
// local game when an opponent's move arrives. Other games write their own
// adapter against the same rail + this shape.
//
// Encoding (32 bytes):
//   byte0 seat(0-3), byte1 die1, byte2 die2, byte3 tokenIndex,
//   byte4 fromPathIndex, byte5 toPathIndex, byte6 moveNumberCooldown(<=120),
//   rest zeros. The opponent replays: tokenIndex at fromPathIndex ->
//   toPathIndex (a position on the common path), which is deterministic.
//
// SAFETY: soft-fail. If multiplayer is off or the chain is unreachable, the
// game plays exactly as before (Solo unchanged). Never throws into game code.
(function () {
    var active = false;
    var matchRef = 0;
    var mySeat = -1;          // which seat index this device controls
    var seatCount = 2;        // multiplayer seat count (2 = green,red; 4 = all)
    var movedThisTurn = false; // set when a real move committed this turn
    var unsub = null;
    var lastCount = -1;
    var dimmed = false;       // true to ignore opponent turns until they move
    // arc2m1 turn timer: one-shot guards so a lapsed seat is expired ONCE per
    // window (the program re-stamps the deadline on every real move, so an active
    // seat never trips this).

    function log() { try { console.log.apply(console, ['[MP/LUDO]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
    function rail() { return window.gfgMultiplayer; }
    // Seat index -> Ludo color: the game's ACTIVE colour order is the source of
    // truth (the board the game actually plays). When the game is configured
    // (activeSeats set via the colour picker), seat i == activeSeats[i], so the
    // on-chain seat and the colour picker are the SAME thing. Before the game
    // locks, fall back to a deterministic order from the seat count (2P:
    // green,red; 4P: all four) so both devices agree on the committed byte.
    function activeOrder() {
        try {
            if (typeof window.getActiveSeats === 'function') {
                var a = window.getActiveSeats();
                if (a && a.length >= 2) return a.slice(0, Math.min(a.length, 4));
            }
        } catch (e) { /* soft */ }
        if (seatCount === 4) return ['green', 'yellow', 'blue', 'red'];
        return ['green', 'red'];
    }
    function seatOf(color) { var o = activeOrder(); var i = o.indexOf(color || 'green'); return i >= 0 ? i : 0; }
    function colorOf(i) { var o = activeOrder(); return o[i] || 'green'; }

    // ---- BOARD SNAPSHOT COMMIT (the single shared board) ----
// The commit is a full BOARD STATE, not a single move. byte0 seat, byte1 die1,
// byte2 die2, bytes3..18 = each token's stepsWalked (0..57) in the fixed
// order green[0..3], yellow[0..3], blue[0..3], red[0..3], byte19 = whose turn
// (colorOf index). Both devices therefore reconstruct the ENTIRE board from the
// same 32 bytes - identical positions, dice, and turn by construction. The
// game's own rendering (pathIndex/c/r) is derived from stepsWalked exactly like
// movement.js does, so the board always matches.
var SNAPSHOT_COLORS = ['green', 'yellow', 'blue', 'red'];

// ---- BOARD SNAPSHOT COMMIT encoding: PATHINDEX (real board cell), not steps ----
// Encode each token as its ACTUAL position the game uses:
//   pathIndex -2 (home lane) -> 64 + (stepsWalked - 52)  => 64..69 (lane/win)
//   pathIndex -1 (yard)       -> 80
//   otherwise (track)         -> pathIndex              => 0..51
// This removes TWO bugs of encoding stepsWalked:
//   1) a token released from the yard has stepsWalked 0 (same as a yard token),
//      so receivers re-yarded it -> GREEN tokens vanished / wiped by B's snapshot.
//   2) on-track position is START_INDEX + stepsWalked, so COMMON_PATH[stepsWalked]
//      teleported RED to GREEN's opposite box.
var SNAPSHOT_YARD = 80;      // yard marker
var SNAPSHOT_LANE_BASE = 64; // 64..69 = home-lane stepsWalked 52..57

function tokenEncode(tok) {
    if (!tok) return SNAPSHOT_YARD;
    var p = (typeof tok.pathIndex === 'number') ? tok.pathIndex : -1;
    if (p === -1) return SNAPSHOT_YARD;
    if (p === -2) {
        var sw = (typeof tok.stepsWalked === 'number') ? tok.stepsWalked : 55;
        return SNAPSHOT_LANE_BASE + (sw - 52);
    }
    return (p & 0xff);
}

function snapshotFromTokens() {
    var sw = [];
    for (var c = 0; c < 4; c++) {
        var col = SNAPSHOT_COLORS[c];
        var toks = (window.tokens && window.tokens[col]) || [];
        for (var t = 0; t < 4; t++) {
            sw.push(tokenEncode(toks[t]));
        }
    }
    return sw;
}

// encode the WHOLE board into a 32-byte commit. byte0 seat, byte1-2 dice,
// bytes3..18 = tokenEncode positions (real board cells), byte19 = next turn.
// `advance`: true only on the turn-pass commit (real move commits stay on the
// current seat so a mid-turn snapshot NEVER flips the turn to the opponent).
function encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked, advance) {
    var m = [];
    for (var i = 0; i < 32; i++) m[i] = 0;
    m[0] = seatOf(window.getGameCurrentTurn ? window.getGameCurrentTurn() : (window.currentTurn || 'green'));
    m[1] = (typeof die1 === 'number' ? die1 : 0) & 0xff;
    m[2] = (typeof die2 === 'number' ? die2 : 0) & 0xff;
    var sw = snapshotFromTokens();
    for (var s = 0; s < 16 && s < sw.length; s++) m[3 + s] = (sw[s] & 0xff);
    var me = m[0];
    if (!advance) {
        m[19] = me; // mid-turn (dice + move snapshots): turn does NOT move yet
        return m;
    }
    // advance=true is ONLY ever used by onPassTurn - a REAL turn pass. The turn
    // must ALWAYS move to the next seat here. Double-six "shoki" bonuses are
    // conveyed by NOT passing (the roller stays local + commits no pass), never
    // by a pass carve-out: on the 3rd consecutive double-six the pass DOES
    // happen, and passing the real dice values here must not re-grant a bonus.
    m[19] = (me + 1) % (seatCount === 4 ? 4 : 2);
    return m;
}

// decode a 32-byte commit into a full board snapshot
function decodeMove(bytes) {
    if (!bytes || bytes.length < 3) return null;
    try {
        var sw = [];
        for (var i = 0; i < 16; i++) sw.push(bytes[3 + i] || 0);
        return {
            seat: bytes[0],
            die1: bytes[1],
            die2: bytes[2],
            steps: sw,
            turnSeat: (bytes[19] !== undefined) ? bytes[19] : bytes[0],
        };
    } catch (e) { return null; }
}

// Reconstruct a token from the committed ENCODED position (tokenEncode scheme).
// Mirrors movement.js: 80=yard; 64..69=home-lane(stepsWalked 52..57) via pathIndex
// -2 + lane offsets; 0..51=track where stepsWalked = pathIndex - START_INDEX.
function positionToken(token, enc, color, tIdx) {
    var HY = (typeof HOME_YARDS !== 'undefined') ? HOME_YARDS : null;
    var CP = (typeof COMMON_PATH !== 'undefined') ? COMMON_PATH : null;
    var SI = (typeof START_INDEX !== 'undefined') ? START_INDEX : null;

    if (enc === SNAPSHOT_YARD) {
        token.pathIndex = -1;
        token.stepsWalked = 0;
        if (HY && HY[color] && HY[color][tIdx]) { token.c = HY[color][tIdx].c; token.r = HY[color][tIdx].r; }
        return;
    }
    if (enc >= SNAPSHOT_LANE_BASE && enc <= SNAPSHOT_LANE_BASE + 5) {
        var sw = 52 + (enc - SNAPSHOT_LANE_BASE);
        token.stepsWalked = sw;
        token.pathIndex = -2;
        var laneOffset = sw - 51;
        if (color === 'green') { token.c = laneOffset; token.r = 7; }
        else if (color === 'yellow') { token.c = 7; token.r = laneOffset; }
        else if (color === 'blue') { token.c = 14 - laneOffset; token.r = 7; }
        else if (color === 'red') { token.c = 7; token.r = 14 - laneOffset; }
        return;
    }
    if (enc >= 0 && enc < 52 && CP && SI) {
        token.pathIndex = enc;
        // Game track position = pathIndex, stepsWalked = distance from the
        // color's start tile (STARTS_INDEX offsets the path).
        token.stepsWalked = (enc - (SI[color] || 0) + 52) % 52;
        if (CP[enc]) { token.c = CP[enc].c; token.r = CP[enc].r; }
        return;
    }
    // Fallback: keep as-is (unknown encoding) - never touch an existing token.
}

// Edge: does the incoming snapshot differ from the CURRENT board? A dice-only
// commit carries the SAME positions as the board when the roll was made (just
// dice flags), so the receiver can tell "roll happened" (show dice + arm blink)
// from "a token actually moved" (update tokens only). This mirrors singleplayer:
// dice show, then the core blink appears for the current turn's moveable tokens.
function snapshotDiffers(move) {
    if (!move || !Array.isArray(move.steps)) return false;
    var cur = snapshotFromTokens();
    for (var i = 0; i < 16 && i < move.steps.length && i < cur.length; i++) {
        if ((move.steps[i] || 0) !== cur[i]) return true;
    }
    return false;
}

// apply a committed snapshot to the local board (deterministic).
// Returns true when the move finished the opponent; 'not-ready' if board is up.
function applyMove(move) {
    var won = false;
    try {
        if (!window.tokens) return 'not-ready';
        // PHANTOM-BOARD GUARD: a real commit ALWAYS carries dice (byte1/2 > 0)
        // and a meaningful board. An all-zero / all-home snapshot (fresh board
        // with move_count 0, or a decoded default) must NEVER be applied - doing
        // so decodes every token to pathIndex 0 (GREEN's release safe-box) and
        // stacks all 4 GREEN + 4 RED there. Skip it ('not-ready') so the next
        // poll retries the real board, keeping the home yards on join/refresh.
        var hasDice = !!(move && move.die1 > 0 && move.die2 > 0);
        if (!hasDice && move && Array.isArray(move.steps)) {
            var anyReal = false;
            for (var _i = 0; _i < move.steps.length; _i++) {
                var _v = move.steps[_i] || 0;
                if (_v !== 0 && _v !== SNAPSHOT_YARD) { anyReal = true; break; }
            }
            if (!anyReal) return 'not-ready';
        }
        var wasDiceCommit = !snapshotDiffers(move);
        // Reconstruct EVERY token from the snapshot - no move replay needed.
        var anyMissing = false;
        for (var c = 0; c < 4; c++) {
            var col = SNAPSHOT_COLORS[c];
            var toks = window.tokens[col] || [];
            for (var t = 0; t < 4; t++) {
                if (!toks[t]) { anyMissing = true; continue; }
                var swv = move.steps ? move.steps[c * 4 + t] : 0;
                positionToken(toks[t], swv, col, t);
            }
        }
        if (anyMissing) return 'not-ready';
        // Shared dice: only a DICE commit (positions unchanged) mirrors the roll
        // onto this device AND arms the blink window. A real move commit just
        // updates tokens (no re-show of dice); a pass commit just advances.
        if (wasDiceCommit && move.die1 > 0 && move.die2 > 0 && typeof window.showRemoteDice === 'function') {
            try { window.showRemoteDice(move.die1, move.die2); } catch (e) { /* soft */ }
        }
        // Fire wins deterministically: any token at 57 after the snapshot is a
        // finished seat (the snapshot is the truth, so we can see it directly).
        var finishedAny = false;
        for (var c2 = 0; c2 < 4; c2++) {
            var col2 = SNAPSHOT_COLORS[c2];
            var toks2 = window.tokens[col2] || [];
            var allHome = true;
            for (var t2 = 0; t2 < 4; t2++) {
                if (!(toks2[t2] && toks2[t2].stepsWalked >= 57)) allHome = false;
            }
            if (allHome && typeof window.checkForMatchWinner === 'function') {
                try { window.checkForMatchWinner(col2); } catch (e) { /* soft */ }
                finishedAny = true;
            }
        }
        if (typeof window.drawLudoLayout === 'function') window.drawLudoLayout();
        if (typeof window.saveGameStateToStorage === 'function') window.saveGameStateToStorage();
        log('applied snapshot seat=' + move.seat + ' die=' + move.die1 + '+' + move.die2 + (finishedAny ? ' (finish detected)' : ''));
    } catch (e) { log('apply err ' + e.message); }
    return won || finishedAny;
}

    // ---- multiplayer session ----
    function resolveHost() {
        // getDynamicSolanaWallet() returns the wallet ADDRESS as a plain string
        // (src/dynamic-auth.js), so accept string/object + profile fallbacks.
        try {
            if (window.gfgChain && typeof window.gfgChain.isArc === 'function' && window.gfgChain.isArc()) {
                // Arc rail: ONLY the EVM wallet is valid here. No Solana fallback.
                var wa = (typeof window.gfgChain.walletAddress === 'function') ? window.gfgChain.walletAddress() : null;
                return (typeof wa === 'string' && wa) ? wa : null;
            }
            if (window.getDynamicSolanaWallet && typeof window.getDynamicSolanaWallet === 'function') {
                var w = window.getDynamicSolanaWallet();
                if (typeof w === 'string' && w) return w;
                if (w && w.publicKey) return String(w.publicKey);
                if (w && w.address) return String(w.address);
            }
        } catch (e) { /* soft */ }
        try {
            if (window.currentProfile && window.currentProfile.solana_wallet) return String(window.currentProfile.solana_wallet);
        } catch (e) { /* soft */ }
        return null;
    }

    function start(gameId, players, seats, turnSecs, maxSecs, chosenSeat) {
        if (!rail()) { log('rail not loaded'); return Promise.resolve(null); }
        // A live multiplayer match is shared - a stale SOLO save on this device
        // must never resurrect divergent local turn/token state.
        if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
        mySeat = (typeof chosenSeat === 'number') ? chosenSeat : 0;
        seatCount = (typeof seats === 'number' && seats === 4) ? 4 : 2;
        // arc2m1 timer: the PROGRAM is the single source of truth for turn_secs
        // (DEFAULT_TURN_SECS on-chain). The client does NOT decide the duration -
        // 0 is sent and the program enforces its own value, so no off-chain
        // fallback can inject a different timer across devices or frontends.
        return rail().create({ gameId: gameId || 1, host: resolveHost(), seats: seats || 2, turnSecs: 0, maxMatchSecs: maxSecs || 3600 }).then(function (r) {
            if (!r.okay) { log('create failed', r.error); if (r.error && typeof window.mpSetStatus === 'function') window.mpSetStatus('Create failed: ' + r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            lastCount = -1;
            dimmed = false;
            unsub = subscribeBoard();
            log('match created code=' + r.code + ' ref=' + matchRef + ' mySeat=' + mySeat);
            bindSeats();
            return r;
        });
    }

    // Shared on-chain board subscription used by create/join/resume. It:
    //   - surfaces begin status so a joiner's local board starts once;
    //   - acts ONLY on NEW remote commits (monotonic move_count) - this is the
    //     fix for the non-double-six double-turn: a late in-flight OWN move
    //     snapshot (byte19 = our seat) landing after we passed can never revert
    //     our turn, because our own commits only bump the count;
    //   - syncs the turn + replays the board for remote commits only.
    function subscribeBoard() {
        return rail().subscribe(matchRef, function (s) {
            try {
                if (!s || typeof s.move_count !== 'number') return;
                rememberSeats(s);
                // FINISH propagation (4.1): the match ended on-chain (finish_match
                // set status=2 + winner_seat). The WINNER already finished + fired
                // its win UX; the OTHER devices may not have a pending move_count
                // bump to wake them, so they would stay stuck waiting on a turn
                // that will never come. Fire the local finish here so EVERY device
                // completes + shows the result. Guarded per-match (once).
                if (s.status === 2 || (typeof s.winner_seat === 'number' && s.winner_seat !== 255)) {
                    if (window.__mpSawFinish !== matchRef) {
                        window.__mpSawFinish = matchRef;
                        lastCount = s.move_count;   // absorb any trailing commit
                        dimmed = false;
                        try {
                            // The winner's device already finished + fired the
                            // win UX. Here (a RECEIVING device) we complete the
                            // LOCAL match from the on-chain board truth so this
                            // player's own seats are credited at their wallets
                            // and nobody stays stuck waiting for a turn.
                            if (typeof window.gfgCompleteMatchFromBoard === 'function') {
                                window.gfgCompleteMatchFromBoard(s.winner_seat);
                            }
                        } catch (e) { log('finish propagation error', (e && e.message) || e); }
                    }
                    return;
                }
                // Begin status (0->1) fires regardless of move_count: the
                // JOINER uses it to start its own local board exactly once.
                if (s.status === 1 && window.__mpRoom && window.__mpRoom.started !== true) {
                    try { if (window.__mpRoom) window.__mpRoom.started = true; } catch (e) {}
                    if (!window.__mpJoinedStarted) {
                        window.__mpJoinedStarted = true;
                        try { if (typeof window.__mpSyncSeats === "function" && typeof s.seats === "number") window.__mpSyncSeats(s.seats); var _js = (window.__mpOrigStart && typeof window.__mpOrigStart === "function") ? window.__mpOrigStart : window.initiateArenaMatch; if (typeof _js === "function") _js(); } catch (e) {}
                    }
                }
                // Monotonic guard: only NEW commits (higher move_count) are
                // acted on. A delayed in-flight move snapshot polled late
                // must NEVER re-apply/re-sync over a newer one.
                if (s.move_count <= lastCount) return;
                if (s.move_count === 0) { lastCount = 0; return; } // no real move yet - skip the all-zero initial commit to avoid a phantom board
                var mv = decodeMove(s.last_move_commit);
                // arc2m1 turn timer (Option B): the on-chain expire_turn emits a
                // marker whose byte0 = 255 (not a real seat) + byte19 = the seat
                // that is next to play after a timeout-advance. The board is
                // otherwise UNCHANGED (no token moved), so we only advance the
                // sync'd turn - never re-apply a phantom snapshot.
                if (mv && mv.seat === 255) {
                    syncTurnFromBoard(s);
                    lastCount = s.move_count;
                    dimmed = false;
                    var st2 = (window.getGameCurrentTurn && window.getGameCurrentTurn()) || '';
                    if (st2 === color()) {
                        if (typeof window.cancelRemoteDiceWindow === 'function') { try { window.cancelRemoteDiceWindow(); } catch (e) {} }
                        try { if (window.resetTurnForRoll && typeof window.resetTurnForRoll === 'function') window.resetTurnForRoll(); } catch (e) {}
                    }
                    return;
                }
                if (mv && mv.seat !== mySeat) {
                    // REMOTE commit: sync our turn + replay the board. The
                    // committed byte19 + board are the single source of truth,
                    // so both devices derive the SAME next turn.
                    syncTurnFromBoard(s);
                    var applied = applyMove(mv);
                    if (applied === 'not-ready') {
                        // Board not up yet: don't advance lastCount - the
                        // next poll retries this same commit.
                        dimmed = false;
                        return;
                    }
                    lastCount = s.move_count;
                    dimmed = false;
                    // Only reset the ROLL flags when the shared turn is now OUR
                    // seat (a remote pass just handed us the turn). During the
                    // remote player's own turn (their dice/move commits), the
                    // core blink state we feed (currentTurnMoves / isDiceRolled)
                    // must SURVIVE so the opponent sees their moveable tokens.
                    var sharedTurn = (window.getGameCurrentTurn && window.getGameCurrentTurn()) || '';
                    if (sharedTurn === color()) {
                        // Cancel any pending remote-dice blink window so the
                        // remote's dice never leak into OUR token blink, then
                        // reset the roll flags for our fresh turn.
                        if (typeof window.cancelRemoteDiceWindow === 'function') {
                            try { window.cancelRemoteDiceWindow(); } catch (e) {}
                        }
                        try {
                            if (window.resetTurnForRoll && typeof window.resetTurnForRoll === 'function') window.resetTurnForRoll();
                        } catch (e) { /* soft */ }
                    }
                } else {
                    // Our OWN commit: bump the count ONLY. The roller's LOCAL
                    // game is authoritative for its own turn (passTurnSequence
                    // already advanced it correctly). Re-syncing the turn from
                    // the board here caused the "flash" bug: the local pass
                    // happens ~2-4s BEFORE the serialized pass commit lands
                    // on-chain, so a poll mid-window saw our own stale mid-turn
                    // move commit (byte19 = our seat) and flashed our colour
                    // back for a few seconds. A click in that window desynced
                    // the match. Own commits never move our own displayed turn.
                    lastCount = s.move_count;
                }
            } catch (e) { log('listen err ' + e.message); }
        });
    }

    // M12 REJOIN/RESUME: a player who ALREADY has a seat in a live on-chain
    // match returns to it after a page reload (or from another device under the
    // same wallet) WITHOUT a new join (join is blocked once status = 1). It
    // re-establishes the adapter session + subscription from the board and
    // replays the latest committed snapshot so tokens/moves/turn come back.
    // A brand-new player (no seat) is still rejected - they must use the normal
    // join path while the match is still open.
    function resume(matchRefOrCode, seat) {
        if (!rail()) return Promise.resolve(null);
        var ref = (typeof matchRefOrCode === 'number' && matchRefOrCode > 0)
            ? matchRefOrCode
            : (function () { try { var v = parseInt(String(matchRefOrCode || '').toLowerCase(), 36); return (v && v > 0) ? v : 0; } catch (e) { return 0; } })();
        if (!ref) return Promise.resolve(null);
        return rail().state(ref).then(function (s) {
            if (!s || !s.ok) { log('resume: board not found'); return null; }
            var wallet = resolveHost();
            // Find OUR seat from the board players list (the authoritative
            // on-chain identity). If we are not seated, refuse (join is blocked).
            var mine = -1;
            if (Array.isArray(s.players)) {
                for (var i = 0; i < s.players.length; i++) {
                    if (s.players[i] && wallet && s.players[i] === wallet) { mine = i; break; }
                }
            }
            if (mine === -1) {
                log('resume: caller has no seat in this match - rejected');
                if (typeof window.mpSetStatus === 'function') window.mpSetStatus('You are not in this match - you can only rejoin a match you already joined.');
                return null;
            }
            active = true;
            matchRef = ref;
            mySeat = (typeof seat === 'number' && seat >= 0) ? seat : mine;
            seatCount = (typeof s.seats === 'number' && s.seats === 4) ? 4 : 2;
            lastCount = -1;
            dimmed = false;
            if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
            rememberSeats(s);
            bindSeats();
            unsub = subscribeBoard();
            // If the LOCAL board is already started (e.g. the host's device had
            // its board live when it reloaded and persistence re-locked setup),
            // apply the committed snapshot directly. Otherwise leave lastCount=-1
            // and let the page start the local board (mpResumeBoard) - the next
            // poll then applies the snapshot fresh, in the correct order.
            var boardLocked = (typeof setupConfigurationLocked === 'boolean') && setupConfigurationLocked;
            if (s.status === 1 && s.move_count > 0 && boardLocked) {
                var mv = decodeMove(s.last_move_commit);
                if (mv) {
                    lastCount = s.move_count;
                    syncTurnFromBoard(s);
                    applyMove(mv);
                }
            }
            log('resumed ref=' + ref + ' mySeat=' + mySeat + ' status=' + s.status + ' move=' + s.move_count);
            return { okay: true, matchRef: ref, seat: mySeat, seatCount: seatCount, status: s.status };
        });
    }

    function join(gameId, code, chosenSeat) {
        if (!rail()) return Promise.resolve(null);
        // A live multiplayer match is shared - a stale SOLO save on this device
        // must never resurrect divergent local turn/token state.
        if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
        // Joiner seat count: match the lobby room's seat count when available.
        try { if (window.__mpRoom && window.__mpRoom.seats === 4) seatCount = 4; } catch (e) {}
        var handle = '';
        try { if (window.__mpHandle && typeof window.__mpHandle === 'function') handle = window.__mpHandle() || ''; } catch (e) {}
        return rail().join(gameId || 1, code, (typeof chosenSeat === 'number') ? chosenSeat : undefined, handle).then(function (r) {
            if (!r.okay) { log('join failed', r.error); if (r.error && typeof window.mpSetStatus === 'function') window.mpSetStatus('Join failed: ' + r.error); return null; }
            active = true;
            matchRef = r.matchRef;
            // mySeat comes from the on-chain join result (the free seat chosen).
            mySeat = (typeof r.seat === 'number') ? r.seat : ((typeof chosenSeat === 'number') ? chosenSeat : 1);
            lastCount = -1;
            unsub = subscribeBoard();
            log('joined ref=' + matchRef + ' mySeat=' + mySeat);
            bindSeats();
            return r;
        });
    }

    function isActive() { return active; }
    function ref() { return matchRef; }
    function seat() { return mySeat; }
    function color() { return colorOf(mySeat); }
    // On-chain identity (wallet + handle) per seat, populated from the board
    // state so the UI + M2 seam can display "You - <handle>" vs "<handle>".
    var seatWallets = [];  // index -> wallet base58 (or empty)
    var seatHandles = [];  // index -> sitewide handle
    function rememberSeats(s) {
        try {
            if (s && Array.isArray(s.players)) seatWallets = s.players.slice();
            if (s && Array.isArray(s.handles)) seatHandles = s.handles.slice();
        } catch (e) { /* soft */ }
    }
    function players() { return seatWallets.slice(); }
    function handles() { return seatHandles.slice(); }

    // BOARD-SYNCED TURN + MOVE: the on-chain board is the single source of
    // truth. Commit writes store: seat that moved, its dice, and the board's
    // current_turn (= the seat that last moved). BOTH devices derive the next
    // turn from the SAME committed data - never a local guess:
    //   - double-six roll (up to 3 in a row) -> the SAME seat rolls again;
    //   - anything else -> the NEXT seat in the active order.
    // This makes the display turn, the dice values, and whose roll it is
    // identical on every phone, because they all come from the same bytes.
    function turnFromBoard(s) {
        try {
            if (!s || typeof s.current_turn !== 'number') return null;
            if (s.current_turn === 255) return null; // none yet -> host rolls first
            var order = activeOrder();
            if (!order || order.length < 2) return null;
            // The commit carries the committing device's AUTHORITATIVE next turn
            // (byte19) + the full board snapshot. Prefer it - no derivation on
            // the receiving phone. Fall back to the d6 rule from the dice.
            var mv = decodeMove(s.last_move_commit);
            if (mv && typeof mv.turnSeat === 'number' && mv.turnSeat < order.length) {
                return order[mv.turnSeat % order.length];
            }
            var seatThatMoved = (mv && typeof mv.seat === 'number') ? mv.seat : s.current_turn;
            var d6 = !!(mv && ((mv.die1 > 0 && mv.die1 === 6) && (mv.die2 > 0 && mv.die2 === 6)));
            if (d6) return order[seatThatMoved % order.length]; // same seat again
            return order[(seatThatMoved + 1) % order.length];
        } catch (e) { return null; }
    }
    // Force the local game onto the board-synced turn (display indicator + the
    // lexical `currentTurn` the rolls read). No-op when already on it.
    function syncTurnFromBoard(s) {
        var c = turnFromBoard(s);
        if (!c) return false;
        var got = (window.getGameCurrentTurn && window.getGameCurrentTurn()) || '';
        if (got === c) return true;
        // A new turn began -> the per-turn 'did we move?' flag resets so the
        // next turn-ending pass commit works even after a zero-move turn.
        movedThisTurn = false;
        if (window.setGameCurrentTurn) { try { window.setGameCurrentTurn(c); } catch (e) {} }
        var ti = document.getElementById('turn-indicator');
        if (ti) {
            var cm = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };
            ti.innerText = c.charAt(0).toUpperCase() + c.slice(1) + "'s Turn";
            ti.style.color = cm[c] || '#2ecc71';
        }
        return true;
    }

    // MULTIPLAYER SEAT BINDING: this device controls `mySeat` (mode 'human' +
    // isUser so the "You" seat is the local player). Every OTHER active seat is
    // set to remote-human (mode 'human', isUser false): it is controlled by its
    // own device, never by local AI, and gfgRemoteTurn blocks local rolls for
    // it. Solo is untouched because this only runs when the rail is active.
    // The game objects (ping turn/seat pickers) are not rewritten - we only
    // nudge the runtime seat modes the AI engine consults.
    function bindSeats(activeColors) {
        try {
            if (!window.playerProfiles) return;
            var me = color();
            var act = (activeColors && activeColors.length) ? activeColors : activeOrder();
            act.forEach(function (c) {
                if (!window.playerProfiles[c]) return;
                if (c === me) {
                    window.playerProfiles[c].mode = 'human';
                    window.playerProfiles[c].isUser = true;
                } else {
                    // Remote seats show as human (never computer/AI), but are
                    // marked NOT the signed-in user so they never earn as 'user'
                    // on THIS device (their own device earns for them).
                    window.playerProfiles[c].mode = 'human';
                    window.playerProfiles[c].isUser = false;
                }
            });
        } catch (e) { /* soft */ }
    }

    // HOST-ONLY: begin the live match (status 0 -> 1), locking out new joins.
    // The host MUST be players[0] (resolved at create); the rail signs the
    // begin with THIS device's session key (program enforces seat 0 authority).
    function begin() {
        if (!active || !matchRef) return Promise.resolve({ okay: false, error: 'not in a match' });
        if (mySeat !== 0) return Promise.resolve({ okay: false, error: 'only the host can start' });
        return rail().begin({ gameId: 1, matchRef: matchRef }).then(function (r) {
            if (r && r.okay) log('match begun');
            else if (r && r.error) { log('begin failed', r.error); if (typeof window.mpSetStatus === 'function') window.mpSetStatus('Start failed: ' + r.error); }
            return r;
        });
    }

    // Serialized commit chain: every gasless board write (dice/move/pass) is sent
// ONE AT A TIME, each awaiting the previous one's confirmation. This is the
// fix for the game getting stuck / players getting double turns: without it,
// each commit retried independently, so a mid-turn move snapshot (byte19 =
// current seat) could LAND ON-CHAIN AFTER the turn-pass (byte19 = next seat).
// The board's "latest" then became the stale mid-turn snapshot -> the opponent
// derived the WRONG turn (green) while the roller had already passed to red,
// so BOTH devices waited for each other forever. Serializing guarantees the
// pass is ALWAYS the last write of a turn, so every device derives the same
// turn from the same board. Two independent rolls in one turn chain naturally
// (dice1 -> move1 -> move2 -> pass), and a double-6 bonus is just another roll.
var commitChain = Promise.resolve();

function commitSnapshot(bytes, label) {
    if (!active || !matchRef) return Promise.resolve();
    if (!bytes || !bytes.length) return Promise.resolve();
    var refObj = { gameId: 1, matchRef: matchRef, seat: bytes[0] & 0xff };
    // Chain this write behind all pending writes so order is preserved.
    var run = commitChain.then(function () {
        if (!active || !matchRef) return;
        var attempts = 0;
        return new Promise(function (resolve) {
            var commitLoop = function () {
                attempts++;
                var settled = false;
                var settle = function (err) {
                    if (settled) return; settled = true;
                    if (err) {
                        log(label + ' commit attempt ' + attempts + ' FAILED: ' + err);
                        if (attempts < 3) { setTimeout(commitLoop, 1200); return; }
                        try { window.dispatchEvent(new CustomEvent('gfg:mp-error', { detail: { action: 'commitMove', error: 'on-chain commit failed: ' + err } })); } catch (e) {}
                    } else {
                        log(label + ' committed on-chain seat=' + refObj.seat + ' sig=' + (resolve._sig || ''));
                    }
                    resolve();
                };
                rail().commitMove(refObj, bytes).then(function (r) {
                    if (r && r.okay) { resolve._sig = r.sig; settle(); }
                    else settle((r && r.error) || 'no result');
                }).catch(function (e) {
                    settle((e && e.message) || String(e));
                });
                setTimeout(function () { settle('timed out (no response after 14s)'); }, 14000);
            };
            commitLoop();
        });
    });
    // Ensure a failure never blocks the chain permanently.
    commitChain = run.catch(function () {});
    return run;
}

// LIVE dice commit: when the local player rolls, immediately push a snapshot
// (byte19 = current seat, advance=false) so the opponent sees the dice + board
// in real time, BEFORE any token moves. The turn is NOT advanced.
function onDiceRoll(die1, die2) {
    if (!active || !matchRef) return;
    if (!die1 || !die2) return;
    if (!window.tokens) return;
    var bytes = encodeMove(die1, die2, 0, 0, 0, 0, false);
    try { window._mpLatestDice = bytes; } catch (e) {}
    commitSnapshot(bytes, 'dice');
}

// Called after each REAL local token move. Each move is committed live with
// advance=false so the opponent sees THIS token move on their board right now,
// but the turn does NOT flip until onPassTurn. (Old bug fixed: committing never
// ends the turn early / steals the second dice value.)
function onMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked) {
    if (!active || !matchRef) return;
    movedThisTurn = true;
    var bytes;
    try {
        bytes = encodeMove(die1, die2, tokenIndex, fromPathIndex, toPathIndex, toStepsWalked, false);
    } catch (e) {
        log('encodeMove THREW: ' + (e && e.message));
        return;
    }
    try { window._mpLatestCommit = bytes; } catch (e) {}
    commitSnapshot(bytes, 'move');
}

// The ONE advance=true commit per turn-end: after ALL this turn's token moves
// (or zero moves on a non-6 roll), send the final board + byte19 = next seat so
// the opponent's turn flips. Single tx per turn; never ends the turn early.
function onPassTurn() {
    if (!active || !matchRef) return;
    if (!window.tokens) return;
    var bytes;
    // Carry the REAL roll values so the pass commit is also the dice commit:
    // when a roll has NO valid move, the board's latest write is the pass - if
    // it carries die1=0/die2=0 the receiver skips showRemoteDice and the dice
    // boxes / cubes never update. Now the pass preserves the rolled dice so the
    // opponent's dice One/Two + cubes mirror it. (lastDiceRoll1/2 are the game's
    // script-global roll values from dice.js, finalizeDiceScores.)
    var d1 = 0, d2 = 0;
    try { d1 = (typeof lastDiceRoll1 === 'number') ? lastDiceRoll1 : 0; } catch (e) {}
    try { d2 = (typeof lastDiceRoll2 === 'number') ? lastDiceRoll2 : 0; } catch (e) {}
    try {
        // Re-encode the CURRENT board with advance=true (turn passes now),
        // but keep the real dice for the receiver's display.
        bytes = encodeMove(d1, d2, 0, 0, 0, 0, true);
    } catch (e) {
        log('pass encode THREW: ' + (e && e.message));
        return;
    }
    movedThisTurn = false;
    try { window._mpPassCommit = bytes; } catch (e) {}
    commitSnapshot(bytes, 'turn');
}

function onFinish(winnerSeat) {
        if (!active || !matchRef) return;
        active = false;
        var refObj = { gameId: 1, matchRef: matchRef };
        var ws = (typeof winnerSeat === 'number') ? winnerSeat : seatOf(window.finishOrder && window.finishOrder[0]);
        rail().finish(refObj, ws).then(function (r) {
            if (!(r && r.okay)) log('finish skipped', (r && r.error) || '');
            if (unsub) { unsub(); unsub = null; }
        });
        // The match is over - stop auto-resuming it on reload.
        if (typeof window.mpClearSession === 'function') { try { window.mpClearSession(); } catch (e) {} }
    }

    function stop() { active = false; if (unsub) unsub(); unsub = null; }
    // After a pre-start seat switch the rail already re-joined on-chain; this
    // updates this device's seat index so the turn gate + colour mapping match
    // the new seat, and re-binds the game seats ('You' moves to the new colour).
    // No re-subscribe (the existing one keeps polling).
    function setMySeat(seat) {
        if (typeof seat === 'number' && seat >= 0) mySeat = seat;
        bindSeats();
        if (typeof window.mpRenderLobby === 'function') {
            try { window.__mpPollLobby(); } catch (e) { /* soft */ }
        }
    }

    window.gfgLudoAdapter = { start: start, join: join, begin: begin, resume: resume, onMove: onMove, onDiceRoll: onDiceRoll, onPassTurn: onPassTurn, onFinish: onFinish, isActive: isActive, ref: ref, seat: seat, color: color, players: players, handles: handles, activeOrder: activeOrder, rememberSeats: rememberSeats, setMySeat: setMySeat, stop: stop };

    // ---- hook the game's existing seams (soft, no behavior change when idle) ----
    var _origMove = window.onMoveCommitted;
    if (typeof _origMove === 'function') {
        window.onMoveCommitted = function () {
            var res = _origMove.apply(this, arguments);
            onMove();
            return res;
        };
    }
    // win-detection's finish already calls window.gfgBoardFinish
    var _origFinish = window.gfgBoardFinish;
    window.gfgBoardFinish = function (finishOrder) {
        onFinish(typeof finishOrder === 'number' ? finishOrder : undefined);
        if (typeof _origFinish === 'function') _origFinish(finishOrder);
    };

    log('ludo multiplayer adapter loaded (M12 arc2m12b)');
})();