// bench-roll-comparison.mjs — the 3-way dice-latency comparison:
//
//   A) MagicBlock ER  (gasless, delegated VRF)   — "in-game" path players use
//   B) Base-chain VRF (paid queue, on-chain)     — the "old web3" fallback
//   C) Web2 local     (Math.random / animation)  — the "classic web2" baseline
//
// Table = time from "player taps Roll" to "dice faces are known".
//   A & B measure send -> VRF result (the account's lastClientSeed updates).
//   C measures local roll computation (dice face + double-die rollassemble).
//
// Payer is always the SPONSOR keypair for the base leg (app pays). No player
// wallet ever needs funding — matches the product's gasless promise.
//
// Run:  node scripts/lab/bench-roll-comparison.mjs   (devnet must be healthy)
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { pickErRpcUrl } from '../../src/gfg-rpc.js';

const PROGRAM_ID = new PublicKey('CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ');
const ER_URL = pickErRpcUrl();
const ER_WS = ER_URL.replace(/^https:\/\//, 'wss://');
const BASE_ENDPOINT = 'https://rpc.magicblock.app/devnet';
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc'); // free ER VRF queue
const BASE_QUEUE = new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh'); // paid base queue
const PLAYER_SEED = Buffer.from('gfgplayerd');
const N_ROLLS = process.env.N_ROLLS ? parseInt(process.env.N_ROLLS) : 5;
const N_WEB2 = 5000;

const idl = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/src/gfg-dice-idl.json', 'utf8'));

function loadSponsor() {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
const sponsor = loadSponsor();

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// PlayerDice = u8 disc(8) + last_roll1:u8 + last_roll2:u8 + last_client_seed:u8 + last_request_ts:i64 (19 bytes)
function decodePlayerDice(data) {
  if (!data || data.length < 19) return null;
  return {
    lastRoll1: data.readUInt8(8),
    lastRoll2: data.readUInt8(9),
    lastClientSeed: data.readUInt8(10),
    lastRequestTs: data.readBigInt64LE(11),
  };
}

// ---- C) Web2 local dice ------------------------------------------------
// What the game does for AI turns today (public/games/ludo-lab/mechanics/actions/
// dice.js): one Math.random per face. Also time a "full local turn" path with
// an animation-friendly yield (like rAF would naturally impose ~one frame).
function web2Local() {
  const t = [];
  const run = () => {
    const a = Math.floor(Math.random() * 6) + 1;
    const b = Math.floor(Math.random() * 6) + 1;
    return a + b;
  };
  for (let i = 0; i < 100; i++) run(); // warm
  for (let i = 0; i < N_WEB2; i++) {
    const t0 = process.hrtime.bigint();
    run();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6); // ms
  }
  return t;
}

// ---- A & B) shared roll-and-wait ---------------------------------------
async function rollOn(conn, program, payer, authority, pda, queue, tag) {
  const seed = Math.floor(Math.random() * 256);
  const t0 = Date.now();
  const sig = await program.methods.rollDice(seed)
    .accounts({ player: pda, payer: payer.publicKey, playerAuthority: authority.publicKey, oracleQueue: queue })
    .rpc({ skipPreflight: true, commitment: 'confirmed' });
  const tSend = Date.now() - t0;

  // Result = the account's lastClientSeed flips to our seed.
  const deadline = Date.now() + 30000;
  let rolls = null;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      const info = await conn.getAccountInfo(pda, 'processed');
      const st = info && decodePlayerDice(info.data);
      if (st && st.lastClientSeed === seed) {
        rolls = [st.lastRoll1, st.lastRoll2];
        break;
      }
    } catch (_) {}
  }
  if (!rolls) throw new Error(`${tag}: roll seed=${seed} never settled (sig ${sig})`);
  const tCb = Date.now() - t0;
  console.log(`  ${tag} roll: send-confirm ${tSend}ms  to-result ${tCb}ms  -> ${rolls[0]} + ${rolls[1]}`);
  return { tSend, tCb };
}

// ---- B) base-chain leg: sponsor is payer against the PAID queue ---------
async function baseLeg() {
  console.log('\n=== B) Base-chain VRF (paid queue, on-chain) ===');
  // Fresh player authority each run; PDA keyed to it, owned by player_authority.
  const pa = Keypair.generate();
  const pda = PublicKey.findProgramAddressSync([PLAYER_SEED, pa.publicKey.toBytes()], PROGRAM_ID)[0];
  console.log(`  playerAuthority: ${pa.publicKey.toBase58()}`);
  console.log(`  pda: ${pda.toBase58()}`);

  const conn = new Connection(BASE_ENDPOINT, 'confirmed');
  const program = new Program(idl, new AnchorProvider(conn, mkWallet(sponsor), AnchorProvider.defaultOptions()));

if (!(await conn.getAccountInfo(pda))) {
    console.log('  initialize (sponsor pays rent)...');
    await program.methods.initialize()
      .accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: pa.publicKey })
      .rpc({ skipPreflight: true, commitment: 'confirmed' });
  }

  const s = [], c = [];
  for (let i = 0; i < N_ROLLS; i++) {
    const r = await rollOn(conn, program, sponsor, pa, pda, BASE_QUEUE, 'base');
    s.push(r.tSend); c.push(r.tCb);
  }
  return { s, c };
}

