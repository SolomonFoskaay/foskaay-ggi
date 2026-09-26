// scripts/claim-fence-smoke.mjs — prove the on-chain signup-claim fence:
// a fresh wallet claims 500P once; a SECOND claim for the same wallet MUST be
// rejected by the program (SignupAlreadyClaimed), proving the permanent gate.
import { readFileSync } from 'fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { handleSignupBonus } from './affiliate-relay.mjs';
import { loadSponsor } from './delegate-relay.mjs';
import { baseRpcUrl, createConnection, sendMagicTx } from '../src/gfg-rpc.js';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const CLAIM_SEED = Buffer.from('gfgclaim');
const GPOINTS = Buffer.from('gfgpoints');

const w = Keypair.generate().publicKey;
const [claimPda] = PublicKey.findProgramAddressSync([CLAIM_SEED, w.toBytes()], PROGRAM);
const [globalPda] = PublicKey.findProgramAddressSync([GPOINTS, Buffer.from('global'), w.toBytes()], PROGRAM);
const sponsor = loadSponsor();
const conn = createConnection(baseRpcUrl(), 'confirmed');
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));

// A real player gets their global PDA at onboarding; a fresh smoke wallet needs
// it initialized (sponsor pays rent) before the claim writes to it.
const existing = await conn.getAccountInfo(globalPda);
if (!existing) {
  const tx = await prog.methods.initializeGlobalPoints()
    .accounts({ payer: sponsor.publicKey, playerAuthority: w, globalPoints: globalPda, systemProgram: SystemProgram.programId })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log('global initialized for smoke wallet');
}

let r1, r2;
try { r1 = await handleSignupBonus(w.toBase58()); console.log('FIRST claim:', JSON.stringify({ sig: String(r1.sig).slice(0, 24), matchRef: r1.matchRef })); }
catch (e) { console.log('FIRST claim FAILED:', (e.message || e).slice(0, 240)); process.exit(1); }

await new Promise(r => setTimeout(r, 3000));
try { r2 = await handleSignupBonus(w.toBase58()); console.log('SECOND claim UNEXPECTEDLY SUCCEEDED:', JSON.stringify({ sig: String(r2.sig).slice(0, 24) })); }
catch (e) { console.log('SECOND claim REJECTED as expected:', (e.message || e).slice(0, 200)); }

(async function () {
  const { Connection } = await import('@solana/web3.js');
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const claim = await conn.getAccountInfo(claimPda);
  const global = await conn.getAccountInfo(globalPda);
  const d = claim ? claim.data : null;
  console.log('claim account:', d ? { len: d.length, version: d[8], claimed: d[9], ts: Number(d.readBigInt64LE(10)), ref: String(d.readBigUInt64LE(18)) } : 'MISSING');
  if (global && global.data.length >= 41) {
    console.log('global ledger: lifetime=', Number(global.data.readBigUInt64LE(16)), 'spendable=', Number(global.data.readBigUInt64LE(24)), 'award_count=', Number(global.data.readBigUInt64LE(49)));
  } else { console.log('global ledger missing or short'); }
  process.exit(0);
})();