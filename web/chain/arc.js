// src/chain/arc.js — the Arc rail adapter (arcv2m16).
//
// The browser never holds a key and never pays gas. Writes and reads go to the
// self-hosted relayer endpoint (/api/arc), which signs with the app sponsor key
// and pays the tiny USDC gas. Reads are decoded server-side so the browser stays
// thin (no viem in the client bundle).
//
// Naming note (owner 2026-09-18): the settlement layer is GlobalFolkGames
// Batched Settlement (GFG-BS): Merkle-root batch settlement plus commit-reveal
// randomness. It is NOT a rollup, and it settles more than gameplay.
//
// Everything here is behind VITE_GFG_CHAIN=evm. The default is svm, so the live
// Solana flow is untouched while we build and test the Arc path.

let _cfg = null;

export async function arcPublicConfig() {
  if (_cfg) return _cfg;
  const res = await fetch('/arc-config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('arc-config.json ' + res.status);
  _cfg = await res.json();
  return _cfg;
}

async function relay(action, params, token) {
  const res = await fetch('/api/arc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params: params || {}, token }),
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = { ok: false, error: 'bad response' }; }
  if (!res.ok || !j.ok) throw new Error(j.error || ('relay ' + res.status));
  return j;
}

function evmAddress() {
  try { return (window.getDynamicEvmWallet && window.getDynamicEvmWallet()) || null; } catch (e) { return null; }
}

// Normalize a match reference to a 32-byte hex string, EXACTLY mirroring the
// relayer's hex32() in api_handlers/arc-relay.mjs. This was a real bug: a
// NUMERIC ref (Date.now() / matchRef) was written as the UTF-8 dump of its
// digits (0x313738...) on one side and as numeric hex on the other, so the
// start commit could never be looked up or settled and no history row appeared.
// Defence in depth: the relayer normalizes too, so both ends agree even if one
// is stale.
function normalizeGameId(ref) {
  const v = String(ref == null ? '' : ref);
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v;
  if (/^[0-9]{1,20}$/.test(v)) {
    try { return '0x' + BigInt(v).toString(16).padStart(64, '0'); } catch (e) { /* fall through */ }
  }
  const bytes = new TextEncoder().encode(v);
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, Math.min(32, bytes.length)));
  let hex = '';
  for (let i = 0; i < 32; i++) hex += out[i].toString(16).padStart(2, '0');
  return '0x' + hex;
}

