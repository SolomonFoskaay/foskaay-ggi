// scripts/competitions-relay.mjs — M7 COMPETITION RELAY (server-side,
// sponsor-signed, base-layer admin writes). Mirrors affiliate-relay: the
// sponsor (admin/creator) signs every competition lifecycle write on-chain so
// the framework is authoritative + auditable. Instances live at
// [gfgcomp2, creator, seq]; winner records at [gfgwin, comp, rank].
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { addWin, addEntry, hasEntry, listEntries, tallyFor, readTierFor, boostFor } from './competitions-wins.mjs';
import { PLAN_LADDER } from './plans-config.mjs';
import { getHandleForWallet } from './handle.mjs';
import bs58 from 'bs58';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const COMP2_SEED = Buffer.from('gfgcomp2');
const GFGWIN_SEED = Buffer.from('gfgwin');
const DELEG_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
import { readFileSync as _readFS, writeFileSync as _writeFS, existsSync as _existsFS } from 'fs';
const META_FILE = new URL('./gfg-comp-meta.json', import.meta.url).pathname;
export function saveCompMeta(creator, seq, meta) {
  try {
    let m = {}; if (_existsFS(META_FILE)) { try { m = JSON.parse(_readFS(META_FILE, 'utf8')) || {}; } catch (e) { m = {}; } }
    m[creator + ':' + seq] = meta;
    _writeFS(META_FILE, JSON.stringify(m));
  } catch (e) { /* fail-open */ }
}
export function getCompMeta(creator, seq) {
  try { if (_existsFS(META_FILE)) { const m = JSON.parse(_readFS(META_FILE, 'utf8')) || {}; return m[creator + ':' + seq] || {}; } } catch (e) {}
  return {};
}

const AS_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const AS_URL = 'https://devnet-as.magicblock.app/';
const BASE = baseRpcUrl();

export function compPda(creator, seq) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(Number(seq) >>> 0, 0);
  return PublicKey.findProgramAddressSync([COMP2_SEED, new PublicKey(creator).toBytes(), seqBuf], PROGRAM)[0];
}
export function tallyPda(comp, player) {
  return PublicKey.findProgramAddressSync([GFGWIN_SEED, new PublicKey(comp).toBytes(), new PublicKey(player).toBytes()], PROGRAM)[0];
}

function tallyDisc() {
  return bs58.encode(createHash('sha256').update('account:CompetitionTally').digest().subarray(0, 8));
}
// Durable on-chain win tallies for a competition (R13), region-resilient.
export async function onChainTallies({ creator, seq }) {
  const comp = compPda(creator, seq);
  const disc = tallyDisc();
  const regions = ['https://api.devnet.solana.com', BASE, 'https://devnet-as.magicblock.app/'];
  const filters = [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: 9, bytes: comp.toBase58() } }];
  for (const url of regions) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [PROGRAM.toBase58(), { encoding: 'base64', filters }] }) });
      const j = await r.json();
      const arr = (j && j.result) || [];
      return arr.map(a => {
        const d = Buffer.from(a.account.data[0], 'base64');
        return { player: d.length >= 73 ? bs58.encode(d.subarray(41, 73)) : '', wins: d.length >= 81 ? Number(d.readBigUInt64LE(73)) : 0, firstTs: d.length >= 89 ? Number(d.readBigInt64LE(81)) : 0, lastTs: d.length >= 97 ? Number(d.readBigInt64LE(89)) : 0 };
      });
    } catch (e) { /* next */ }
  }
  return [];
}

