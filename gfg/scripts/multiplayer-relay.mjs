// scripts/multiplayer-relay.mjs — MULTIPLAYER relay core (M12, AGM-FREE).
//
// Standalone on-chain multiplayer rail: the relay/sponsor signs the one-time
// board create + delegate (base layer, ~0.0003 SOL, idempotent), and every
// board write afterwards runs GASLESS on the MagicBlock ER (session-key or
// sponsor signer, 0 fee). No AGM / order book / P2C anything lives here.
//
// The GAME owns rules/turn order/move meaning; this relay only:
//   - boardStart: create the [gfgboard, game, matchRef] PDA + delegate it to
//     the ER + begin it (status 0->1) when the host starts the match.
//   - boardCommit: gasless ER write of a 32-byte move checkpoint (one per
//     turn), signed by the sponsor signer (player session keys are the future
//     path; today the rail is free, stake 0, sponsor signs).
//   - boardState: read the board facts from its hosting ER region.
//   - boardFinish: write the winner + finished timestamp (gasless ER).
//   - boardJoin/lobby: validate a match code = matchRef, ensure it is still
//     waiting (status 0) so nobody joins a started match.
//
// Every call is soft-fail ({ok, sig?, error?}) and NEVER throws into the game,
// so Solo/free play is unaffected if the rail is down.

import './load-env.mjs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync, writeFileSync, existsSync, readFileSync as _rfs } from 'fs';
import { fileURLToPath } from 'url';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const BOARD_SEED = Buffer.from('gfgboard2'); // M12 seat-authority board (v2)
const CLOCK_SEED = Buffer.from('gfgclock');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region pin
const MAX_MP = 8;

const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

