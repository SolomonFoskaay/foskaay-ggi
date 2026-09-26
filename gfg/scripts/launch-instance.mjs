// scripts/launch-instance.mjs — G: create the LUDO EARN launch competition on
// devnet (72h, $2 = 1000 pts, 10 ways) and prove the Final-Points board E2E
// (L3 1.5x, L2 1.25x, L1 1.0x, non-qualifying hidden) with throwaway wallets.
import { readFileSync } from 'fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { createCompetition, getCompetition, getBoard } from './competitions-relay.mjs';
import { addEntry, addWin } from './competitions-wins.mjs';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const PREMIUM_SEED = Buffer.from('gfgprem');

const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

async function activateForLevel(level, points) {
  const w = Keypair.generate().publicKey;
  const [prem] = PublicKey.findProgramAddressSync([PREMIUM_SEED, w.toBytes()], PROGRAM);
  await send(await prog.methods.initializePremiumPoints().accounts({ payer: sponsor.publicKey, playerAuthority: w, premiumPoints: prem, systemProgram: SystemProgram.programId }).transaction());
  const ref = (Date.now() % 1000000000) + (level * 9100000000) + Math.floor(Math.random() * 99999);
  await send(await prog.methods.creditPremiumPoints(new BN(points), new BN(ref), 1).accounts({ premiumPoints: prem, admin: sponsor.publicKey, playerAuthority: w, systemProgram: SystemProgram.programId }).transaction());
  await send(await prog.methods.activateSubscriptionLevel(new BN(level)).accounts({ payer: sponsor.publicKey, playerAuthority: w, premiumPoints: prem }).transaction());
  return w;
}

const SEQ = 777002;
const now = Math.floor(Date.now() / 1000);
console.log('creating LUDO EARN launch instance...');
const res = await createCompetition({
  seq: SEQ, name: 'LUDO EARN', games: [1], tierBits: 0b1100, requireAll: 0,
  entryCost: 500, entryFamilies: 1, startsAt: now + 5, endsAt: now + 3 * 86400,
  poolUsdCents: 200, poolPoints: 1000, winnerCount: 10,
  prizeShares: [1000, 600, 300, 200, 150, 100, 100, 100, 100, 100],
  redemption: 0, payoutMode: 0,
});
console.log('created:', JSON.stringify(res));

const aL3 = await activateForLevel(3, 10000);
const bL2 = await activateForLevel(2, 5000);
const cL1 = Keypair.generate().publicKey; // free player (L1)
console.log('wallets: L3=%s L2=%s L1=%s', aL3.toBase58().slice(0,6), bL2.toBase58().slice(0,6), cL1.toBase58().slice(0,6));

const winTs = now + 3600; // inside the window
addEntry({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: aL3.toBase58() });
addEntry({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: bL2.toBase58() });
addEntry({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: cL1.toBase58() });
for (let i = 0; i < 3; i++) addWin({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: aL3.toBase58(), ts: winTs + i, proofSig: 'sigA' + i, game: 'ludo' });
for (let i = 0; i < 2; i++) addWin({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: bL2.toBase58(), ts: winTs + i, proofSig: 'sigB' + i, game: 'ludo' });
for (let i = 0; i < 5; i++) addWin({ compCreator: sponsor.publicKey.toBase58(), seq: SEQ, wallet: cL1.toBase58(), ts: winTs + i, proofSig: 'sigC' + i, game: 'ludo' });

console.log('reading board with live-tier boosts...');
const comp = await getCompetition({ creator: sponsor.publicKey.toBase58(), seq: SEQ });
if (comp) console.log('instance:', JSON.stringify({ seq: comp.seq, name: comp.name, status: comp.status, poolUsdCents: comp.poolUsdCents, poolPoints: comp.poolPoints, winnerCount: comp.winnerCount, tierBits: comp.tierBits }));
const board = await getBoard({ creator: sponsor.publicKey.toBase58(), seq: SEQ });
console.log('BOARD:');
board.board.forEach(r => console.log(`  #${r.position} ${r.wallet.slice(0,6)}… L${r.level} total=${r.totalPoints} final=${r.finalPoints} prize=${r.prizePosition || '-'}`));
console.log('  hidden:', board.hidden.map(h => h.wallet.slice(0,6) + '… (total ' + h.totalPoints + ')').join(', '));
const pass = board.board.length === 2 && board.board[0].finalPoints === 4.5 && board.board[1].finalPoints === 2 && board.hidden.length === 1 && board.hidden[0].wallet === cL1.toBase58();
console.log('E2E PASS:', pass ? 'YES' : 'NO');
process.exit(0);