// ---- A) ER leg: reuse the sponsor's delegated PDA (gasless) -------------
async function erLeg() {
  console.log('\n=== A) MagicBlock ER (gasless, delegated VRF) ===');
  const pa = sponsor; // sponsor's own PDA is already delegated to the ER
  const pda = PublicKey.findProgramAddressSync([PLAYER_SEED, pa.publicKey.toBytes()], PROGRAM_ID)[0];
  console.log(`  playerAuthority: ${pa.publicKey.toBase58()}`);
  console.log(`  pda: ${pda.toBase58()} (delegated — no base cost per roll)`);

  const conn = new Connection(ER_URL, { wsEndpoint: ER_WS, commitment: 'processed' });
  const program = new Program(idl, new AnchorProvider(conn, mkWallet(pa), AnchorProvider.defaultOptions()));

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const info = await conn.getAccountInfo(pda, 'processed'); if (info && info.data.length > 0) break; } catch (_) {}
  }
  console.log('  ER account picked up.');

  const s = [], c = [];
  for (let i = 0; i < N_ROLLS; i++) {
    const r = await rollOn(conn, program, pa, pa, pda, ER_QUEUE, 'ER');
    s.push(r.tSend); c.push(r.tCb);
  }
  return { s, c };
}

function pct95(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0; }

function summarize(name, t) {
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sorted = t.slice().sort((x, y) => x - y);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  console.log(`  ${name}: avg ${avg(t).toFixed(1)}ms  p95 ${(p95 ?? 0).toFixed(1)}ms  (n=${t.length})`);
  return { avg: avg(t), p95, min: sorted[0] };
}

async function main() {
  console.log(`Sponsor (base-leg payer): ${sponsor.publicKey.toBase58()}\n`);

  const leg = process.env.LEG || 'all'; // base | er | web2 | all
  const a = (await runLeg(leg)) || {};
  const w = a.web2 ?? web2Local();

  console.log('\n\n===== COMPARISON TABLE (devnet, real transactions) =====');
  const row = (label, dur) => {
    if (!dur) return `| ${label} | n/a | n/a | n/a | n/a |`;
    return `| ${label} | ${dur.avg.toFixed(0)}ms | ${dur.p95.toFixed(0)}ms | ${dur.min.toFixed(0)}ms | ~${(dur.avg / 1000).toFixed(2)}s |`;
  };
  console.log('| Path | avg | p95 | min | fee to player |');
  console.log('| --- | --- | --- | --- | --- |');
  if (a.a) console.log(row('MagicBlock ER roll (gasless VRF)', { avg: a.a.c.reduce((x, y) => x + y, 0) / a.a.c.length, p95: pct95(a.a.c), min: Math.min(...a.a.c) }));
  if (a.b) console.log(row('Base-chain VRF roll (paid queue)', { avg: a.b.c.reduce((x, y) => x + y, 0) / a.b.c.length, p95: pct95(a.b.c), min: Math.min(...a.b.c) }));
  console.log(row('Web2 local dice (Math.random)', { avg: w.reduce((x, y) => x + y, 0) / w.length, p95: pct95(w), min: Math.min(...w) }));
}

async function runLeg(leg) {
  const out = {};
  if (leg === 'base' || leg === 'all') {
    try { out.b = await baseLeg(); }
    catch (e) {
      console.error('  base leg FAILED:', e.message, '| keys:', Object.keys(e).join(','));
      if (e.transactionMessage) console.error('  txMsg:', e.transactionMessage);
      if (e.logs) console.error('  logs:', e.logs.slice(-8).join('\n'));
      else if (typeof e.getLogs === 'function') { try { console.error('  logs:', (await e.getLogs()).slice(-8).join('\n')); } catch (_e) {} }
    }
  }
  if (leg === 'er' || leg === 'all') {
    try { out.a = await erLeg(); }
    catch (e) { console.error('  ER leg FAILED:', e.message); }
  }
  if (leg === 'web2' || leg === 'all') out.web2 = web2Local();
  return out;
}

main().catch(e => { console.error('bench failed:', e); process.exit(1); });