// Gasless-ER compliant win record (hard rule: base-layer only for one-time
// initialize + delegate; every win runs on the ER, zero fees). Same trust model
// as affiliate/gfgwin.
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t) => { t.partialSign(kp); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(kp)); return ts; } };
}
async function ensureTallyDelegated({ sponsor, program, conn, authority, player, comp, seq, tally }) {
  const info = await conn.getAccountInfo(tally);
  if (!info) {
    const tx = await program.methods.initializeCompetitionTally(new BN(seq))
      .accounts({ payer: sponsor.publicKey, playerAuthority: player, creator: authority, competition: comp, tally, systemProgram: SystemProgram.programId })
      .transaction();
    await send(conn, sponsor, tx);
  }
  const st = await getDelegationStatus(conn, tally).catch(() => null);
  if (!st || !st.isDelegated) {
    const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), tally.toBytes()], PROGRAM);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), tally.toBytes()], DELEG_PROGRAM);
    const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), tally.toBytes()], DELEG_PROGRAM);
    const tx = await program.methods.delegateCompetitionTally()
      .accounts({
        payer: sponsor.publicKey, playerAuthority: player, competition: comp, tally,
        bufferTally: buffer, delegationRecordTally: record, delegationMetadataTally: metadata,
        ownerProgram: PROGRAM, delegationProgram: DELEG_PROGRAM, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: AS_VALIDATOR, isSigner: false, isWritable: false }])
      .transaction();
    await send(conn, sponsor, tx);
  }
  return st && st.fqdn ? regionUrlForFqdn(st.fqdn) : AS_URL;
}
export async function ensureTally({ creator = null, seq, wallet: player }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const tally = tallyPda(comp, player);
  const region = await ensureTallyDelegated({ sponsor, program, conn, authority, player: new PublicKey(player), comp, seq, tally });
  return { tally: tally.toBase58(), region };
}

