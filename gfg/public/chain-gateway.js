// public/chain-gateway.js — one game-facing gateway, two chains (arcv2m16).
//
// Games call window.gfgChain instead of a chain directly. It dispatches:
//   svm: the Solana MagicBlock ER path (unchanged, just bypassed for Arc).
//   evm: the Arc path, GlobalFolkGames Batched Settlement (GFG-BS): rolls from
//        the committed dice seed, lives and points through the self-hosted
//        relayer, result settled on Arc.
//
// The active chain is window.GFG_CHAIN, set by the page bootstrap from the
// build-time VITE_GFG_CHAIN (default svm, so the live flow is untouched).
(function () {
  function chain() { return String(window.GFG_CHAIN || 'svm').toLowerCase(); }
  function adapter() { return window.gfgChainAdapter || null; }
  function mb() { return window.magicblockDice || null; }

  async function relay(action, params, token) {
    const res = await fetch('/api/arc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params: params || {}, token }),
    });
    let j = null; try { j = await res.json(); } catch (e) { j = { ok: false, error: 'bad response' }; }
    if (!res.ok || !j.ok) throw new Error(j.error || ('relay ' + res.status));
    return j;
  }

  window.gfgChain = {
    chain,
    isArc: function () { return chain() === 'evm'; },
    label: function () {
      return chain() === 'evm'
        ? 'GlobalFolkGames Batched Settlement randomness on Arc Blockchain'
        : 'MagicBlock ER VRF on Solana Blockchain';
    },
    shortLabel: function () {
      return chain() === 'evm' ? 'on-chain (Arc)' : 'on-chain (MagicBlock ER VRF)';
    },

    available: function () {
      if (chain() === 'evm') return !!adapter() || true; // relayer is a plain fetch
      return !!(mb() && mb().available && mb().available());
    },

    ping: async function () {
      if (chain() === 'evm') {
        try { await relay('readPlayer', { player: '0x000000000000000000000000000000000000dEaD', tag: 'ludo' }); return true; }
        catch (e) { return false; }
      }
      return (mb() && mb().ping) ? mb().ping() : false;
    },

    // Returns [roll1, roll2] on both chains (the game expects an array).
    roll: async function () {
      if (chain() === 'evm') {
        const a = adapter();
        const player = (a && a.walletAddress && a.walletAddress()) || null;
        const counter = (window.__gfgRollCounter = (window.__gfgRollCounter || 0) + 1);
        const gameId = (window.__gfgGameId = window.__gfgGameId || ('0x' + Date.now().toString(16).padStart(64, '0')));
        const j = await relay('rollDice', { gameId: gameId, counter: counter, player: player });
        window.__gfgLastArcRoll = j;
        // Non-zero proof token for Arc: the committed seed hash. Points and the
        // result derive match_ref from it, and the contract rejects ref 0, so
        // this is what lets a win actually bank on Arc.
        window.__gfgArcRollToken = j.seedHash || ('0x' + String(Date.now()).padStart(64, '0'));
        return [j.roll1, j.roll2];
      }
      return mb().roll();
    },

    getLastProofRollSignature: function () {
      // Arc: the commitment (committed seed hash) is the proof reference. It is
      // non-zero so match_ref is valid; the full proof is the seed reveal plus
      // the window Merkle proof.
      if (chain() === 'evm') return window.__gfgArcRollToken || ('0x' + String(Date.now()).padStart(64, '0'));
      return (mb() && mb().getLastProofRollSignature) ? mb().getLastProofRollSignature() : null;
    },
    getLastDiceDelegationSignature: function () {
      if (chain() === 'evm') return null;
      return (mb() && mb().getLastDiceDelegationSignature) ? mb().getLastDiceDelegationSignature() : null;
    },

    // Lazy migration: when a player who was on Solana logs in and gets an EVM
    // wallet, ask the relayer to copy their Solana points to Arc. The relayer
    // verifies the wallet mapping itself; the client sends only the address.
    migrateMe: async function () {
      if (chain() !== 'evm') return { ok: false, reason: 'not arc' };
      var a = adapter();
      var addr = (a && a.walletAddress && a.walletAddress()) || null;
      if (!addr) return { ok: false, reason: 'no evm wallet' };
      try { return await relay('migrateMe', { evmAddress: addr }); }
      catch (e) { console.warn('[gfgChain] migrateMe failed (soft):', e && e.message); return { ok: false, error: String(e && e.message) }; }
    },

    chargeLife: async function (matchRef) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.chargeLife(matchRef); return null; }
      return null; // Solana charges the life on-chain at begin/join
    },
    // LEDGER READS (arcv2m17 audit): the universal modules must read through
    // this gateway, never the Solana SDK directly. On Arc it calls the Arc
    // adapter's readPlayer (one relayer call returns bucket + globals + lives +
    // premium); on Solana it returns null here (the modules keep their existing
    // Solana SDK read path). This is additive: no behaviour change on svm.
    readPlayer: async function (gameTag) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.readPlayer) return a.readPlayer(gameTag || 'ludo'); return null; }
      return null;
    },
    fetchLedger: async function (gameTag) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.fetchLedger) return a.fetchLedger(gameTag || 'ludo'); return null; }
      return null;
    },
    // GLOBAL LEDGER read for the Arc path, normalized to the same field names
    // the universal modules already expect (pureLifetime/lifetime/spendableBalance).
    // On Solana returns null so the module keeps its existing SDK read.
    fetchGlobalLedger: async function () {
      if (chain() !== 'evm') return null;
      const a = adapter();
      if (!a || !a.readPlayer) return null;
      const r = await a.readPlayer('ludo');
      if (!r) return null;
      const g = r.globals || {};
      return {
        pureLifetime: Number(g.pure || 0),
        lifetime: Number(g.lifetime || 0),
        spendableBalance: Number(g.spendable || 0),
        raw: r,
      };
    },
    // PREMIUM LEDGER read for the Arc path, normalized to the field names the
    // profile card expects. On Solana returns null (existing SDK read kept).
    fetchPremiumLedger: async function () {
      if (chain() !== 'evm') return null;
      const a = adapter();
      if (!a || !a.readPlayer) return null;
      const r = await a.readPlayer('ludo');
      if (!r) return null;
      const p = r.premium || {};
      return {
        premiumLifetime: Number(p.lifetime || 0),
        premiumSpendable: Number(p.spendable || 0),
        subscriptionLevel: Number(p.level || 0),
        subscriptionActiveUntil: Number(p.activeUntil || 0) || null,
        boosterActiveUntil: (r.lives && r.lives.boosterUntil) || 0,
        raw: r,
      };
    },
    // LIVES read for the Arc path: { used, pool, boosterUntil, unlimited }.
    // Mirrors the Solana readLivesFor shape so callers can treat both alike.
    // On Solana returns null (callers keep magicblockDice.readLivesFor).
    readLives: async function () {
      if (chain() !== 'evm') return null;
      const a = adapter();
      if (!a || !a.readPlayer) return null;
      const r = await a.readPlayer('ludo');
      if (!r || !r.lives) return null;
      const used = Number(r.lives.used || 0);
      const pool = Number(r.lives.pool || 0);
      const boosterUntil = Number(r.lives.boosterUntil || 0) * 1000; // s -> ms
      return {
        used: used,
        pool: pool,
        boosterUntil: boosterUntil,
        unlimited: boosterUntil > Date.now(),
        left: Math.max(0, pool - used),
      };
    },
    recordPoints: async function (gameTag, points, reason, matchRef, playerPubkey) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.recordPoints(gameTag, points, reason, matchRef, playerPubkey); return null; }
      return (mb() && mb().recordPoints) ? mb().recordPoints(gameTag, points, reason, matchRef, playerPubkey) : null;
    },
    recordGlobal: async function (kind, sourceCode, points, reason, matchRef, playerPubkey) {
      if (chain() === 'evm') { const a = adapter(); if (a) return a.recordGlobal(kind, points, matchRef, playerPubkey); return null; }
      return (mb() && mb().recordGlobalPoints) ? mb().recordGlobalPoints(kind, sourceCode, points, reason, matchRef, playerPubkey) : null;
    },
    matchRefFromSignature: function (sig) {
      if (chain() === 'evm') {
        // STABLE Arc ref derived from the proof token. It MUST be deterministic
        // (same token -> same ref) because the on-chain DuplicateMatchRef guard
        // relies on it for idempotent retries. The old code returned Date.now(),
        // which changed per call and broke retry idempotency. A hex 0x token is
        // folded into a safe positive integer; a non-hex token is hashed.
        try {
          const s = String(sig || '');
          let h = 0x811c9dc5 >>> 0;
          for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
          // Avoid 0 (the contract rejects ref 0) and keep it below 2^31 to be
          // safe as a u64 ref on every rail.
          const ref = (h % 2147483647) || 1;
          return ref;
        } catch (e) { return (Date.now() % 2147483647) || 1; }
      }
      return (mb() && mb().matchRefFromSignature) ? mb().matchRefFromSignature(sig) : 0;
    },
    recordResult: async function (finishOrder, points, reason, matchRef) {
      if (chain() === 'evm') {
        // The on-chain points write already emitted the leaf (PointsRecorded).
        // The window is DERIVED from the chain, so there is nothing to enqueue
        // and no off-chain store. The proof is available after a window flush.
        return { ok: true, batched: true };
      }
      return (mb() && mb().recordResult) ? mb().recordResult(finishOrder, points, reason, matchRef) : null;
    },

    // On-chain turn clock (arcv2m1/2ii). Mirrors the Solana game core: the
    // deadline is an absolute chain timestamp, and expireTurn is permissionless.
    seatUp: async function (gameId, host, seat, player) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.seatUp) return a.seatUp(gameId, host, seat, player); return null; }
      return null;
    },
    beginGame: async function (gameId, host, seats, turnSecs) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.beginGame) return a.beginGame(gameId, host, seats, turnSecs); return null; }
      return null;
    },
    commitMove: async function (gameId, mover, seat, nextSeat, moveCommit) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.commitMove) return a.commitMove(gameId, mover, seat, nextSeat, moveCommit); return null; }
      return null;
    },
    expireTurn: async function (gameId) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.expireTurn) return a.expireTurn(gameId); return null; }
      return null;
    },
    // Reads the chain clock: { seats, activeSeat, turnSecs, turnDeadline, moveCount, begun }.
    turnState: async function (gameId) {
      if (chain() !== 'evm') return null;
      const a = adapter(); if (a && a.turnState) return a.turnState(gameId);
      return null;
    },

    // Game flow: open a match on Arc, then record the finish order with the
    // result. Null on svm (the Solana path owns those writes there).
    openGame: async function (gameId, p2, ttl) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.openGame) return a.openGame(gameId, p2, ttl); return null; }
      return null;
    },
    settleGameOrder: async function (gameId, actor, resultHash, order) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.settleGameOrder) return a.settleGameOrder(gameId, actor, resultHash, order); return null; }
      return null;
    },
    // Reads the on-chain result + finish order: { resultHash, order }.
    resultOrder: async function (gameId) {
      if (chain() !== 'evm') return null;
      const a = adapter(); if (a && a.resultOrder) return a.resultOrder(gameId);
      return null;
    },

    // Spendable draw-downs. On Arc these go through the relayer (contract
    // enforces Insufficient); Solana keeps the session-key path.
    spendGlobal: async function (amount, reason, ref) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.spendGlobal) return a.spendGlobal(amount); return null; }
      return (mb() && mb().spendGlobal) ? mb().spendGlobal(amount, reason, ref) : null;
    },
    spendLocal: async function (gameTag, amount, reason, ref) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.spendLocal) return a.spendLocal(gameTag, amount); return null; }
      return (mb() && mb().spendLocal) ? mb().spendLocal(gameTag, amount, reason, ref) : null;
    },

    // GFG-BS per-match settlement (arcv2m17): TWO txs per match, no per-move
    // cost. Null on svm (Solana keeps its own path).
    commitMatchStart: async function (gameId, p1, p2, gameTag, seats, commitHash, ttlSecs) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.commitMatchStart) return a.commitMatchStart(gameId, p1, p2, gameTag, seats, commitHash, ttlSecs); return null; }
      return null;
    },
    settleMatch: async function (gameId, moveDigest, resultHash, moveCount, sig1, sig2) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.settleMatch) return a.settleMatch(gameId, moveDigest, resultHash, moveCount, sig1, sig2); return null; }
      return null;
    },
    matchDispute: async function (gameId, revealedDigest) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.matchDispute) return a.matchDispute(gameId, revealedDigest); return null; }
      return null;
    },
    matchTimeout: async function (gameId) {
      if (chain() === 'evm') { const a = adapter(); if (a && a.matchTimeout) return a.matchTimeout(gameId); return null; }
      return null;
    },
    matchState: async function (gameId) {
      if (chain() !== 'evm') return null;
      const a = adapter(); if (a && a.matchState) return a.matchState(gameId);
      return null;
    },

    // On-chain proof for a game in the last flushed window (verify card).
    batchProof: async function (matchRef) {
      if (chain() !== 'evm') return null;
      const gameId = '0x' + String(matchRef).padStart(64, '0');
      try { return await relay('batchProof', { kind: 'settle', gameId }); } catch (e) { return null; }
    },
  };
  // Fire the lazy migration once per session when on Arc and a wallet exists.
  try {
    var ran = false;
    function maybeMigrate() {
      if (ran) return;
      if (!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc())) return;
      var a = window.gfgChainAdapter;
      if (!a || !a.walletAddress || !a.walletAddress()) return;
      ran = true;
      window.gfgChain.migrateMe().then(function (r) { if (r && r.migrated) console.log('[gfgChain] points migrated to Arc:', r.points); });
    }
    window.addEventListener('load', function () { setTimeout(maybeMigrate, 1500); });
    window.addEventListener('gfg:auth-changed', function () { setTimeout(maybeMigrate, 1200); });
  } catch (e) { /* soft */ }
})();
