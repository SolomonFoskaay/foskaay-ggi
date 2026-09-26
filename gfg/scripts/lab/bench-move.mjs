// bench-move.mjs — ER vs base-layer latency benchmark for the gfg-move lab.
// Measures:
//   PlayerA (delegated to ER):
//     E3 ER roll_dice -> callback (delegated VRF, ER queue, gasless)
//     E1 ER game_move  (legality-checked state write, gasless)
//   PlayerB (stays on base layer):
//     E4 BASE roll_dice -> callback (base VRF queue, sponsor pays)
//     E2 BASE game_move  (base-layer, sponsor pays)
// Prints a comparison table. Nothing here touches the live gfg-dice program.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import '../load-env.mjs'; // load .env (Alchemy key) before resolving the RPC chain
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, pickErRpcUrl } from '../../src/gfg-rpc.js';

const PROGRAM_ID = new PublicKey('CkzrmH8NjyT4GPxq4qvK3v4HLujnJcPHyLJViqrpHFcj');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const BASE_URL = baseRpcUrl();
const ER_URL = pickErRpcUrl();
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const BASE_QUEUE = new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh');
const GAME_SEED = Buffer.from('gfgmove');
const N_MOVES = 20;

const idl = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/programs/target/idl/gfg_move.json', 'utf8'));