export function boardPda(game, matchRef) {
  return PublicKey.findProgramAddressSync([BOARD_SEED, Buffer.from([game]), new BN(matchRef).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}

// ---- idempotent ER onboarding -------------------------------------------------
export async function ensureBoardDelegated(game, matchRef) {
  const pda = boardPda(game, matchRef);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return { pda: pda.toBase58(), delegated: false, why: 'board-not-created-yet' };
  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (st && st.isDelegated) return { pda: pda.toBase58(), delegated: true, region: st.fqdn || '' };
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM_ID);
  const tx = await prog.methods.delegateBoard(game, new BN(matchRef))
    .accounts({
      payer: sponsor.publicKey,
      bufferBoard: buffer,
      delegationRecordBoard: record,
      delegationMetadataBoard: metadata,
      board: pda,
      ownerProgram: PROGRAM,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: ER_VALIDATOR_ID, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return { pda: pda.toBase58(), delegated: true, sig };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boardHostUrl(pda) {
  try {
    const st = await getDelegationStatus(conn, pda);
    if (st && st.fqdn) {
      const u = regionUrlForFqdn(st.fqdn);
      if (u) return u;
    }
  } catch (e) { /* fall through */ }
  return pickErRpcUrl();
}

async function waitBoardPickup(pda, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let url = await boardHostUrl(pda);
  while (Date.now() < deadline) {
    try { url = await boardHostUrl(pda); } catch (e) {}
    try {
      const c = createConnection(url, 'confirmed', 8000);
      const info = await c.getAccountInfo(pda);
      if (info && info.owner.toBase58() === PROGRAM.toBase58() && info.data.length >= 655) return url;
    } catch (e) { /* keep polling */ }
    await sleep(600);
  }
  return url;
}

async function boardSignerSend(method, pda, opts = {}) {
  try {
    const url = opts.regionUrl || (await waitBoardPickup(pda));
    const connEr = createConnection(url, 'confirmed');
    const bh = await connEr.getLatestBlockhash('confirmed');
    const tx = await method.transaction();
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.partialSign(sponsor);
    const sig = await connEr.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connEr.confirmTransaction({ signature: sig }, 'confirmed');
    return { ok: true, sig };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ---- actions ------------------------------------------------------------------

// Create + delegate + begin a match. The board is created with the HOST's real
// wallet seated at seat 0 (seat-authority board, v2); the remaining seats stay
// open (Pubkey::default) and joiners fill them via join_match (gasless ER,
// joiner session key signs). The relay only creates + delegates (base), and
// begin happens on the host device via the ER (begin_match requires the seat-0
// holder's signature, so it can never be relay-forged).
export async function boardCreate({ game, matchRef, seats, host, stakeUsdCents, turnSecs, maxMatchSecs }) {
  try {
    const pda = boardPda(game, matchRef);
    const info = await conn.getAccountInfo(pda).catch(() => null);
    let created = false;
    if (!info) {
      const seatCount = Math.min(MAX_MP, Math.max(2, Number(seats) || 2));
      // players[0] = the host's real wallet ONLY. Remaining seats are left open
      // (default) and joiners fill them via join_match. Passing seatCount
      // default-filled entries made player_count == seats immediately, so
      // join_match pushed it over and begin_match failed "competition is not
      // settled". player_count must equal the REAL seated wallets.
      const hostKey = (host && (() => { try { return new PublicKey(host); } catch (e) { return null; } })()) || null;
      const list = hostKey ? [hostKey] : [];
      // arc2m1 timer: the PROGRAM is the single source of truth for turn_secs.
      // Pass 0 (not a fallback) so start_match uses its own DEFAULT_TURN_SECS -
      // no off-chain layer decides the timer duration.
      const tx = await prog.methods.startMatch(game, new BN(matchRef), list, seatCount, new BN(stakeUsdCents || 0), new BN(turnSecs || 0), new BN(maxMatchSecs || 3600))
        .accounts({ payer: sponsor.publicKey, board: pda, systemProgram: SystemProgram.programId }).transaction();
      tx.feePayer = sponsor.publicKey;
      await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }).then(async (sig) => { await conn.confirmTransaction({ signature: sig }, 'confirmed'); });
      created = true;
    }
    const d = await ensureBoardDelegated(game, matchRef);
    if (!d.delegated) await sleep(1200);
    return { ok: true, pda: pda.toBase58(), matchRef, created, delegated: !!d.delegated };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Host pressed "Start Match". The actual on-chain begin_match is signed by the
// HOST (players[0], seat-authority) from the browser as a gasless ER write, so
// this relay helper is only a VALIDATION + read: it confirms the board exists,
// is still open, and returns the facts the host's begin call needs. On Vercel
// the shared test-flow uses this to know "everyone is in".
export async function boardBegin({ game, matchRef }) {
  try {
    const pda = boardPda(game, matchRef);
    const st = await boardState({ game, matchRef });
    if (!st || !st.ok) return { ok: false, error: (st && st.error) || 'board not found', pda: pda.toBase58() };
    if (st.status !== 0) return { ok: true, note: 'already-started', pda: pda.toBase58(), status: st.status };
    return { ok: true, ready: st.player_count >= st.seats, open: st.player_count, of: st.seats, pda: pda.toBase58(), status: st.status };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Validate a code (matchRef digest) still accepts joiners: board exists + status 0.
export async function boardJoin({ game, matchRef }) {
  try {
    const st = await boardState({ game, matchRef });
    if (!st || !st.ok) return { ok: false, error: 'no open match with that code' };
    if (st.status !== 0) return { ok: false, error: 'match already started - no new joins' };
    return { ok: true, matchRef: st.match_ref, pda: st.pda, seats: st.seats };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardCommit({ game, matchRef, seat, moveCommit, regionUrl }) {
  try {
    const pda = boardPda(game, matchRef);
    const method = prog.methods.commitMove(game, new BN(matchRef), seat, Array.isArray(moveCommit) ? moveCommit : toBytes32(moveCommit))
      .accounts({ signer: sponsor.publicKey, board: pda });
    return await boardSignerSend(method, pda, { regionUrl });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardFinish({ game, matchRef, winnerSeat, regionUrl }) {
  try {
    const pda = boardPda(game, matchRef);
    const method = prog.methods.finishMatch(game, new BN(matchRef), winnerSeat)
      .accounts({ signer: sponsor.publicKey, board: pda });
    return await boardSignerSend(method, pda, { regionUrl });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardState({ game, matchRef }) {
  try {
    const pda = boardPda(game, matchRef);
    const url = await boardHostUrl(pda);
    const c = createConnection(url, 'confirmed');
    const info = await c.getAccountInfo(pda).catch(() => null);
    if (!info) return { ok: false, error: 'board not found' };
    const d = info.data;
    if (d.length < 655) return { ok: false, error: 'board too small' };
    const seats = d[276];
    // SEAT-INDEXED players/handles (index 0..seats-1; '' = free seat). The
    // page renders seats by index, so the array must never compress zero slots.
    const players = [];
    for (let i = 0; i < Math.min(MAX_MP, seats); i++) {
      const s = d.subarray(19 + i * 32, 51 + i * 32);
      if (s.every(b => b === 0)) { players.push(''); continue; }
      try { players.push(new PublicKey(s).toBase58()); } catch (e) { players.push(''); }
    }
    // handles[8][24] @277..468; current_turn @469
    const handles = [];
    for (let i = 0; i < Math.min(MAX_MP, seats); i++) {
      const bs = d.subarray(277 + i * 24, 301 + i * 24);
      let end = bs.indexOf(0);
      if (end === -1) end = bs.length;
      handles.push(Buffer.from(bs.subarray(0, end)).toString('utf8'));
    }
    return {
      ok: true,
      pda: pda.toBase58(),
      version: d[8],
      game: d[9],
      match_ref: Number(d.readBigUInt64LE(10)),
      status: d[18],
      players,
      player_count: d[275],
      seats: d[276],
      handles,
      current_turn: d[469],
      // arc2m1 turn timer: per-seat ABSOLUTE DEADLINES (until-timestamps).
      // last_turn_ts[seat] = the GMT epoch when that seat's current turn window
      // ends (set at begin for seat 0 and re-stamped by commit_move as turns are
      // handed over / continued). The frontend reads these + turn_secs to render
      // the countdown; expire_turn uses them to force-pass a lapsed turn.
      last_turn_ts: (function () {
        const out = [];
        for (let i = 0; i < 8; i++) out.push(Number(d.readBigInt64LE(510 + i * 8)));
        return out;
      })(),
      stake_usd_cents: Number(d.readBigUInt64LE(470)),
      seat_pot_usd_cents: Number(d.readBigUInt64LE(478)),
      turn_secs: Number(d.readBigUInt64LE(486)),
      max_match_secs: Number(d.readBigUInt64LE(494)),
      started_at: Number(d.readBigInt64LE(502)),
      move_count: Number(d.readBigUInt64LE(574)),
      // last_move_commit is the 32-byte move hash immediately after move_count.
      last_move_commit: Array.from(d.subarray(582, 614)),
      finished_at: Number(d.readBigInt64LE(614)),
      winner_seat: d[622],
      // creator: appended v3 field (offset 623..654) - the host wallet.
      creator: new PublicKey(d.subarray(623, 655)).toBase58(),
      region: url,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function toBytes32(hexOrStr) {
  const out = new Uint8Array(32);
  const s = String(hexOrStr || '');
  let hex = s.startsWith('0x') ? s.slice(2) : s;
  for (let i = 0; i < Math.min(32, hex.length / 2); i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  }
  return Array.from(out);
}

// ---- public dispatch (used by api_handlers/multiplayer.mjs) -------------------
export async function dispatch(action, b) {
  switch (action) {
    case 'create': return boardCreate({ game: Number(b.game), matchRef: Number(b.matchRef), seats: Number(b.seats), host: b.host, stakeUsdCents: Number(b.stakeUsdCents) || 0, turnSecs: Number(b.turnSecs) || 0, maxMatchSecs: Number(b.maxMatchSecs) || 3600 });
    case 'begin': return boardBegin({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'join': return boardJoin({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'commit': return boardCommit({ game: Number(b.game), matchRef: Number(b.matchRef), seat: Number(b.seat), moveCommit: b.moveCommit, regionUrl: b.regionUrl });
    case 'state': return boardState({ game: Number(b.game), matchRef: Number(b.matchRef) });
    case 'finish': return boardFinish({ game: Number(b.game), matchRef: Number(b.matchRef), winnerSeat: Number(b.winnerSeat), regionUrl: b.regionUrl });
    case 'lobby-create': return lobbyCreate(b);
    case 'lobby-join': return lobbyJoin(b);
    case 'lobby-seat': return lobbySeat(b);
    case 'lobby-leave': return lobbyLeave(b);
    case 'lobby-start': return lobbyStart(b);
    case 'lobby-state': return lobbyState(b);
    default: return { ok: false, error: 'unknown multiplayer action: ' + action };
  }
}

// =====================================================
// LOBBY REGISTRY (game-agnostic, additive)
// A tiny room store keyed by the match CODE so every device in the same match
// sees the same lobby: who joined, which seat each took, and when the host
// starts. This is PRESENCE metadata only (seats/picks/started) - the actual
// game moves + results stay 100% on-chain via the board rail above. Works for
// any future game (2P/4P/6P/8P) because seats are just a number.
//
// Persistence: a JSON file on the relay disk when writable (local dev); on
// Vercel (read-only fs) it is per-instance + memory, which is fine for a short
// lobby (matches live minutes, not days). Everything is soft-fail.
// =====================================================
const LOBBY_FILE = fileURLToPath(new URL('./.gfg-mp-lobby.json', import.meta.url));
let lobbyStore = null;
function loadLobby() {
  if (lobbyStore) return lobbyStore;
  try { lobbyStore = existsSync(LOBBY_FILE) ? JSON.parse(_rfs(LOBBY_FILE, 'utf8')) : {}; }
  catch (e) { lobbyStore = {}; }
  return lobbyStore;
}
function saveLobby() {
  try { writeFileSync(LOBBY_FILE, JSON.stringify(lobbyStore, null, 2)); } catch (e) { /* read-only (Vercel): skip */ }
}
function roomKey(game, code) { return String(game) + ':' + String(code).toUpperCase(); }
function codeOf(b) { return String(b && b.code || '').trim().toUpperCase(); }

// Create a lobby room for a created match code. `handle` is the public GFG
// sitewide name (never email/wallet); the creator auto-takes seat 0.
function lobbyCreate(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const seats = Math.min(8, Math.max(2, Number(b.seats) || 2));
  if (!code) return { ok: false, error: 'lobby: missing code' };
  const store = loadLobby();
  const key = roomKey(game, code);
  if (store[key]) return { ok: false, error: 'lobby: a room with this code already exists' };
  const creatorHandle = String(b.handle || 'Host').slice(0, 24);
  const players = [];
  for (let i = 0; i < seats; i++) {
    players.push(i === 0 ? { seat: i, handle: creatorHandle, host: true } : { seat: i, handle: null });
  }
  store[key] = { game, code, seats, players, started: false, createdAt: Date.now(), seatLocked: false };
  saveLobby();
  return { ok: true, code, seats, players, started: false };
}

// Place a player at `seat` (or first free seat). Handles both: an existing
// player switching seats (clear old slot, occupy new) and a brand-new join.
function placePlayer(room, handle, seat) {
  const old = room.players.find(p => p.handle === handle);
  if (old && old.host) return { ok: true, note: 'host' };
  let target = Number.isInteger(seat) && seat >= 0 && seat < room.seats ? seat : null;
  if (target == null) target = room.players.findIndex(p => !p.handle && (!old || old.seat !== p.seat));
  if (target < 0) return { ok: false, error: 'lobby: room is full' };
  if (!old) {
    // New joiner: occupy the free seat.
    if (room.players[target] && room.players[target].handle) return { ok: false, error: 'lobby: that seat is taken' };
    room.players = room.players.map((p, i) => i === target ? { seat: i, handle, host: false } : p);
    return { ok: true };
  }
  // Existing player moving: free their old seat, take the new one.
  if (target !== old.seat && room.players[target] && room.players[target].handle) {
    return { ok: false, error: 'lobby: that seat is taken' };
  }
  room.players = room.players.map((p, i) => {
    if (i === old.seat && i !== target) return { seat: i, handle: null, host: false };
    if (i === target) return { seat: i, handle, host: !!old.host };
    return p;
  });
  return { ok: true };
}

// Join a room by code: adds the player to the seat they pick (no auto-assign
// beyond the first free seat when none given; the UI always picks). The host is
// auto-seated at 0 on create and never "joins".
function lobbyJoin(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const handle = String(b.handle || 'Player').slice(0, 24);
  const store = loadLobby();
  const key = roomKey(game, code);
  const room = store[key];
  if (!room) return { ok: false, error: 'lobby: no room with that code' };
  if (room.started) return { ok: false, error: 'match already started - no new joins' };
  const r = placePlayer(room, handle, Number(b.seat));
  if (!r.ok) return r;
  saveLobby();
  return { ok: true, code: room.code, seats: room.seats, players: room.players, started: room.started };
}

// Pick/switch seat before start (same placement logic, explicit seat).
function lobbySeat(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const handle = String(b.handle || '').trim();
  if (!handle) return { ok: false, error: 'lobby: handle required' };
  const seat = Number(b.seat);
  if (!Number.isInteger(seat) || seat < 0) return { ok: false, error: 'lobby: invalid seat' };
  const store = loadLobby();
  const room = store[roomKey(game, code)];
  if (!room) return { ok: false, error: 'lobby: no room' };
  if (room.started) return { ok: false, error: 'match already started - seats locked' };
  if (seat >= room.seats) return { ok: false, error: 'lobby: seat out of range (pick ' + room.seats + ' seats)' };
  const r = placePlayer(room, handle, seat);
  if (!r.ok) return r;
  saveLobby();
  return { ok: true, code: room.code, seats: room.seats, players: room.players, started: room.started };
}

function lobbyLeave(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const handle = String(b.handle || '');
  const store = loadLobby();
  const key = roomKey(game, code);
  const room = store[key];
  if (!room) return { ok: false, error: 'lobby: no room' };
  const wasHost = room.players.find(p => p.handle === handle && p.host);
  if (wasHost) { delete store[key]; saveLobby(); return { ok: true, removed: true }; }
  room.players = room.players.map(p => p.handle === handle ? { seat: p.seat, handle: null, host: false } : p);
  saveLobby();
  return { ok: true, removed: false };
}

function lobbyStart(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const store = loadLobby();
  const room = store[roomKey(game, code)];
  if (!room) return { ok: false, error: 'lobby: no room' };
  if (!room.players.some(p => p.host && p.handle === String(b.handle || ''))) {
    return { ok: false, error: 'lobby: only the host can start' };
  }
  const freeCount = room.players.filter(p => !p.handle).length;
  if (freeCount > 0) return { ok: false, error: 'lobby: waiting for players (' + freeCount + ' free seat' + (freeCount === 1 ? '' : 's') + ')' };
  room.started = true;
  saveLobby();
  return { ok: true, code: room.code, seats: room.seats, players: room.players, started: true };
}

function lobbyState(b) {
  const game = Number(b.game) || 1;
  const code = codeOf(b);
  const store = loadLobby();
  const room = store[roomKey(game, code)];
  if (!room) return { ok: false, error: 'lobby: no room' };
  return { ok: true, code: room.code, game: room.game, seats: room.seats, players: room.players, started: room.started };
}