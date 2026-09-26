// scripts/clock-smoke.mjs — arc2m1b: per-seat clocks, timeout to forfeit, finish_forfeit.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const BOARD = Buffer.from('gfgboard');
const CLOCK = Buffer.from('gfgclock');
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { if (tx && typeof tx.then === 'function') tx = await tx; tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;
const REF = (Date.now() % 90000) + 700;
const [board] = PublicKey.findProgramAddressSync([BOARD, Buffer.from([GAME]), new BN(REF).toArrayLike(Buffer, 'le', 8)], PROGRAM);
const [clock] = PublicKey.findProgramAddressSync([CLOCK, Buffer.from([GAME]), new BN(REF).toArrayLike(Buffer, 'le', 8)], PROGRAM);

// 2 human players, $5 each, 15s turns, 60s max
const p2 = [sponsor.publicKey, Keypair.generate().publicKey];
await send(prog.methods.startMatch(GAME, new BN(REF), p2, 2, new BN(500), new BN(2), new BN(180)).accounts({ payer: sponsor.publicKey, board, systemProgram: SystemProgram.programId }).transaction());
await send(prog.methods.beginMatch(GAME, new BN(REF)).accounts({ signer: sponsor.publicKey, board }).transaction());
console.log('board started');

await send(prog.methods.startMatchClocks(GAME, new BN(REF)).accounts({ signer: sponsor.publicKey, board, clock, systemProgram: SystemProgram.programId }).transaction());
let c = await prog.account.matchClock.fetch(clock);
console.log('clock init:', 'turn_secs', Number(c.turnSecs), 'cap', c.timeoutCap, 'deadline0', Number(c.deadlines[0]), 'deadline1', Number(c.deadlines[1]));

// seat 0 commits a move, touches its clock (deadline0 resets ahead)
await send(prog.methods.commitMove(GAME, new BN(REF), 0, Array(32).fill(7)).accounts({ signer: sponsor.publicKey, board }).transaction());
await send(prog.methods.touchSeatClock(GAME, new BN(REF), 0).accounts({ signer: sponsor.publicKey, board, clock }).transaction());
c = await prog.account.matchClock.fetch(clock);
console.log('after touch: deadline0', Number(c.deadlines[0]), '> now', Math.floor(Date.now()/1000));

// seat 1 stalls -> backdate its deadline artificially? We can't backdate on-chain;
// instead drive 3 timeouts by waiting real seconds with turn_secs=2.
await sleep(2200);
for (let i = 1; i <= 3; i++) {
  await send(prog.methods.timeoutSeat(GAME, new BN(REF), 1).accounts({ signer: sponsor.publicKey, board, clock }).transaction());
  c = await prog.account.matchClock.fetch(clock);
  console.log(`timeout #${i}: timeouts1=${c.timeouts[1]} forfeited1=${c.forfeited[1]}`);
  if (i < 3) await sleep(2200); // wait out the renewed window
}

// forfeited seat 1 must NOT win via finish_forfeit
let blocked = false;
try {
  const tx = await prog.methods.finishForfeit(GAME, new BN(REF), 1).accounts({ signer: sponsor.publicKey, board, clock }).transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
} catch (e) { blocked = true; console.log('forfeited seat finish blocked:', 'YES'); }

// healthy seat 0 wins
await send(prog.methods.finishForfeit(GAME, new BN(REF), 0).accounts({ signer: sponsor.publicKey, board, clock }).transaction());
const b = await prog.account.matchBoard.fetch(board);
console.log('board:', 'status', b.status, 'winner_seat', b.winnerSeat);

const pass = blocked && b.status === 2 && b.winnerSeat === 0 && (await prog.account.matchClock.fetch(clock)).forfeited[1] === 1;
console.log('CLOCK/FOEFEIT PASS (timeouts cap, forfeit blocks win, healthy seat finishes):', pass ? 'YES' : 'NO');
process.exit(0);