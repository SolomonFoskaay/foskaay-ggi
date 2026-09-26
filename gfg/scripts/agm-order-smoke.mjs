// scripts/agm-order-smoke.mjs — Arc2 M1-E smoke: AGM maker->taker matching.
import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const AGM_SEED = Buffer.from('gfgagm');
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;            // ludo
const OID = 910002;
const TAKER = Keypair.generate();
const orderPda = PublicKey.findProgramAddressSync([AGM_SEED, Buffer.from([GAME]), new BN(OID).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];

// maker (sponsor) posts an order
await send(await prog.methods.postAgmOrder(GAME, new BN(OID), new BN(500), 2)
  .accounts({ payer: sponsor.publicKey, order: orderPda, systemProgram: SystemProgram.programId }).transaction());

// taker (a DIFFERENT wallet) calls match - sponsor can't sign for TAKER keypair? we sign on the ER/base with sponsor
// For the smoke, validate the maker-wallet guard by trying to match with the SAME maker -> must FAIL.
let sameGuard = 0;
try {
  await send(await prog.methods.matchAgmOrder(GAME, new BN(OID))
    .accounts({ signer: sponsor.publicKey, order: orderPda }).transaction());
} catch (e) { sameGuard = 1; }
console.log('maker-self-match rejected:', sameGuard === 1 ? 'YES' : 'NO');

// a real taker (different pubkey) — sign with a throwaway signer wallet via sponsor relay? The instruction requires
// a DISTINCT Signer. We use sponsor as fee payer but need disctinct signer key; use sendMagicTx with [sponsor, taker]
// and provider wallet sponsor (payer) while signer = taker (partial sign). Simplest: provider wallet = taker.
const tw = { publicKey: TAKER.publicKey, signTransaction: async (t) => { t.partialSign(TAKER); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(TAKER)); return ts; } };
const progTaker = new Program(idl, new AnchorProvider(conn, tw, { commitment: 'confirmed', skipPreflight: true }));
const txMatch = await progTaker.methods.matchAgmOrder(GAME, new BN(OID)).accounts({ signer: TAKER.publicKey, order: orderPda }).transaction();
txMatch.feePayer = sponsor.publicKey;
const sig = await sendMagicTx(conn, txMatch, [sponsor, TAKER], { skipPreflight: true });
await conn.confirmTransaction({ signature: sig }, 'confirmed');
console.log('taker matched sig:', String(sig).slice(0, 10));

await sleep(2500);
const d = (await conn.getAccountInfo(orderPda)).data;
const res = { version: d[8], orderId: Number(d.readBigUInt64LE(9)), game: d[17], maker: new PublicKey(d.subarray(18,50)).toBase58().slice(0,8), stake: Number(d.readBigUInt64LE(50)), seats: d[58], status: d[59], taker: new PublicKey(d.subarray(60,92)).toBase58().slice(0,8) };
console.log('ORDER:', JSON.stringify(res));
const pass = res.status === 2 && sameGuard === 1 && res.maker === sponsor.publicKey.toBase58().slice(0,8) && res.taker !== sponsor.publicKey.toBase58().slice(0,8);
console.log('AGM ORDER PASS:', pass ? 'YES' : 'NO');
process.exit(0);