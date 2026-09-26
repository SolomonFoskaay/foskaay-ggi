// scripts/matchboard-smoke.mjs — Arc2 M1-D smoke: on-chain match board lifecycle.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { createHash } from 'crypto';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const MATCHBOARD_SEED = Buffer.from('gfgboard');
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;           // ludo
const REF = 900001;
const p2 = Keypair.generate().publicKey;
const boardPda = PublicKey.findProgramAddressSync([MATCHBOARD_SEED, Buffer.from([GAME]), new BN(REF).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];

await send(await prog.methods.startMatch(GAME, new BN(REF), [sponsor.publicKey, p2], 2, new BN(100), new BN(60), new BN(1800))
  .accounts({ payer: sponsor.publicKey, board: boardPda, systemProgram: SystemProgram.programId }).transaction());
await send(await prog.methods.beginMatch(GAME, new BN(REF)).accounts({ signer: sponsor.publicKey, board: boardPda }).transaction());
const h1 = createHash('sha256').update('m1').digest();
const h2 = createHash('sha256').update('m2').digest();
await send(await prog.methods.commitMove(GAME, new BN(REF), 0, h1).accounts({ signer: sponsor.publicKey, board: boardPda }).transaction());
await send(await prog.methods.commitMove(GAME, new BN(REF), 1, h2).accounts({ signer: sponsor.publicKey, board: boardPda }).transaction());
await send(await prog.methods.finishMatch(GAME, new BN(REF), 0).accounts({ signer: sponsor.publicKey, board: boardPda }).transaction());

await sleep(2500);
const d = (await conn.getAccountInfo(boardPda)).data;
const res = {
  version: d[8],
  game: d[9],
  matchRef: Number(d.readBigUInt64LE(10)),
  status: d[18],
  playerCount: d[275],
  seats: d[276],
  stakeUsdCents: Number(d.readBigUInt64LE(277)),
  potUsdCents: Number(d.readBigUInt64LE(285)),
  turnSecs: Number(d.readBigUInt64LE(293)),
  maxSecs: Number(d.readBigUInt64LE(301)),
  moveCount: Number(d.readBigUInt64LE(381)),
  finishedAt: Number(d.readBigInt64LE(421)),
  winnerSeat: d[429],
};
console.log('BOARD:', JSON.stringify(res));
const pass = res.status === 2 && res.moveCount === 2 && res.winnerSeat === 0 && res.potUsdCents === 200 && res.turnSecs === 60;
console.log('MATCHBOARD PASS:', pass ? 'YES' : 'NO');
process.exit(0);