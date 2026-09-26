// public/universal/result-seam/game-result.js
// UNIVERSAL GAME RESULT BUS (platform-level, game-agnostic)
//
// The one seam every game emits into. M3 (local points), M4 (global ledgers),
// M7 (competitions) and any future module subscribe here and consume a
// canonical result envelope — they never touch a game's internals. This is
// what makes 50 games = 1 reward plug, 1 competition plug: the game only has
// to call publishGameResult once when its match completes.
//
// THE CANONICAL ENVELOPE (what a game emits):
//   {
//     schema: 'gfg:game-result@1',     // bus version (set by the bus)
//     gameId: 'ludo',                   // games registry id (registry.json)
//     mode: 'human_vs_computer',        // free-form, for display/debug
//     startedAt: <ms>, finishedAt: <ms>,
//     players: [
//       {
//         seat: 'green',                // game-local seat id (color, position…)
//         actor: 'user'|'house'|'local',// who actually played this seat:
//                                       //   'user'  = the signed-in player (identity attached by bus)
//                                       //   'house' = a server-side/keyless seat (computer/AI)
//                                       //   'local' = a local human not bound to an account
//         position: 1,                  // ranked games: 1st..nth (null for score games)
//         score: 100,                   // score-based games: numeric result (null for ranked)
//         identity: <wallet>|null       // 'user' seats: explicit wallet if the
//                                       //   game supplied one (multiplayer), else
//                                       //   the signed-in wallet (Solo). Never the
//                                       //   handle/email; used by M3/M4 crediting.
//         handle: <GFG-X>|null           // optional public display id, never email/wallet.
//       }, …
//     ],
//     proof: {                          // OPTIONAL on-chain proof-of-play
//       method: 'magicblock-vrf',
//       chain: 'solana-devnet',
//       signature: '…',                 // the primary proof tx (usually the winning roll)
//       pda: '…',                       // optional account that holds the proof
//     }
//   }
//
// Consumers:
//   const off = window.onGameResult(handler)   // handler(result) ; off() to unsubscribe
//   window.gfgLastGameResult                    // last emitted result (for late subscribers)
//   window.addEventListener('gfg:game-result', e => e.detail)
//
// Games:
//   window.publishGameResult({ gameId:'ludo', players:[…], proof:{…} })
// The bus validates + normalizes, attaches identity for 'user' seats when a
// profile is available, then notifies every registered module.
(function () {

    const SCHEMA = 'gfg:game-result@1';
    const ALLOWED_ACTORS = ['user', 'house', 'local'];

    const handlers = [];
    let lastResult = null;

    // Resolve the signed-in player's wallet identity for a 'user' seat.
    function resolveUserIdentity() {
        try {
            if (window.currentProfile && window.currentProfile.solana_wallet) {
                return window.currentProfile.solana_wallet;
            }
            if (window.getDynamicSolanaWallet) {
                const w = window.getDynamicSolanaWallet();
                if (w && w.address) return w.address;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Normalize a raw game emit into the canonical envelope. Throws with a
    // clear message on malformed input so the game author fixes the emit.
    function normalize(raw) {
        if (!raw || typeof raw !== 'object') {
            throw new Error('publishGameResult: result must be an object');
        }
        const gameId = String(raw.gameId || '').trim();
        if (!gameId) throw new Error('publishGameResult: gameId is required');

        const players = Array.isArray(raw.players) ? raw.players : [];
        if (players.length < 1) throw new Error('publishGameResult: players array is required');
        if (players.length > 64) throw new Error('publishGameResult: too many players (max 64)');

        const normalizedPlayers = players.map((p, i) => {
            if (!p || typeof p !== 'object') throw new Error(`publishGameResult: players[${i}] must be an object`);
            const seat = String(p.seat == null ? '' : p.seat).trim();
            if (!seat) throw new Error(`publishGameResult: players[${i}].seat is required`);
            const actor = String(p.actor || 'local').trim();
            if (ALLOWED_ACTORS.indexOf(actor) === -1) {
                throw new Error(`publishGameResult: players[${i}].actor must be one of ${ALLOWED_ACTORS.join('/')}`);
            }
            const hasPosition = typeof p.position === 'number';
            const hasScore = typeof p.score === 'number';
            if (!hasPosition && !hasScore) {
                throw new Error(`publishGameResult: players[${i}] needs position (ranked) or score (score-based)`);
            }
            const out = {
                seat,
                actor,
                position: hasPosition ? p.position : null,
                score: hasScore ? p.score : null,
                // Identity flows through for EVERY seat when the game supplied
                // it (M12 ships the on-chain seat -> wallet map in the envelope).
                // A 'user' seat with no explicit identity falls back to the
                // signed-in wallet. 'house'/'local' seats without an explicit
                // identity stay anonymous (null).
                identity: p.identity
                    ? String(p.identity)
                    : (actor === 'user' ? resolveUserIdentity() : null),
                handle: p.handle ? String(p.handle) : null,
            };
            return out;
        });

        const proof = (raw.proof && typeof raw.proof === 'object')
            ? {
                method: String(raw.proof.method || 'onchain').trim(),
                chain: String(raw.proof.chain || '').trim(),
                signature: raw.proof.signature ? String(raw.proof.signature) : null,
                pda: raw.proof.pda ? String(raw.proof.pda) : null,
            }
            : null;

        return {
            schema: SCHEMA,
            gameId,
            mode: raw.mode ? String(raw.mode) : '',
            startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null,
            finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : Date.now(),
            players: normalizedPlayers,
            proof,
        };
    }

    window.publishGameResult = function (raw) {
        const result = normalize(raw);
        lastResult = result;
        console.log(`[GameResult] ${result.gameId} — ${result.players.length} player(s)`, result);

        // 1) Notify every subscribed module (M3/M4/M7/…).
        handlers.slice().forEach(h => {
            try { h(result); } catch (e) { console.warn('[GameResult] handler failed:', e); }
        });

        // 2) Also fire a DOM event for loose/one-off consumers.
        try {
            const evt = new CustomEvent('gfg:game-result', { detail: result });
            window.dispatchEvent(evt);
        } catch (e) { /* CustomEvent may be unavailable in odd sandboxes */ }
    };

    window.onGameResult = function (handler) {
        if (typeof handler !== 'function') throw new Error('onGameResult: handler must be a function');
        handlers.push(handler);
        return () => {
            const i = handlers.indexOf(handler);
            if (i >= 0) handlers.splice(i, 1);
        };
    };

    Object.defineProperty(window, 'gfgLastGameResult', {
        get() { return lastResult; },
    });

})();
