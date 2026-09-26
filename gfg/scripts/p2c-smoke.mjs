// scripts/p2c-smoke.mjs — arc2m7c: P2C bank fund + computer-loss + computer-win net math.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM = Buffer.from('gfgagm');
const AGMS = Buffer.from('gfgagms');
const P2C_GLOBAL = Buffer.from('gfgp2cbank');
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { if (tx && typeof tx.then === 'function') tx = await tx; tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;
const bankPda = PublicKey.findProgramAddressSync([P2C_GLOBAL], PROGRAM)[0];
const order = async (oid) => PublicKey.findProgramAddressSync([AGM, Buffer.from([GAME]), new BN(oid).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
const settle = (oid) => PublicKey.findProgramAddressSync([AGMS, new BN(oid).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];

// fund the bank with $1,000
await send(prog.methods.p2cFund(GAME, new BN(100_000)).accounts({ signer: sponsor.publicKey, bank: bankPda, systemProgram: SystemProgram.programId }).transaction());
console.log('bank funded $1000');

// stage each case with a fresh order id so re-runs never collide
let _s = Date.now() % 100000;
const oids = [_s + 1, _s + 2];

async function runCase(oid, winnerSeat) {
  const ord = await order(oid), stl = await settle(oid);
  const maker = Keypair.generate().publicKey;
  await send(prog.methods.postAgmOrder(GAME, new BN(oid), new BN(500), 2, maker).accounts({ payer: sponsor.publicKey, order: ord, systemProgram: SystemProgram.programId }).transaction());
  const taker = Keypair.generate();
  const tw = { publicKey: taker.publicKey, signTransaction: async (t) => { t.partialSign(taker); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(taker)); return ts; } };
  const progT = new Program(idl, new AnchorProvider(conn, tw, { commitment: 'confirmed', skipPreflight: true }));
  const t1 = await progT.methods.matchAgmOrder(GAME, new BN(oid), taker.publicKey).accounts({ signer: taker.publicKey, order: ord }).transaction();
  t1.feePayer = sponsor.publicKey;
  const s1 = await sendMagicTx(conn, t1, [sponsor, taker], { skipPreflight: true });
  await conn.confirmTransaction({ signature: s1 }, 'confirmed');
  await send(prog.methods.lockAgmMatch(GAME, new BN(oid), winnerSeat).accounts({ signer: sponsor.publicKey, order: ord, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
  await send(prog.methods.settleAgmMatch(GAME, new BN(oid)).accounts({ signer: sponsor.publicKey, order: ord }).transaction());
  // computer seat = 0 loses (winner was seat 1, human) unless winnerSeat===0
  const computerWon = winnerSeat === 0;
  await send(prog.methods.p2cSettle(GAME, new BN(oid), 0, computerWon).accounts({ signer: sponsor.publicKey, bank: bankPda, settlement: stl, systemProgram: SystemProgram.programId }).transaction());
}

const before = await prog.account.p2cBank.fetch(bankPda);
await runCase(oids[0], 1); // computer seat 0 loses -> bank net -500
await runCase(oids[1], 0); // computer seat 0 wins  -> bank net +400 (payout 900 - stake 500)
await sleep(2500);

const bank = await prog.account.p2cBank.fetch(bankPda);
const n = (x) => Number(x);
const pass = n(bank.balanceUsdCents) - n(before.balanceUsdCents) === -100
  && n(bank.dayNetUsdCents) - n(before.dayNetUsdCents) === -100
  && bank.dayWins - before.dayWins === 1
  && bank.dayLosses - before.dayLosses === 1
  && n(bank.trades) - n(before.trades) === 2
  && bank.status === 0;
console.log('P2C BANK:', JSON.stringify(bank, (k, v) => (v && v.type === 'BN') ? v.toString() : v));
console.log('P2C BANK PASS (fund $1000, -500 loss, +400 win, dayNet -100):', pass ? 'YES' : 'NO');
process.exit(0);