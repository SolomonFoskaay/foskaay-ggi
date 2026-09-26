// scripts/agm-settle-smoke.mjs — arc2m7f: post->match->lock, verify 10% fee math.
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
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;
const OID = 920003;
const MAKER = Keypair.generate();
const TAKER = Keypair.generate();
const orderPda = PublicKey.findProgramAddressSync([AGM, Buffer.from([GAME]), new BN(OID).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
const settlePda = PublicKey.findProgramAddressSync([AGMS, new BN(OID).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];

await send(await prog.methods.postAgmOrder(GAME, new BN(OID), new BN(500), 2, MAKER.publicKey).accounts({ payer: sponsor.publicKey, order: orderPda, systemProgram: SystemProgram.programId }).transaction());
// match with taker (sponsor pays fee, both sign like the E smoke)
const tw = { publicKey: TAKER.publicKey, signTransaction: async (t) => { t.partialSign(TAKER); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(TAKER)); return ts; } };
const progT = new Program(idl, new AnchorProvider(conn, tw, { commitment: 'confirmed', skipPreflight: true }));
const t1 = await progT.methods.matchAgmOrder(GAME, new BN(OID), TAKER.publicKey).accounts({ signer: TAKER.publicKey, order: orderPda }).transaction();
t1.feePayer = sponsor.publicKey;
const s1 = await sendMagicTx(conn, t1, [sponsor, TAKER], { skipPreflight: true });
await conn.confirmTransaction({ signature: s1 }, 'confirmed');

await send(await prog.methods.lockAgmMatch(GAME, new BN(OID), 0).accounts({ signer: sponsor.publicKey, order: orderPda, settlement: settlePda, systemProgram: SystemProgram.programId }).transaction());
await send(await prog.methods.settleAgmMatch(GAME, new BN(OID)).accounts({ signer: sponsor.publicKey, order: orderPda }).transaction());

await sleep(2500);
const od = (await conn.getAccountInfo(orderPda)).data;
const sd = (await conn.getAccountInfo(settlePda)).data;
const order = { status: od[59] };
const settle = {
  orderId: Number(sd.readBigUInt64LE(9)),
  game: sd[17],
  potUsdCents: Number(sd.readBigUInt64LE(18)),
  feeUsdCents: Number(sd.readBigUInt64LE(26)),
  seats: sd[34],
  winnerSeat: sd[35],
  payoutUsdCents: Number(sd.readBigUInt64LE(36)),
};
console.log('ORDER status:', order.status);
console.log('SETTLEMENT:', JSON.stringify(settle));
const pass = order.status === 1 && settle.potUsdCents === 1000 && settle.feeUsdCents === 100 && settle.payoutUsdCents === 900 && settle.winnerSeat === 0;
console.log('AGM SETTLE PASS (pot $10, fee $1, payout $9):', pass ? 'YES' : 'NO');
process.exit(0);