export const arcAdapter = {
  name: 'arc',

  async isReady() {
    try { await arcPublicConfig(); return true; } catch (e) { return false; }
  },

  walletAddress() { return evmAddress(); },

  // Full player snapshot (lives, globals, premium, one game bucket).
  async readPlayer(gameTag = 'ludo') {
    const player = evmAddress();
    if (!player) return null;
    return relay('readPlayer', { player, tag: gameTag });
  },

  // Ledger shape the modules expect (same fields as the Solana path).
  async fetchLedger(gameTag = 'ludo') {
    const r = await this.readPlayer(gameTag);
    if (!r) return null;
    const b = r.bucket || {};
    const g = r.globals || {};
    return {
      pureLifetime: Number(b.pure || 0),
      spendableBalance: Number(b.spendable || 0),
      globalPure: Number(g.pure || 0),
      globalLifetime: Number(g.lifetime || 0),
      globalSpendable: Number(g.spendable || 0),
      lives: r.lives || null,
      premium: r.premium || null,
      raw: r,
    };
  },

  async recordPoints(gameTag, points, reason, matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('recordPoints', { player, tag: gameTag || 'ludo', points, reason: reason || 1, matchRef });
  },

  async recordGlobal(kind, points, matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('recordGlobal', { player, kind: kind || 0, points, matchRef });
  },

  async chargeLife(matchRef, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('chargeLife', { player, matchRef });
  },

  // Spendable draw-downs (gasless; the relayer signs). The contract's own
  // Insufficient check is the guard, so a spend can never overdraw.
  async spendLocal(gameTag, amount, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('spendLocal', { player, tag: gameTag || 'ludo', amount });
  },
  async spendGlobal(amount, playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) throw new Error('no Arc wallet connected');
    return relay('spendGlobal', { player, amount });
  },

  async openGame(gameId, p2, ttl) { return relay('openGame', { gameId, p2, ttl: ttl || 1800 }); },
  async settleGame(gameId, resultHash) { return relay('settleGame', { gameId, resultHash }); },
  async expireGame(gameId) { return relay('expireGame', { gameId }); },
  // Full finish order (1st..Nth seat indexes) recorded with the result.
  async settleGameOrder(gameId, actor, resultHash, order) { return relay('settleGameOrder', { gameId, actor, resultHash, order }); },
  async resultOrder(gameId) { return relay('resultOrder', { gameId }); },
  // On-chain turn clock (arcv2m1/2ii). The game reads the ABSOLUTE deadline from
  // the chain and counts down to it; a lapsed seat is advanced by anyone.
  async seatUp(gameId, host, seat, player) { return relay('seatUp', { gameId, host, seat, player }); },
  async beginGame(gameId, host, seats, turnSecs) { return relay('beginGame', { gameId, host, seats, turnSecs }); },
  async commitMove(gameId, mover, seat, nextSeat, moveCommit) { return relay('commitMove', { gameId, mover, seat, nextSeat, moveCommit }); },
  async expireTurn(gameId) { return relay('expireTurn', { gameId }); },
  async turnState(gameId) { return relay('turnState', { gameId }); },
  async commitBatch(kind, root, count) { return relay('commitBatch', { kind: kind || 0, root, count }); },
  async commitSeed(batchId, seedHash) { return relay('commitSeed', { batchId, seedHash }); },
  async revealSeed(batchId, seed) { return relay('revealSeed', { batchId, seed }); },

  // GFG-BS per-match settlement (arcv2m17, the gasless core): TWO txs per match
  // total, no matter how many moves. The player pays nothing; the relayer pays.
  // DEFENCE IN DEPTH: normalize the gameId to a 32-byte hex string here, so a
  // numeric ref can never be mis-encoded on either side of the wire.
  async commitMatchStart(gameId, p1, p2, gameTag, seats, commitHash, ttlSecs) {
    return relay('commitMatchStart', { gameId: normalizeGameId(gameId), p1, p2, gameTag, seats, commitHash, ttlSecs: ttlSecs || 3600 });
  },
  async settleMatch(gameId, moveDigest, resultHash, moveCount, sig1, sig2) {
    return relay('settleMatch', {
      gameId: normalizeGameId(gameId), moveDigest, resultHash, moveCount,
      v1: sig1.v, r1: sig1.r, s1: sig1.s,
      v2: sig2.v, r2: sig2.r, s2: sig2.s,
    });
  },
  async matchDispute(gameId, revealedDigest) { return relay('matchDispute', { gameId: normalizeGameId(gameId), revealedDigest }); },
  async matchTimeout(gameId) { return relay('matchTimeout', { gameId: normalizeGameId(gameId) }); },
  async matchState(gameId) { return relay('matchState', { gameId: normalizeGameId(gameId) }); },

  // Permissionless upkeep: expires a stale plan on-chain and heals the lives
  // pool to the approved ladder (L0 5 / L1 10 / L2 15 / L3 20).
  async upkeep(playerPubkey) {
    const player = playerPubkey || evmAddress();
    if (!player) return null;
    return relay('upkeep', { player });
  },

  // Money actions require the operator token (fail-closed on the server).
  async creditPremium(player, points, creditRef, token) { return relay('creditPremium', { player, points, creditRef }, token); },
  async activatePlan(player, level, planDays, token) { return relay('activatePlan', { player, level, planDays: planDays || 30 }, token); },
  async activateBooster(player, planHours, token) { return relay('activateBooster', { player, planHours: planHours || 72 }, token); },
};