export async function recordWin({ creator = null, seq, ts, game, wallet: player }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const tally = tallyPda(comp, player);
  const region = await ensureTallyDelegated({ sponsor, program, conn, authority, player: new PublicKey(player), comp, seq, tally });
  // Gasless ER write (sponsor signs on the ER; zero base-layer per win).
  const erConn = createConnection(region, 'confirmed');
  const erProg = new Program(idl, new AnchorProvider(erConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const sig = await erProg.methods.recordCompetitionWin(new BN(seq), new BN(ts), game)
    .accounts({ payer: sponsor.publicKey, playerAuthority: new PublicKey(player), creator: authority, competition: comp, tally })
    .rpc();
  return { sig: String(sig), tally: tally.toBase58() };
}

export function winPda(comp, rank) {
  return PublicKey.findProgramAddressSync([GFGWIN_SEED, new PublicKey(comp).toBytes(), Buffer.from([Number(rank)])], PROGRAM)[0];
}

async function sponsorProgram() {
  const sponsor = loadSponsor();
  const conn = createConnection(BASE, 'confirmed');
  const provider = new AnchorProvider(conn, {
    publicKey: sponsor.publicKey,
    signTransaction: async (t) => { t.partialSign(sponsor); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
  }, { commitment: 'confirmed', skipPreflight: true });
  return { sponsor, conn, program: new Program(idl, provider) };
}

async function send(conn, sponsor, tx) {
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// ---- competition lifecycle -------------------------------------------------
export async function createCompetition({ creator = null, seq, name, games, tierBits, requireAll = 0, entryCost, entryFamilies, startsAt, endsAt, poolUsdCents, poolPoints, winnerCount, prizeShares, redemption = 0, payoutMode = 0 }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.createCompetition(
    new BN(seq), name, Buffer.from(games || []), tierBits, requireAll,
    new BN(entryCost), entryFamilies, new BN(startsAt), new BN(endsAt),
    new BN(poolUsdCents), new BN(poolPoints), winnerCount, (prizeShares || []).map(s => new BN(s)),
    redemption, payoutMode,
  ).accounts({ payer: sponsor.publicKey, competition: pda, systemProgram: SystemProgram.programId }).transaction();
  const sig = await send(conn, sponsor, tx);
  if (arguments[0] && (arguments[0].desc || arguments[0].redLabel || arguments[0].redAmount)) {
    saveCompMeta(authority.toBase58(), seq, { desc: arguments[0].desc, redLabel: arguments[0].redLabel, redAmount: arguments[0].redAmount, pool: arguments[0].pool });
  }
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function closeCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.closeCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function cancelCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.cancelCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function recordCompetitionWinner({ creator = null, seq, rank, player }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const winner = winPda(comp, rank);
  const tx = await program.methods.recordCompetitionWinner(new BN(seq), new BN(rank), new PublicKey(player))
    .accounts({ authority, competition: comp, winner, systemProgram: SystemProgram.programId }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), winner: winner.toBase58() };
}

export async function settleCompetition({ creator = null, seq }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const pda = compPda(authority, seq);
  const tx = await program.methods.settleCompetition(new BN(seq)).accounts({ authority, competition: pda }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), pda: pda.toBase58() };
}

export async function markWinnerPaid({ creator = null, seq, rank }) {
  const { sponsor, conn, program } = await sponsorProgram();
  const authority = creator ? new PublicKey(creator) : sponsor.publicKey;
  const comp = compPda(authority, seq);
  const winner = winPda(comp, rank);
  const tx = await program.methods.markWinnerPaid(new BN(seq), new BN(rank)).accounts({ authority, competition: comp, winner }).transaction();
  const sig = await send(conn, sponsor, tx);
  return { sig: String(sig), winner: winner.toBase58() };
}

// ---- reads -----------------------------------------------------------------
function compDisc() {
  return bs58.encode(createHash('sha256').update('account:CompetitionInstance').digest().subarray(0, 8));
}
export function decodeCompetition(d) {
  return {
    version: d.length >= 9 ? d[8] : 0,
    creator: d.length >= 41 ? bs58.encode(d.subarray(9, 41)) : '',
    seq: d.length >= 45 ? d.readUInt32LE(41) : 0,
    name: d.length >= 69 ? Buffer.from(d.subarray(45, 69)).toString('utf8').replace(/\0+$/, '') : '',
    games: Array.from(d.subarray(69, 69 + 4)).filter(x => x !== 0),
    gameCount: d.length >= 74 ? d[73] : 0,
    tierBits: d.length >= 75 ? d[74] : 0,
    requireAll: d.length >= 76 ? d[75] : 0,
    entryCost: d.length >= 84 ? Number(d.readBigUInt64LE(76)) : 0,
    entryFamilies: d.length >= 85 ? d[84] : 0,
    startsAt: d.length >= 93 ? Number(d.readBigInt64LE(85)) : 0,
    endsAt: d.length >= 101 ? Number(d.readBigInt64LE(93)) : 0,
    poolUsdCents: d.length >= 109 ? Number(d.readBigUInt64LE(101)) : 0,
    poolPoints: d.length >= 117 ? Number(d.readBigUInt64LE(109)) : 0,
    winnerCount: d.length >= 118 ? d[117] : 0,
    prizeShares: Array.from({ length: d.length >= 146 ? Math.min(d[117] || 0, 16) : 0 }, (_, i) => d.readUInt32LE(118 + i * 4)),
    redemption: d.length >= 183 ? d[182] : 0,
    payoutMode: d.length >= 184 ? d[183] : 0,
    status: d.length >= 185 ? d[184] : 0,
    settledTs: d.length >= 193 ? Number(d.readBigInt64LE(185)) : 0,
  };
}
export function decodeWinner(d) {
  return {
    version: d.length >= 9 ? d[8] : 0,
    comp: d.length >= 41 ? bs58.encode(d.subarray(9, 41)) : '',
    rank: d.length >= 42 ? d[41] : 0,
    player: d.length >= 74 ? bs58.encode(d.subarray(42, 74)) : '',
    points: d.length >= 82 ? Number(d.readBigUInt64LE(74)) : 0,
    usdCents: d.length >= 90 ? Number(d.readBigUInt64LE(82)) : 0,
    status: d.length >= 91 ? d[90] : 0,
    paidTs: d.length >= 99 ? Number(d.readBigInt64LE(91)) : 0,
  };
}

export async function getCompetition({ creator, seq }) {
  const conn = createConnection(BASE, 'confirmed');
  const pda = compPda(creator, seq);
  const info = await conn.getAccountInfo(pda);
  if (!info || !info.data) return null;
  return { pda: pda.toBase58(), ...decodeCompetition(info.data), ...getCompMeta(creator, seq) };
}

export async function listCompetitions({ creator } = {}) {
  const disc = compDisc();
  const regions = ['https://api.devnet.solana.com', BASE, 'https://devnet-as.magicblock.app/'];
  const filters = [{ memcmp: { offset: 0, bytes: disc } }];
  if (creator) filters.push({ memcmp: { offset: 9, bytes: creator } });
  for (const url of regions) {
    try {
      const body = {
        jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
        params: [PROGRAM.toBase58(), { encoding: 'base64', filters }],
      };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      const arr = (j && j.result) || [];
      return arr.map(a => {
        const d = Buffer.from(a.account.data[0], 'base64');
        return { pda: a.pubkey, ...decodeCompetition(d) };
      }).sort((x, y) => (x.seq || 0) - (y.seq || 0));
    } catch (e) { /* try next region */ }
  }
  return [];
}

export async function getWinners({ creator, seq }) {
  const conn = createConnection(BASE, 'confirmed');
  const comp = compPda(creator, seq);
  const list = [];
  const max = 16;
  for (let rank = 1; rank <= max; rank++) {
    const pda = winPda(comp, rank);
    const info = await conn.getAccountInfo(pda);
    if (!info || !info.data) continue;
    list.push({ pda: pda.toBase58(), ...decodeWinner(info.data) });
  }
  return list;
}

// ---- window-fresh leaderboard (Final Points, live tier boost) ---------------
function planBoosts() {
  const map = {};
  for (const k of Object.keys(PLAN_LADDER)) map[k] = (PLAN_LADDER[k].compFinalBoost || 1000) / 1000;
  return map;
}
export async function getBoard({ creator, seq }) {
  const comp = await getCompetition({ creator, seq });
  if (!comp) throw new Error('competition not found');
  const now = Date.now();
  // Prefer the DURABLE on-chain tallies (R13); fall back to the local file ledger.
  const tallies = await onChainTallies({ creator, seq });
  const entries = tallies.length
    ? tallies.map(t => ({ wallet: t.player, totalPoints: t.wins }))
    : listEntries({ compCreator: creator, seq }).map(function (wt) {
        return { wallet: wt, totalPoints: tallyFor({ compCreator: creator, seq, wallet: wt }).filter(w => w.ts >= comp.startsAt && w.ts <= comp.endsAt).length };
      });
  const rows = [];
  for (const en of entries) {
    const wallet = en.wallet;
    const totalPoints = en.totalPoints || 0; // wins metric (window-fresh by instructions when on-chain)
    const level = await readTierFor(wallet);
    const boost = boostFor(level, comp, planBoosts());
    const finalPoints = boost != null ? totalPoints * boost : null; // null = hidden (L1 / non-qualifying)
    let handle = null;
    try { handle = getHandleForWallet ? getHandleForWallet(wallet) : null; } catch (e) { /* best-effort */ }
    rows.push({ wallet, handle, totalPoints, level: level || 1, boost, finalPoints, hidden: boost == null });
  }
  const visible = rows.filter(r => !r.hidden).sort((a, b) => (b.finalPoints - a.finalPoints) || (a.wallet < b.wallet ? -1 : 1));
  const hidden = rows.filter(r => r.hidden);
  visible.forEach((r, i) => { r.position = i + 1; r.prizePosition = (i < comp.winnerCount) ? i + 1 : null; });
  return { seq, name: comp.name, status: comp.status, startsAt: comp.startsAt, endsAt: comp.endsAt, endsAtMs: comp.endsAt * 1000, autoStopped: now >= comp.endsAt * 1000, poolUsdCents: comp.poolUsdCents, poolPoints: comp.poolPoints, winnerCount: comp.winnerCount, prizeShares: comp.prizeShares, desc: comp.desc, redLabel: comp.redLabel, redAmount: comp.redAmount, board: visible, hidden };
}