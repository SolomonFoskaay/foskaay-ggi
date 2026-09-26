// scripts/reconcile-premium.mjs
// Ops: commit+undelegate a premium PDA so the BASE copy reflects the current ER
// state (e.g. an active Level-2 sub). MagicBlock's ER holds the working state and
// base only updates on commit/undelegate/settlement, which is why some pages saw a
// stale level 0 after activation. Run once per account to reconcile:
//   node scripts/reconcile-premium.mjs 42Xs2owrBnKsZXDfVbzxEGG3b2b3QDm3WD4uHujgSjew
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus } from '../src/gfg-rpc.js';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const BASE = baseRpcUrl();

function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t)=>{ t.partialSign(kp); return t; }, signAllTransactions: async (ts)=>{ ts.forEach(t=>t.partialSign(kp)); return ts; } };
}

async function main() {
  const walletArg = process.argv[2];
  if (!walletArg) { console.error('usage: node scripts/reconcile-premium.mjs <wallet>'); process.exit(1); }
  const player = new PublicKey(walletArg);
  const sponsor = loadSponsor();
  const conn = createConnection(BASE, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('gfgprem'), player.toBytes()], PROGRAM);
  const info = await conn.getAccountInfo(pda);
  if (!info) { console.log('no premium PDA for wallet'); process.exit(0); }
  const status = await getDelegationStatus(conn, pda);
  if (!(status && status.isDelegated)) { console.log('premium PDA not delegated; nothing to reconcile'); process.exit(0); }
  console.log('delegated on', status.fqdn, '- committing+undelegating so base matches ER...');
  const magProg = new PublicKey('Magic11111111111111111111111111111111111111');
  const magContext = new PublicKey('MagicContext1111111111111111111111111111111');
  const tx = await program.methods.undelegatePremiumPoints()
    .accounts({ payer: sponsor.publicKey, playerAuthority: player, premiumPoints: pda, magicProgram: magProg, magicContext: magContext })
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig }, 'processed');
  console.log('undelegated sig', sig);
  // read back base
  const after = await conn.getAccountInfo(pda);
  if (after) {
    const d = after.data;
    console.log('base now: level=' + d[57], 'until=' + d.readBigInt64LE(58).toString(), 'spend=' + d.readBigUInt64LE(49).toString());
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });