// scripts/agm-relay.mjs — Arc2 AGM lobby relay core: relay/sponsor signs every
// on-chain AGM action on behalf of the AUTHENTICATED wallet (passed via maker/
// taker). Order ids are unix-ms timestamps (globally unique, no collisions).
// Discovery = a light local id index + ids the caller/browser knows; every
// display field (status/maker/stake/seats/taker) is re-read ON-CHAIN each list
// via readOrder over the MagicBlock router/region RPCs. The MagicBlock chain
// cannot be enumerated with getProgramAccounts, so the index is a pointer list,
// never a cache of order data.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, baseRpcEndpoints, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM = Buffer.from('gfgagm');
const AGMS = Buffer.from('gfgagms');
const P2C_GLOBAL = Buffer.from('gfgp2cbank'); // ONE shared pool across every game
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region pin

const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

export function orderPda(game, orderId) {
  return PublicKey.findProgramAddressSync([AGM, Buffer.from([game]), new BN(orderId).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}
export function settlementPda(orderId) {
  return PublicKey.findProgramAddressSync([AGMS, new BN(orderId).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}
export function bankPda(_gameIgnored) {
  return PublicKey.findProgramAddressSync([P2C_GLOBAL], PROGRAM)[0]; // shared: all games use the same pool
}

const BOARD_SEED = Buffer.from('gfgboard');
export function boardPda(game, matchRef) {
  return PublicKey.findProgramAddressSync([BOARD_SEED, Buffer.from([game]), new BN(matchRef).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
}

// Idempotent board onboarding: if the board PDA exists but is NOT delegated,
// delegate it once (sponsor pays the one-time ER session). `start_match` is
// the application's job (sponsor signs init on base). Blocks for gasless
// writes afterwards.
export async function ensureBoardDelegated(game, matchRef) {
  const pda = boardPda(game, matchRef);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return { pda: pda.toBase58(), delegated: false, why: 'board-not-created-yet' };
  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (st && st.isDelegated) return { pda: pda.toBase58(), delegated: true, region: st.fqdn || '' };
  // delegate using the relay/sponsor signer (same wallet that init the board).
  // The #[delegate] macro injects buffer/delegation-record/delegation-metadata
  // PDAs derived from `board.key()` (seeds use DELEGATE_BUFFER_TAG etc.), plus
  // owner/delegation/system programs. Pass them EXPLICITLY (mirrors the proven
  // delegateResultPda in delegate-relay) so the ER router recognizes the record.
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

// ===== Board actions (arc2m1d) - relay/sponsor signs, board PDA writes run
// gasless on the ER after one delegation. Soft-fail friendly for the game:
// each returns { ok, sig?, error? } and NEVER throws, so ludo-lab Solo can't
// be broken by a flaky board write. game = M1 source_code (1 = ludo).

const boardSleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hosting region RPC for a board PDA (Router -> fqdn). Falls back through the
// ER registry so a single region hiccup never fakes a write failure.
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

// Poll the board's hosting ER region until the validator has picked the
// account up (owner == OUR program, data present). Fresh delegations take a
// beat to report their region; re-resolve each pass like the client does.
async function waitBoardPickup(pda, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let url = await boardHostUrl(pda);
  while (Date.now() < deadline) {
    try { url = await boardHostUrl(pda); } catch (e) {}
    try {
      const c = createConnection(url, 'confirmed', 8000);
      const info = await c.getAccountInfo(pda);
      if (info && info.owner.toBase58() === PROGRAM.toBase58() && info.data.length >= 430) {
        return url;
      }
    } catch (e) { /* not picked up yet - keep polling */ }
    await boardSleep(600);
  }
  return url; // best-effort: submit on the host anyway
}

// Gasless ER write for a board instruction: resolve host region -> wait for
// pickup -> sign (sponsor) + submit + confirm on THAT region. Returns {ok,sig}
// or {ok:false,error}. NEVER throws.
async function boardSignerSend(method, pda, opts = {}) {
  try {
    let url = opts.regionUrl || (await waitBoardPickup(pda));
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

export async function boardStart({ game, matchRef, players, seats, stakeUsdCents, turnSecs, maxMatchSecs }) {
  try {
    const pda = boardPda(game, matchRef);
    const info = await conn.getAccountInfo(pda).catch(() => null);
    let created = false;
    if (!info) {
      // The program requires at least 2 players on the board (max MAX_MP).
      // The rail's create/join model knows only the CREATOR up front (the joiner
      // shows up later), so pad the board with the sponsor as a placeholder
      // seat. Real seat identity/locking is a later multiplayer milestone; this
      // keeps create on-chain-valid today while Solo/free play is untouched.
      const sponsorKey = sponsor.publicKey;
      let list = (Array.isArray(players) ? players : []).map((p) => {
        try { return new PublicKey(p); } catch (e) { return sponsorKey; }
      });
      while (list.length < Math.max(2, Number(seats) || 2)) list.push(sponsorKey);
      list = list.slice(0, 8);
      const tx = await prog.methods.startMatch(game, new BN(matchRef), list, Math.max(list.length, Number(seats) || 2), new BN(stakeUsdCents || 0), new BN(turnSecs || 60), new BN(maxMatchSecs || 3600))
        .accounts({ payer: sponsor.publicKey, board: pda, systemProgram: SystemProgram.programId }).transaction();
      await sendTx(tx);
      created = true;
    }
    // delegate (idempotent): board writes then run gasless on the ER
    const d = await ensureBoardDelegated(game, matchRef);
    if (!d.delegated) await boardSleep(1200); // give the router/pickup a beat
    // begin the match on a workspace (status 0 -> 1) - this is a one-time status
    // flip, so it runs on the sponsor/base path like start_match, NOT the ER.
    const st = await boardState({ game, matchRef }).catch(() => null);
    if (st && st.ok && st.status !== 1) {
      const meth = prog.methods.beginMatch(game, new BN(matchRef)).accounts({ signer: sponsor.publicKey, board: pda });
      const tx2 = await meth.transaction();
      tx2.feePayer = sponsor.publicKey;
      const s2 = await sendMagicTx(conn, tx2, [sponsor], { skipPreflight: true });
      await conn.confirmTransaction({ signature: s2 }, 'confirmed');
    }
    return { ok: true, pda: pda.toBase58(), matchRef, created, delegated: !!d.delegated };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export async function boardCommit({ game, matchRef, seat, moveCommit, regionUrl }) {
  try {
    const pda = boardPda(game, matchRef);
    const method = prog.methods.commitMove(game, new BN(matchRef), seat, Array.isArray(moveCommit) ? moveCommit : hexTo32(moveCommit))
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
    if (d.length < 430) return { ok: false, error: 'board too small' };
    const playerCount = d[275];
    const players = [];
    for (let i = 0; i < Math.min(8, playerCount); i++) {
      const s = d.subarray(19 + i * 32, 51 + i * 32);
      if (s.every(b => b === 0)) continue;
      try { players.push(new PublicKey(s).toBase58()); } catch (e) {}
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
      stake_usd_cents: Number(d.readBigUInt64LE(277)),
      seat_pot_usd_cents: Number(d.readBigUInt64LE(285)),
      turn_secs: Number(d.readBigUInt64LE(293)),
      max_match_secs: Number(d.readBigUInt64LE(301)),
      started_at: Number(d.readBigInt64LE(309)),
      move_count: Number(d.readBigUInt64LE(381)),
      winner_seat: d[429],
      region: url,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function hexTo32(hex) {
  const out = new Uint8Array(32);
  const clean = String(hex || '').replace(/^0x/i, '');
  if (clean.length === 64) { for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0; }
  return Array.from(out);
}

// Order discovery: a local id index (ids only; every display field is re-read
// on-chain via readOrder each list) plus any ids the caller (browser) supplies.
// The primary proofs stay on-chain; the index is just "what order ids exist" -
// MagicBlock's chain cannot be enumerated with getProgramAccounts.
async function readIndexIds() {
  return knownOrders().map(e => Number(e.id)).filter(x => x && x > 0);
}



async function sendTx(tx, extraSigners = []) {
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor, ...extraSigners], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

async function readOrder(game, orderId) {
  const pda = orderPda(game, orderId);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  const version = d[8];
  const order_id = Number(d.readBigUInt64LE(9));
  const game_ = d[17];
  const maker = d.subarray(18, 50);
  const stake = Number(d.readBigUInt64LE(50));
  const seats = d[58];
  const status = d[59];
  const taker = d.subarray(60, 92);
  const created_at = Number(d.readBigInt64LE(92));
  return { version, order_id, game: game_, maker: new PublicKey(maker).toBase58(), stake_usd_cents: stake, seats, status, taker: new PublicKey(taker).toBase58(), created_at };
}

async function readBank(game) {
  const pda = bankPda(game);
  const info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  try { return await prog.account.p2cBank.fetch(pda); } catch (e) { return null; }
}

function sign(extra) { return { publicKey: extra.publicKey, signTransaction: async (t) => { t.partialSign(extra); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(extra)); return ts; } }; }

// Reads a wallet's SOL + stablecoin balances. Matches are run in a single
// stablecoin: same coin in, same coin out, no conversion ever. Reads ALL the
// wallet's token accounts (no mint filter, so an unknown mint can never break
// the read) and maps known mints to their symbol. Unknown/absent = 0.
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC (Circle faucet)
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT (same SPL id on devnet)
const USDG_MINT = '6YtmBGgjbPn7cNT9cMLm9XLYvUnrXsHQt7HSDzKdTurJ'; // USDG (no devnet liquidity yet)
export async function walletBalances(walletAddr) {
  try {
    const pub = new PublicKey(walletAddr);
    const lamports = await conn.getBalance(pub).catch(() => null);
    const accounts = await allTokenAccounts(pub);
    let usdc = 0, usdt = 0, usdg = 0;
    for (const acct of accounts) {
      const mint = acct.mint;
      const amt = acct.amount;
      if (mint === USDC_MINT) usdc += amt;
      else if (mint === USDT_MINT) usdt += amt;
      else if (mint === USDG_MINT) usdg += amt;
    }
    return {
      sol: lamports != null ? lamports / 1e9 : null,
      usdc,
      usdt,
      usdg,
    };
  } catch (e) {
    // never silent: the page must show WHY the balance couldn't be read
    return { sol: null, usdc: null, usdt: null, usdg: null, error: e.message };
  }
}
async function allTokenAccounts(pub) {
  let lastErr = null;
  let tried = 0;
  for (const rpc of RPC_CANDIDATES()) {
    tried += 1;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 8000);
      let res;
      try {
        res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [pub.toBase58(), { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }] }),
          signal: ac.signal,
        }).then(r => r.json());
      } finally { clearTimeout(to); }
      if (res && res.error) { lastErr = new Error(res.error.message || JSON.stringify(res.error)); continue; }
      const arr = (res && res.result && res.result.value) || [];
      const out = [];
      for (const a of arr) {
        const p = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
        if (!p || !p.mint || !p.tokenAmount) continue;
        out.push({ mint: p.mint, amount: Number(p.tokenAmount.uiAmount || 0) });
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error('token balance RPC failed (' + tried + ' tries): ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
}
function RPC_CANDIDATES() {
  const out = [];
  // The env RPC (Alchemy, GFG_DEVNET_RPC) is the fast, reliable worker for
  // token-account reads - try it first when present, then the base/standard
  // devnet endpoints as fallback.
  if (process.env.GFG_DEVNET_RPC) out.push(process.env.GFG_DEVNET_RPC);
  try {
    for (const e of baseRpcEndpoints()) { if (!out.includes(e)) out.push(e); }
  } catch (e) {}
  if (!out.includes('https://api.devnet.solana.com')) out.push('https://api.devnet.solana.com');
  return out;
}

// ---- order index (ids + seed metadata only; every display field comes from
// the chain). The MagicBlock router chain cannot be enumerated with
// getProgramAccounts, so the relay keeps the orders it has seen. This is a
// LIGHT index, NOT the source of truth: each id is re-read on-chain on every
// list (readOrder), so status/maker/stake/seats/taker are always live. Ids are
// unix-ms timestamps, so cross-instance collisions are impossible.
import { existsSync, readFileSync as _readIdx, writeFileSync as _writeIdx } from 'fs';
const IDX_FILE = new URL('./.gfg-agm-ids.json', import.meta.url).pathname;
function knownOrders() {
  try {
    if (existsSync(IDX_FILE)) {
      const s = JSON.parse(_readIdx(IDX_FILE, 'utf8'));
      if (Array.isArray(s)) return s.filter(x => x && x.id != null && x.game != null);
    }
  } catch (e) {}
  return [];
}
function rememberOrder(game, orderId, maker, stakeUsdCents, seats) {
  try {
    const list = knownOrders();
    if (!list.some(x => Number(x.id) === Number(orderId))) {
      list.push({ game: Number(game), id: orderId, maker, stake_usd_cents: Number(stakeUsdCents), seats: Number(seats) });
      _writeIdx(IDX_FILE, JSON.stringify(list));
    }
  } catch (e) { /* fail-open */ }
}

export async function agmPost({ game, stakeUsdCents, seats, maker }) {
  // Server-side balance guard: a maker's OPEN orders + this new one can never
  // exceed their live USDC balance. This prevents "fake orders" from stale
  // balances. (On devnet USDC is test coin; the rule still holds.)
  try {
    const bal = await walletBalances(maker);
    if (bal.usdc != null) {
      const open = await openOrderTotalFor(maker, game);
      if (open + Number(stakeUsdCents) > Math.round(bal.usdc * 100)) {
        throw new Error('Not enough USDC: your open orders already use ' + (open / 100).toFixed(2) + ' of your ' + bal.usdc.toFixed(2) + ', and this needs ' + (Number(stakeUsdCents) / 100).toFixed(2) + '.');
      }
    }
  } catch (e) { if (e && e.message && e.message.indexOf('Not enough USDC') === 0) throw e; /* balance read failure is not a hard block on devnet */ }
  const orderId = Date.now();
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.postAgmOrder(game, new BN(orderId), new BN(stakeUsdCents), seats, new PublicKey(maker)).accounts({ payer: sponsor.publicKey, order: pda, systemProgram: SystemProgram.programId }).transaction());
  rememberOrder(game, orderId, maker, stakeUsdCents, seats);
  return { orderId, pda: pda.toBase58(), order: await readOrder(game, orderId), balance: await walletBalances(maker).catch(() => null) };
}

export async function agmList({ game, orderId, ids } = {}) {
  // Authoritative source: the ON-CHAIN order index (every user's orders).
  const ringIds = await readIndexIds();
  let wantedIds = ringIds;
  if (orderId != null) wantedIds = ringIds.filter(x => Number(x) === Number(orderId));
  // Supplement with locally-known ids (legacy orders posted before the index).
  const sup = knownOrders().map(e => Number(e.id)).filter(x => x && !ringIds.includes(x));
  if (ids) {
    const sup2 = String(ids).split(',').map(Number).filter(Boolean).filter(x => !ringIds.includes(x));
    for (const x of sup2) if (!sup.includes(x)) sup.push(x);
  }
  wantedIds = wantedIds.concat(sup);
  if (game != null) {
    // game filter needs the order's game; resolve each and filter
    const out = [];
    for (const id of Array.from(new Set(wantedIds))) {
      const orders = await Promise.all([1, 2, 3, 4].map(g => readOrder(g, id)));
      const live = orders.find(o => o);
      if (!live) continue;
      if (live.game === Number(game)) out.push(live);
    }
    out.sort((a, b) => Number(b.order_id) - Number(a.order_id));
    return { count: out.length, orders: out };
  }
  const out = [];
  for (const id of Array.from(new Set(wantedIds))) {
    // determine the order's game by trying known ones (game is in the PDA seed)
    const o1 = await readOrder(1, id);
    if (o1) { out.push(o1); continue; }
    const o2 = await readOrder(2, id);
    if (o2) { out.push(o2); continue; }
    const o3 = await readOrder(3, id);
    if (o3) { out.push(o3); continue; }
    const o4 = await readOrder(4, id);
    if (o4) { out.push(o4); continue; }
    out.push({ order_id: id, game: game != null ? Number(game) : 1, status: 'missing' });
  }
  out.sort((a, b) => Number(b.order_id) - Number(a.order_id));
  return { count: out.length, orders: out };
}

async function openOrderTotalFor(maker, game) {
  const ringIds = await readIndexIds();
  let total = 0;
  for (const id of ringIds.slice(0, 100)) {
    const o = await readOrder(game, id);
    if (o && o.maker === maker && (o.status === 0 || o.status === 2)) total += Number(o.stake_usd_cents) * Math.max(1, Number(o.seats));
  }
  return total;
}

export async function agmMatch({ game, orderId, taker }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.status !== 0) throw new Error('order is no longer open (status ' + order.status + ')');
  if (taker === 'guest' || !taker) taker = Keypair.generate().publicKey.toBase58(); // relay generates a real next-wallet
  if (taker === order.maker) throw new Error('a wallet cannot match its own order');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.matchAgmOrder(game, new BN(orderId), new PublicKey(taker)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  return { order: await readOrder(game, orderId) };
}

export async function agmLock({ game, orderId, winnerSeat }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.status !== 2) throw new Error('order must be matched before lock (status ' + order.status + ')');
  const pda = orderPda(game, orderId);
  const stl = settlementPda(orderId);
  await sendTx(await prog.methods.lockAgmMatch(game, new BN(orderId), winnerSeat).accounts({ signer: sponsor.publicKey, order: pda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  return { order: await readOrder(game, orderId), pot_usd_cents: Number(order.stake_usd_cents) * Number(order.seats) };
}

export async function agmSettle({ game, orderId }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.settleAgmMatch(game, new BN(orderId)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  return { order: await readOrder(game, orderId) };
}

export async function agmCancel({ game, orderId, maker }) {
  const order = await readOrder(game, orderId);
  if (!order) throw new Error('order not found on-chain');
  if (order.maker !== maker) throw new Error('only the maker can cancel');
  const pda = orderPda(game, orderId);
  await sendTx(await prog.methods.cancelAgmOrder(game, new BN(orderId)).accounts({ signer: sponsor.publicKey, order: pda }).transaction());
  return { order: await readOrder(game, orderId) };
}

export async function agmP2cFund({ game, amountUsdCents }) {
  const pda = bankPda(game);
  const bank = await readBank(game);
  if (!bank) await sendTx(await prog.methods.p2cFund(game, new BN(amountUsdCents)).accounts({ signer: sponsor.publicKey, bank: pda, systemProgram: SystemProgram.programId }).transaction());
  else await sendTx(await prog.methods.p2cFund(game, new BN(amountUsdCents)).accounts({ signer: sponsor.publicKey, bank: pda, systemProgram: SystemProgram.programId }).transaction());
  return { bank: await readBank(game) };
}

export async function agmP2cSettle({ game, orderId, computerSeat, computerWon }) {
  const stl = settlementPda(orderId);
  const pda = bankPda(game);
  await sendTx(await prog.methods.p2cSettle(game, new BN(orderId), computerSeat, !!computerWon).accounts({ signer: sponsor.publicKey, bank: pda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  return { bank: await readBank(game) };
}

export async function agmBank({ game }) {
  return { bank: await readBank(game) };
}