function loadSponsor() {
  const path = join(homedir(), '.config', 'solana', 'id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}
const sponsor = loadSponsor();

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

function gamePda(playerPubkey) {
  return PublicKey.findProgramAddressSync([GAME_SEED, playerPubkey.toBytes()], PROGRAM_ID);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForErPickup(pda, timeoutMs = 30000) {
  const conn = new Connection(ER_URL, 'confirmed');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await conn.getAccountInfo(pda);
      // The ER hosts the account under its ORIGINAL program owner once picked
      // up — so existence with data is the signal, not owner===DELEGATION_PROGRAM.
      if (info && info.owner.equals(PROGRAM_ID) && info.data.length > 0) return true;
    } catch (_) {}
    await sleep(400);
  }
  return false;
}

function baseConn() {
  return createConnection(BASE_URL, 'confirmed'); // polling confirm (Alchemy lacks signatureSubscribe)
}

function baseProgram() {
  return new Program(idl, new AnchorProvider(baseConn(), mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
}

// Send a base-layer tx through the Magic Router with the correct per-layer
// blockhash (getBlockhashForAccounts). .rpc() would use getLatestBlockhash,
// which the Router answers with ITS OWN layer blockhash (invalid on base).
async function sendBase(conn, sponsor, txPromise) {
  const tx = await txPromise;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

// init the game PDA only (for base-layer player B).
async function ensureInit(playerPubkey) {
  const pda = gamePda(playerPubkey)[0];
  const conn = baseConn();
  const program = baseProgram();
  if (!(await conn.getAccountInfo(pda))) {
    await sendBase(conn, sponsor,
      program.methods.initGame()
        .accounts({ game: pda, payer: sponsor.publicKey, playerAuthority: playerPubkey, systemProgram: SystemProgram.programId })
        .transaction()
    );
  }
  return pda;
}

// init + delegate (for ER player A).
async function ensureInitDelegated(playerPubkey) {
  const pda = await ensureInit(playerPubkey);
  const baseConn0 = baseConn();
  const prog = baseProgram();
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

  // Already delegated? Authoritative check is the Router's getDelegationStatus
  // (getAccountInfo.owner comparison breaks with the Router primary RPC).
  try {
    const existing = await getDelegationStatus(baseConn0, pda);
    if (existing && existing.isDelegated) return pda;
  } catch (_) {}

  await sendBase(baseConn0, sponsor,
    prog.methods.delegate()
      .accounts({
        payer: sponsor.publicKey,
        playerAuthority: playerPubkey,
        game: pda,
        bufferGame: buffer,
        delegationRecordGame: record,
        delegationMetadataGame: metadata,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
      .transaction()
  );

  // Confirm the Router now reports the account as delegated (this is the
  // authoritative signal — base-layer owner never appears on the Router RPC).
  const baseDeadline = Date.now() + 25000;
  let delegated = false;
  while (Date.now() < baseDeadline) {
    try {
      const s = await getDelegationStatus(baseConn0, pda);
      console.error(`[poll] delegated=${s && s.isDelegated} fqdn=${s && (s.fqdn || '-')}`);
      if (s && s.isDelegated) { delegated = true; break; }
    } catch (_) {}
    await sleep(1000);
  }
  if (!delegated) throw new Error('delegation tx did not register on the Magic Router');

  const ok = await waitForErPickup(pda);
  if (!ok) throw new Error('ER did not pick up the delegated game PDA');
  return pda;
}

function fmt(ms) {
  return ms < 1500 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function connFor(url) {
  // Polling confirm everywhere (MagicBlock's own confirm strategy); the ER RPC
  // supports getSignatureStatuses, and it avoids web3's WS signatureSubscribe
  // flakiness that surfaces as the opaque "Unknown action" error.
  return createConnection(url, 'confirmed');
}

// Unified tx sender: base-layer -> sendMagicTx (Router-native blockhash);
// ER -> plain .methods().rpc() (the ER RPC serves its own valid blockhash).
function sendProgramMethod(url, methods, wallet) {
  if (url === ER_URL) {
    return methods.rpc();
  }
  const conn = connFor(url);
  const txPromise = methods.transaction();
  return sendBase(conn, wallet instanceof Keypair ? wallet : sponsor, txPromise);
}

async function assignRoll(url, wallet, playerPubkey, pda, queue) {
  const program = new Program(idl, new AnchorProvider(connFor(url), mkWallet(wallet), { commitment: 'confirmed', skipPreflight: true }));
  const seed = Math.floor(Math.random() * 250) + 1;
  await sendProgramMethod(url, program.methods.rollDice(seed)
    .accounts({ game: pda, payer: wallet.publicKey, playerAuthority: playerPubkey, oracleQueue: queue }), wallet);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const state = await program.account.gameState.fetch(pda);
      if (state.lastClientSeed === seed) return state;
    } catch (_) {}
  }
  throw new Error('VRF roll never landed (assignRoll)');
}

async function benchMoves(label, url, wallet, playerPubkey, pda, roll) {
  const program = new Program(idl, new AnchorProvider(connFor(url), mkWallet(wallet), { commitment: 'confirmed', skipPreflight: true }));
  const times = [];
  for (let i = 0; i < N_MOVES; i++) {
    // game rule: to - from === roll, both on the 52-cell board. Pick `from`
    // low enough that from + roll stays in range (no wrap -> no IllegalMove).
    const from = i % (52 - roll);
    const to = from + roll;
    const t0 = Date.now();
    await sendProgramMethod(url, program.methods.gameMove(from, to, roll)
      .accounts({ game: pda, payer: wallet.publicKey, playerAuthority: playerPubkey }), wallet);
    times.push(Date.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p = (i) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * i))];
  console.log(`${label.padEnd(30)} n=${N_MOVES}  avg ${fmt(avg).padEnd(9)}  p50 ${fmt(p(0.5)).padEnd(9)}  p95 ${fmt(p(0.95)).padEnd(9)}  worst ${fmt(p(1))}`);
}

async function benchRoll(label, url, wallet, playerPubkey, pda) {
  const program = new Program(idl, new AnchorProvider(connFor(url), mkWallet(wallet), { commitment: 'confirmed', skipPreflight: true }));
  const queue = url === ER_URL ? ER_QUEUE : BASE_QUEUE;
  const seed = Math.floor(Math.random() * 250) + 1;
  const t0 = Date.now();
  await sendProgramMethod(url, program.methods.rollDice(seed)
    .accounts({ game: pda, payer: wallet.publicKey, playerAuthority: playerPubkey, oracleQueue: queue }), wallet);
  const tSend = Date.now() - t0;
  let tCb = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const state = await program.account.gameState.fetch(pda);
      if (state.lastClientSeed === seed) { tCb = Date.now() - t0; break; }
    } catch (_) {}
  }
  console.log(`${label.padEnd(30)} send-confirm ${fmt(tSend).padEnd(9)}  to-callback ${tCb == null ? 'TIMEOUT' : fmt(tCb)}`);
  // Return the VRF-produced last_roll (1..6) that gameMove must match — NOT the
  // client seed (1..250) we sent.
  const state = await program.account.gameState.fetch(pda);
  return Number(state.lastRoll);
}

async function main() {
  const playerA = Keypair.generate(); // delegated -> ER benches
  const playerB = Keypair.generate(); // base layer benches

  const pdaA = await ensureInitDelegated(playerA.publicKey);
  const pdaB = await ensureInit(playerB.publicKey);
  console.log('[setup] playerA (delegated) pda:', pdaA.toBase58());
  console.log('[setup] playerB (base)      pda:', pdaB.toBase58(), '\n');

  console.log('--- PlayerA on ER ---');
  const stateA = await assignRoll(ER_URL, playerA, playerA.publicKey, pdaA, ER_QUEUE);
  console.log(`[A] roll=${stateA.lastRoll}`);
  const seedA = await benchRoll('E3 ER roll_dice (ER queue)', ER_URL, playerA, playerA.publicKey, pdaA);
  await benchMoves('E1 ER game_move (gasless)', ER_URL, playerA, playerA.publicKey, pdaA, seedA);
  console.log('');

  console.log('--- PlayerB on base layer ---');
  const stateB = await assignRoll(BASE_URL, sponsor, playerB.publicKey, pdaB, BASE_QUEUE);
  console.log(`[B] roll=${stateB.lastRoll}`);
  const seedB = await benchRoll('E4 BASE roll_dice (base queue)', BASE_URL, sponsor, playerB.publicKey, pdaB);
  await benchMoves('E2 BASE game_move (paid)', BASE_URL, sponsor, playerB.publicKey, pdaB, seedB);
  console.log('\nDone.');
}

main().catch(e => { console.error('bench failed:', e); process.exit(1); });