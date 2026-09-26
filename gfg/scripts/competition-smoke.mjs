// scripts/competition-smoke.mjs — live smoke of A1 (L3 activation) + A2
// (competition lifecycle) against the deployed program (base-layer, sponsor).
// Uses fresh random wallets so no live account is touched.
import { readFileSync } from 'fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const PREMIUM_SEED = Buffer.from('gfgprem');
const COMP2_SEED = Buffer.from('gfgcomp2');
const GFGWIN_SEED = Buffer.from('gfgwin');

const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function send(tx) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

// ---- A1: L3 activation (15,000P) -----------------------------------------
const a1 = Keypair.generate().publicKey;
const [prem] = PublicKey.findProgramAddressSync([PREMIUM_SEED, a1.toBytes()], PROGRAM);
const sigInit = await send(await prog.methods.initializePremiumPoints().accounts({ payer: sponsor.publicKey, playerAuthority: a1, premiumPoints: prem, systemProgram: SystemProgram.programId }).transaction());
const ref = (Date.now() % 1000000000) + 3000000000;
const sigCredit = await send(await prog.methods.creditPremiumPoints(new BN(15000), new BN(ref), 1).accounts({ premiumPoints: prem, admin: sponsor.publicKey, playerAuthority: a1, systemProgram: SystemProgram.programId }).transaction());
const sigAct = await send(await prog.methods.activateSubscriptionLevel(new BN(3)).accounts({ payer: sponsor.publicKey, playerAuthority: a1, premiumPoints: prem }).transaction());
const p = await conn.getAccountInfo(prem);
const lvl = p.data[57], spendable = Number(p.data.readBigUInt64LE(49));
console.log('A1 L3 activation:', { level: lvl, spendable, pass: lvl === 3 && spendable === 0 });

// ---- A2: competition lifecycle -------------------------------------------
const winnerA = Keypair.generate().publicKey;
const winnerB = Keypair.generate().publicKey;
const seq = 777001;
const [compPda] = PublicKey.findProgramAddressSync([COMP2_SEED, sponsor.publicKey.toBytes(), new Uint8Array(new BN(seq).toArrayLike(Buffer, 'le', 4))], PROGRAM);
const now = Math.floor(Date.now() / 1000);
const createSig = await send(await prog.methods.createCompetition(
  seq, 'SMOKE_EARN', Buffer.from([1]), 0b1100, 0, new BN(500), 0b001, new BN(now + 5), new BN(now + 10),
  new BN(200), new BN(1000), 2, [60, 40], 0, 0,
).accounts({ payer: sponsor.publicKey, competition: compPda, systemProgram: SystemProgram.programId }).transaction());
await sleep(11000);
const closeSig = await send(await prog.methods.closeCompetition(seq).accounts({ authority: sponsor.publicKey, competition: compPda }).transaction());
const [w1] = PublicKey.findProgramAddressSync([GFGWIN_SEED, compPda.toBytes(), new Uint8Array([1])], PROGRAM);
const [w2] = PublicKey.findProgramAddressSync([GFGWIN_SEED, compPda.toBytes(), new Uint8Array([2])], PROGRAM);
const s1 = await send(await prog.methods.recordCompetitionWinner(seq, 1, winnerA).accounts({ authority: sponsor.publicKey, competition: compPda, winner: w1, systemProgram: SystemProgram.programId }).transaction());
const s2 = await send(await prog.methods.recordCompetitionWinner(seq, 2, winnerB).accounts({ authority: sponsor.publicKey, competition: compPda, winner: w2, systemProgram: SystemProgram.programId }).transaction());
const settleSig = await send(await prog.methods.settleCompetition(seq).accounts({ authority: sponsor.publicKey, competition: compPda }).transaction());
const paySig = await send(await prog.methods.markWinnerPaid(seq, 1).accounts({ authority: sponsor.publicKey, competition: compPda, winner: w1 }).transaction());

const c = await conn.getAccountInfo(compPda);
const d = c.data;
const g1 = await conn.getAccountInfo(w1);
const g2 = await conn.getAccountInfo(w2);
const dg1 = g1.data, dg2 = g2.data;
const compStatus = d[184]; // status (layout: disc8 + version1 + creator32 + seq4 + name24 + games4 + game_count1 + tier_bits1 + require_all1 + entry_cost8 + entry_families1 + starts_at8 + ends_at8 + pool_usd_cents8 + pool_points8 + winner_count1 + prize_shares64 + redemption1 + payout_mode1) -> status
const res = {
  compStatus,
  w1: { points: Number(dg1.readBigUInt64LE(74)), usd: Number(dg1.readBigUInt64LE(82)), status: dg1[90] },
  w2: { points: Number(dg2.readBigUInt64LE(74)), usd: Number(dg2.readBigUInt64LE(82)), status: dg2[90] },
};
// safer status read: locate by scanning known struct (status is byte#167 per layout)
console.log('A2 competition:', JSON.stringify(res));
const pass = compStatus === 2 && res.w1.points === 600 && res.w1.usd === 120 && res.w2.points === 400 && res.w2.usd === 80 && res.w1.status === 1 && res.w2.status === 0;
console.log('A2 PASS:', pass ? 'YES' : 'NO');
console.log('sigs:', { create: String(createSig).slice(0,10), close: String(closeSig).slice(0,10), w1: String(s1).slice(0,10), w2: String(s2).slice(0,10), settle: String(settleSig).slice(0,10), pay: String(paySig).slice(0,10) });
process.exit(0);