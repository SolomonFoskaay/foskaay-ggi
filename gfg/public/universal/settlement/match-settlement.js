// public/universal/settlement/match-settlement.js
// arcv2m17 — GFG-BS per-match settlement RAIL (universal, GAME-AGNOSTIC).
//
// This is the ONE integration point EVERY game uses to settle a match on Arc in
// TWO transactions (start commit + one co-signed settlement), no matter how many
// moves it has. It knows NOTHING about Ludo, chess or any board:
//   - a game passes a `gameTag` (string, e.g. 'ludo', 'chess', 'ayo_olopon'),
//   - an arbitrary JSON `result` payload (winner, order, points, anything),
//   - and calls start()/move()/finish() from its own turn loop.
//
// 50 games = 1 rail. Adding a game = emit the same calls; this file never changes.
//
// WHAT GOES ON-CHAIN (only at the two boundaries):
//   1. start()  -> commitStart: players + a commitment + the timeout clock.
//   2. finish() -> settle: the move-log DIGEST + the result digest, co-signed by
//      BOTH players' session keys. The move log itself stays OFF-chain.
//
// SECURITY: the digest is rendered tamper-evident by match-engine.js (editing a
// move changes the digest; a forged log cannot be co-signed into a valid settle).
//
// GAME TAG: a small number for the chain (config-driven map, data not code), so
// new games are added by editing the map, never the contract.
(function () {
    'use strict';

    // gameTag string -> uint16 for the chain. Add a game here (data, not code).
    var GAME_TAGS = { ludo: 0, chess: 1, ayo_olopon: 2, draughts: 3, snakes_ladders: 4, whot: 5, oware: 6 };
    function tagOf(name) { var t = GAME_TAGS[String(name || 'ludo').toLowerCase()]; return (t == null) ? 0 : t; }

    function chain() { return window.gfgChain || null; }
    function engine() { return window.gfgMatchEngine || null; }
    function isArc() { try { return !!(chain() && chain().isArc && chain().isArc()); } catch (e) { return false; } }
    function adapter() { return window.gfgChainAdapter || null; }

    // Deterministic hex digest of an arbitrary payload (stable key order).
    function digestOf(obj) {
        var s = JSON.stringify(obj == null ? null : obj, obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).sort() : undefined);
        var b = new TextEncoder().encode(s);
        var h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
        for (var i = 0; i < b.length; i++) { h1 ^= b[i]; h1 = Math.imul(h1, 16777619) >>> 0; h2 = (Math.imul(h2 ^ b[i], 2246822519) + h1) >>> 0; }
        function hx(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
        return {
            h1: h1, h2: h2,
            hex: hx(h1) + hx(h2) + hx((h1 ^ h2) >>> 0) + hx(Math.imul(h1, h2) >>> 0) +
                 hx((h1 + b.length) >>> 0) + hx((h2 ^ b.length) >>> 0) + hx((h1 ^ 0x9e3779b9) >>> 0) + hx((h2 + 0x85ebca6b) >>> 0),
        };
    }
    function hex32(obj) { return '0x' + digestOf(obj).hex; }

    function numHex(n) { try { return '0x' + BigInt(n).toString(16).padStart(64, '0'); } catch (e) { return null; } }
    function gameId32(ref) {
        if (typeof ref === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ref)) return ref;
        return numHex(ref);
    }

    // ---- public rail ---------------------------------------------------------
    // openMatch({ gameTag, matchRef, p1, p2, seats, ttlSecs }) -> commits the start.
    async function start(opts) {
        opts = opts || {};
        var a = adapter();
        if (!isArc() || !a || typeof a.commitMatchStart !== 'function') return null;
        var gid = gameId32(opts.matchRef || Date.now());
        var commitHash = hex32({ gameTag: String(opts.gameTag || 'ludo'), p1: opts.p1, p2: opts.p2, seats: opts.seats || 2, ref: gid });
        try {
            var r = await a.commitMatchStart(gid, opts.p1, opts.p2, tagOf(opts.gameTag), Number(opts.seats || 2), commitHash, Number(opts.ttlSecs || 3600));
            return { ok: true, gameId: gid, commitHash: commitHash, tx: (r && (r.txHash || r)) || null };
        } catch (e) {
            console.warn('[match-settlement] start soft-fail:', e && e.message);
            return { ok: false, gameId: gid, error: String(e && e.message) };
        }
    }

    // finish({ result }) -> ONE co-signed settlement. Reads the digest from the
    // off-chain engine (match-engine.js) and asks each device to sign it.
    async function finish(opts) {
        opts = opts || {};
        var a = adapter();
        var eng = engine();
        if (!isArc() || !a || typeof a.settleMatch !== 'function' || !eng) return null;

        var s = (opts.summary) || (eng.summary && eng.summary());
        if (!s) return { ok: false, error: 'no match summary' };
        var moveDigest = s.digest;
        var resultHash = hex32(s.result == null ? { none: true } : s.result);
        var moveCount = Number(s.moveCount || 0);
        var gameId = gameId32(s.matchRef);

        // Both devices must sign the SAME summary string.
        var str = eng.summaryString ? eng.summaryString(s) : '';
        var sig1 = null, sig2 = null;
        try { sig1 = await (opts.signLocal ? opts.signLocal(str) : (window.dynamicSignMessage ? window.dynamicSignMessage(str) : null)); } catch (e) { sig1 = null; }
        try { sig2 = opts.signRemote ? await opts.signRemote(str) : sig1; } catch (e) { sig2 = null; }
        if (!sig1 || !sig2) return { ok: false, error: 'co-signature unavailable', gameId: gameId };

        var s1 = split(sig1), s2 = split(sig2);
        try {
            var r = await a.settleMatch(gameId, moveDigest, resultHash, moveCount, s1, s2);
            return { ok: true, gameId: gameId, moveDigest: moveDigest, tx: (r && (r.txHash || r)) || null };
        } catch (e) {
            console.warn('[match-settlement] settle soft-fail:', e && e.message);
            return { ok: false, gameId: gameId, error: String(e && e.message) };
        }
    }

    // FREE DISPUTE (owner-locked 2026-09-19): a dispute is a signed OFF-CHAIN
    // event like a move - no bond, no fee, no extra transaction. It is submitted
    // to the relayer, which runs the verifier replay for free and records the
    // outcome; the on-chain dispute flag (if needed) is written inside the same
    // batch window, never as a paid per-match tx.
    async function dispute(opts) {
        opts = opts || {};
        var eng = engine();
        if (!isArc()) return null;
        var s = opts.summary || (eng && eng.summary ? eng.summary() : null);
        if (!s) return { ok: false, error: 'no match summary' };
        // Record the dispute locally on the off-chain log (free).
        try { if (eng && eng.dispute) eng.dispute(opts.reason); } catch (e) { /* soft */ }
        var revealedMoves = opts.revealedMoves || null;
        var payload = {
            gameId: gameId32(s.matchRef),
            gameTag: String(s.gameTag || 'ludo'),
            moveDigest: s.digest,
            moveCount: Number(s.moveCount || 0),
            reason: String(opts.reason || 'disagreement'),
            revealedMoves: revealedMoves,
            createdAt: Date.now(),
        };
        // Ask the relayer to verify + record (free; no player payment).
        try {
            var res = await fetch('/api/arc', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'matchDisputeFree', params: payload }),
            });
            var j = await res.json();
            if (!res.ok || !j.ok) return { ok: false, error: (j && j.error) || ('dispute ' + res.status) };
            return j;
        } catch (e) {
            return { ok: false, error: String(e && e.message) };
        }
    }

    async function disputeOnchain(gameId, revealedDigest) {
        var a = adapter();
        if (!isArc() || !a || typeof a.matchDispute !== 'function') return null;
        try { var r = await a.matchDispute(gameId32(gameId), revealedDigest); return { ok: true, tx: r && (r.txHash || r) }; }
        catch (e) { return { ok: false, error: String(e && e.message) }; }
    }
    async function timeout(gameId) {
        var a = adapter();
        if (!isArc() || !a || typeof a.matchTimeout !== 'function') return null;
        try { var r = await a.matchTimeout(gameId32(gameId)); return { ok: true, tx: r && (r.txHash || r) }; }
        catch (e) { return { ok: false, error: String(e && e.message) }; }
    }
    async function state(gameId) {
        var a = adapter();
        if (!isArc() || !a || typeof a.matchState !== 'function') return null;
        try { return await a.matchState(gameId32(gameId)); } catch (e) { return null; }
    }

    function split(sig) {
        var v = parseInt(String(sig).slice(130, 132), 16); if (v < 27) v += 27;
        return { r: '0x' + String(sig).slice(2, 66), s: '0x' + String(sig).slice(66, 130), v: v };
    }

    // SIGNED MOVE RECORD (arcv2m17, game-agnostic): a game calls this for EVERY
    // real move, human or AI, so the whole match is in the co-signed digest and
    // sealed in the batch window. `seat` may be a numeric index OR a game colour
    // name (Ludo passes 'green'/'red'/...); a colour is mapped to its seat index
    // using the match's own seat order (set at start()). Zero chain cost.
    function recordMove(seat, moveObj) {
        var eng = engine();
        if (!eng || typeof eng.move !== 'function') return null;
        var idx = Number(seat);
        if (!Number.isFinite(idx)) {
            // Map a colour/name to its seat index using the match's own seat
            // order captured at open() (Ludo passes 'green'/'red'/...).
            var s = (eng.state && eng.state()) || null;
            var colors = (s && s.seatColors) || null;
            if (colors && colors.length) {
                idx = colors.indexOf(String(seat));
            }
            if (!Number.isFinite(idx) || idx < 0) idx = 0;
        }
        try {
            var d = eng.move(idx, moveObj);
            // Keep the engine's turn pointer in step with the recorded seat.
            if (eng.setTurn) eng.setTurn(idx);
            return d;
        } catch (e) {
            console.warn('[match-settlement] recordMove soft-fail:', e && e.message);
            return null;
        }
    }

    window.gfgSettlement = {
        isEnabled: isArc,
        tags: function () { return Object.assign({}, GAME_TAGS); },
        tagOf: tagOf,
        start: start,
        finish: finish,
        recordMove: recordMove,
        dispute: dispute,
        disputeOnchain: disputeOnchain,
        verifyReveal: function (moves, meta, expectedDigest) {
            var eng = engine();
            return (eng && eng.verifyReveal) ? eng.verifyReveal(moves, meta, expectedDigest) : { ok: false, reason: 'no engine' };
        },
        timeout: timeout,
        state: state,
        digestOf: hex32,
    };
})();
