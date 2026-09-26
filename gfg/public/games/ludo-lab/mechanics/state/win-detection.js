// win-detection.js (M1 — game core only)
// Detects winners, tracks the 1st..4th finish order, holds the match outcome
// status (in-progress / finished / abandoned), and emits the universal GAME
// RESULT envelope when the match completes (see /universal/result-seam/game-result.js). M1 knows
// NOTHING about points, tiers, competitions or rewards: it publishes a
// canonical result and the platform bus fans it out to M3/M4/M7 consumers.
//
// ENDGAME (locked spec, amended 2026-08-15 for early end):
//   - once a seat has all 4 tokens DISAPPEARED OFF THE BOARD (stepsWalked>=57),
//     it is "finished"; its turns auto-pass (~1.5s log, no dice roll, no tap)
//     for human AND computer seats (see turn.js).
//   - the match is DECIDED the moment at most ONE active seat has not finished
//     (2P: one winner ends it, the other is 2nd; 4P: three winners end it, the
//     last is 4th). The trailing seat is auto-last and never plays its turns.
//     Then the loop STOPS, status=finished, the seam is emitted and the result
//     ceremony 1st..Nth + "Play Again" is shown.

(function () {

    let finishOrder = [];   // e.g. ['green', 'red', 'yellow', 'blue']
    // Match outcome: 'in-progress' | 'finished' | 'abandoned'. Rewards gate on
    // status===finished (done by M3/M4 consumers, never here).
    let matchStatus = 'in-progress';

    function countFinishedTokens(color) {
        if (!window.tokens || !window.tokens[color]) return 0;
        return window.tokens[color].filter(t => t.stepsWalked >= 57).length;
    }

    // A seat is "finished" when ALL 4 of its tokens are off the board.
    window.isSeatFinished = function (color) {
        return countFinishedTokens(color) === 4;
    };

    // Every seat in the active turn sequence must finish (2P: both seats;
    // 4P: all 4).
    window.allSeatsFinished = function () {
        const active = (typeof window.getActiveSeats === 'function')
            ? window.getActiveSeats()
            : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
        return active.every(c => window.isSeatFinished(c));
    };

    // NEW endgame rule (owner-approved 2026-08-15): the match is decided the
    // moment at most ONE active seat has not finished. The last unfinished seat
    // is auto-last — its turn is never played (2P: one winner ends it, the
    // other is 2nd; 4P: three winners end it, the last is 4th). This stops the
    // match from dragging on for the trailing seat, which wastes on-chain ER
    // rolls for zero decision.
    window.isMatchComplete = function () {
        const active = (typeof window.getActiveSeats === 'function')
            ? window.getActiveSeats()
            : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
        const unfinished = active.filter(c => !window.isSeatFinished(c));
        return unfinished.length <= 1;
    };

    window.getMatchStatus = function () {
        return matchStatus;
    };

    window.setMatchStatus = function (s) {
        if (s === 'in-progress' || s === 'finished' || s === 'abandoned') {
            matchStatus = s;
        }
    };

    // (4.1) A multiplayer device that did NOT make the winning move still needs
    // to complete its local match when the on-chain board reports the finish
    // (status=2 + winner_seat set by the winner's finish_match). Without this,
    // that device waits forever on a turn that will never come. The board is
    // the single source of truth: it already holds the winner; we simply end
    // the local game, mark the match over and show the ceremony.
    // We deliberately DO NOT re-publish the seam here: the winner's device
    // already emitted it and banked every 'user' seat at its own wallet (via
    // the on-chain identity map). A second emission from this device would use
    // a different proofSig -> different match_ref -> DOUBLE-credit seats.
    window.gfgCompleteMatchFromBoard = function (winnerSeat) {
        if (matchStatus === 'finished') return;
        try {
            if (typeof winnerSeat === 'number') {
                const order = (typeof window.getActiveSeats === 'function')
                    ? window.getActiveSeats()
                    : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
                const winColor = order[winnerSeat];
                if (winColor && !finishOrder.includes(winColor)) finishOrder.push(winColor);
            }
            const active = (typeof window.getActiveSeats === 'function')
                ? window.getActiveSeats()
                : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
            active.forEach(c => {
                if (!finishOrder.includes(c) && !window.isSeatFinished(c)) {
                    finishOrder.push(c);
                }
            });
            matchStatus = 'finished';
            window.finishOrder = finishOrder.slice();
            if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
            if (typeof window.markMatchOver === 'function') window.markMatchOver();
            if (typeof window.showResultCeremony === 'function') window.showResultCeremony();
        } catch (e) {
            console.log('[win-detection] gfgCompleteMatchFromBoard errored', e);
        }
    };

    window.checkForMatchWinner = function (color) {
        if (!color || !window.playerProfiles) return;
        if (matchStatus !== 'in-progress') return;

        const finished = countFinishedTokens(color);
        if (finished < 4) return;

        // Already recorded this colour?
        if (finishOrder.includes(color)) return;

        // Record finishing position
        finishOrder.push(color);
        const position = finishOrder.length; // 1, 2, 3 or 4

        console.log(`Position ${position}: ${color.toUpperCase()}`);

        // Persist immediately so a page reload keeps the crowns (finish order)
        // for in-progress matches.
        if (typeof saveGameStateToStorage === 'function') {
            saveGameStateToStorage();
        }

        // Force a redraw so the crown appears immediately
        if (typeof drawLudoLayout === 'function') {
            drawLudoLayout();
        }

        // Match complete (the match is decided once at most ONE active seat is
        // unfinished): the remaining seat is auto-last, then we stop the loop,
        // mark the outcome, publish the universal game result envelope and show
        // the 1st..Nth ceremony. M1 only reports facts:
        //   - who played each seat (actor: user / house / local)
        //   - the finish order (position)
        //   - the on-chain proof of play (VRF roll signature) when present
        // The platform bus (window.publishGameResult) attaches identity to the
        // 'user' seat and fans the result out to M3/M4/M7. No points logic
        // lives here, and M1 never calls reward-bound instructions.
        if (window.isMatchComplete()) {
            // Auto-last: the one remaining unfinished active seat gets the final
            // position without playing its trailing turns (the game is decided).
            const active = (typeof window.getActiveSeats === 'function')
                ? window.getActiveSeats()
                : (typeof turnSequence !== 'undefined' ? turnSequence : ['green', 'yellow', 'blue', 'red']);
            active.forEach(c => {
                if (!finishOrder.includes(c) && !window.isSeatFinished(c)) {
                    finishOrder.push(c);
                }
            });

            matchStatus = 'finished';
            if (typeof saveGameStateToStorage === 'function') {
                saveGameStateToStorage();
            }

            publishSeamResult();

            // Stop the turn loop + ceremony (implemented in turn.js).
            if (typeof window.markMatchOver === 'function') {
                window.markMatchOver();
            }
            if (typeof window.showResultCeremony === 'function') {
                window.showResultCeremony();
            }
        }
    };

    function publishSeamResult() {
    const proofSig = typeof window.getLastProofRollSignature === 'function'
        ? window.getLastProofRollSignature() : null;

    // M12: when a multiplayer match is active, the adapter knows the on-chain
    // seat -> wallet + handle map. Attach it so M3/M4 can credit EVERY human
    // seat to its own wallet (not just "whoever is signed in here"). Solo/
    // single-player keeps its exact previous behavior (no identity override).
    let mpWallets = null, mpHandles = null;
    try {
        const a = window.gfgLudoAdapter;
        if (a && typeof a.isActive === 'function' && a.isActive()) {
            if (typeof a.players === 'function') mpWallets = a.players();
            if (typeof a.handles === 'function') mpHandles = a.handles();
        }
    } catch (e) { /* soft */ }

    // WINNER-ONLY SEAM (item 4, no double-credit): in MP every device runs the
    // finish locally, but only the device that OWNS the winning seat publishes
    // + banks. The other devices complete their local match via
    // gfgCompleteMatchFromBoard (which never re-banks). Without this guard the
    // CREATOR's device would also try to bank the invited winner at their
    // wallet, using a DIFFERENT per-device matchRef, and double-credit them.
    if (mpWallets && finishOrder && finishOrder.length) {
        try {
            const a = window.gfgLudoAdapter;
            const myColor = (typeof a.color === 'function') ? a.color() : null;
            if (myColor && finishOrder[0] && finishOrder[0] !== myColor) return;
        } catch (e) { /* soft */ }
    }

    const players = finishOrder.map(color => {
        // Multiplayer: map finish-order colours onto their on-chain seat index
        // (Ludo seat order = green, yellow, blue, red; 2P active order = green,
        // red). Attach the seat's REAL wallet + handle when known; the actor
        // stays 'user' if THIS device controls that seat, else 'local'.
        let identity = null, handle = null;
        if (mpWallets) {
            try {
                const order = (typeof window.getActiveSeats === 'function')
                    ? window.getActiveSeats()
                    : ['green', 'yellow', 'blue', 'red'];
                const si = order.indexOf(color);
                if (si >= 0) {
                    if (mpWallets[si]) identity = mpWallets[si];
                    if (mpHandles && mpHandles[si]) handle = mpHandles[si];
                }
            } catch (e) { /* soft */ }
        }
        return {
            seat: color,
            // Multiplayer identity rule (item 4): in MP, EVERY seat that has a
            // real on-chain wallet attached is a LOGGED-IN PLAYER at their own
            // wallet - so it is actor 'user' and M3/M4 credit it to ITSELF,
            // whether or not that player created the match or is "the user on
            // this device". A seat WITHOUT a wallet (a free human/computer
            // filler that never joined on-chain) stays 'local'/'house'.
            // Single-player is untouched (mpWallets is null -> the old checks).
            actor: (mpWallets && !!identity)
                ? 'user'
                : (window.playerProfiles[color] && window.playerProfiles[color].isUser === true)
                    ? 'user'
                    : (window.playerProfiles[color] && window.playerProfiles[color].mode === 'human')
                        ? 'local'
                        : 'house',
            position: finishOrder.indexOf(color) + 1,
            identity,
            handle,
        };
    });

        const result = {
            gameId: 'ludo',
            mode: 'human_vs_computer',
            finishedAt: Date.now(),
            players,
            proof: proofSig
                ? {
                    method: 'magicblock-vrf',
                    chain: (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) ? 'arc' : 'solana-devnet',
                    signature: proofSig,
                }
                : null,
        };

        console.log(`[GFG LUDO] Match finished | finishOrder=${finishOrder.map((c, i) => `${i + 1}:${c}`).join(' ')} | proofSig=${proofSig || 'none'} | seam envelope:`, result);

        if (typeof window.publishGameResult === 'function') {
            window.publishGameResult(result);
        } else {
            // Bus not loaded (shouldn't happen on the real page) — fall
            // back to a plain log so the game still works standalone.
            console.log('[M1] Match complete — result:', result);
        }

        // arc2m1d: report the on-chain MatchBoard finish (soft-fail observer;
        // never blocks the game). Exists only when board-hooks.js is loaded.
        if (typeof window.gfgBoardFinish === 'function') {
            try { window.gfgBoardFinish(window.finishOrder || players); } catch (e) { /* soft */ }
        }

        // Commit the full 1st..4th finish order on-chain (Scope C).
        commitGameResultOnchain(proofSig);
    }

    // Scope C (Ludo locked spec): commit the FULL finish order 1st..Nth plus
    // the reward mirror on-chain, proof-bound to the match. Runs gasless on
    // the ER (session key signs, 0 SOL); the relay idempotently creates +
    // delegates the player's result PDA (seed 'gfgresult') if it is missing.
    // Soft-fail by design: the seam envelope above is the source of truth for
    // platform consumers, and the ceremony never waits on this write. A failed
    // write is logged and surfaced in the ceremony as "pending/failed", never
    // blocking the match-ending UX. Returns the receipt Promise (or null).
    function commitGameResultOnchain(proofSig) {
        var chain = window.gfgChain || window.magicblockDice;
        if (!chain || typeof chain.recordResult !== 'function') return null;
        try {
            const matchRef = (proofSig && chain.matchRefFromSignature)
                ? chain.matchRefFromSignature(proofSig)
                : ((window.gfgChain && window.gfgChain.isArc) ? Date.now() : 0);
            // Mirror the banked award in the on-chain result record: read M3's
            // award for this match (the landed one, or the in-flight one at
            // worst), so the result's points column matches what M3/M4 banked
            // for the user seat. Multiplier stays 1 (M4 banks the base,
            // unmultiplied win; M5's tier boost is a separate kind-1 credit).
            const m3Award = window.localPoints
                && (window.localPoints.lastAward || window.localPoints.lastSeenAward);
            const mirrorPoints = (m3Award && m3Award.points > 0) ? m3Award.points : 0;
            // Route through the CHAIN GATEWAY, never the Solana SDK directly.
            // On Arc the gateway returns { ok, batched: true } (the points write
            // already emitted the window leaf); on Solana it calls the ER record.
            // Calling window.magicblockDice here bypassed the gateway and issued
            // a Solana write on the Arc path.
            const promise = chain
                .recordResult(finishOrder.slice(), mirrorPoints, 1, matchRef)
                .then((sig) => {
                    window.__lastOnchainGameRecordSig = sig || null;
                    console.log('[M1] Full game result committed on-chain:', sig || 'no receipt');
                    return sig;
                })
                .catch((err) => {
                    console.warn('[M1] On-chain game record commit failed (soft-fail):', err);
                    return null;
                });
            window.__onchainGameRecordPromise = promise;
            return promise;
        } catch (err) {
            console.warn('[M1] On-chain game record commit could not start (soft-fail):', err);
            return null;
        }
    }

    // Used by board.js to know who finished where
    window.getFinishOrder = function () {
        return finishOrder.slice();
    };

    window.getPlayerRank = function (color) {
        const index = finishOrder.indexOf(color);
        return index === -1 ? 0 : index + 1; // 0 = not finished, 1 = 1st, etc.
    };

    // Used by persistence.js to restore crowns + outcome after a reload.
    window.serializeWinState = function () {
        return {
            finishOrder: finishOrder.slice(),
            matchStatus: matchStatus,
        };
    };

    // Used by persistence.js to restore crowns + outcome after a reload.
    window.hydrateWinState = function (state) {
        if (!state) return;
        if (Array.isArray(state.finishOrder)) {
            finishOrder = state.finishOrder.filter(c => typeof c === 'string');
        }
        if (state.matchStatus === 'finished' || state.matchStatus === 'abandoned') {
            matchStatus = state.matchStatus;
        }
    };

    // Reset only the match flags (Local points stay permanent, elsewhere)
    window.resetWinDetection = function () {
        finishOrder = [];
        matchStatus = 'in-progress';
    };

})();
