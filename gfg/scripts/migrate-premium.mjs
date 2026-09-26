// scripts/migrate-premium.mjs
// Post-deploy sweep: run the new permissionless `upgrade_premium_points` on every
// existing v1 premium account so they can be credited/activated under the v2 layout.
// Same-address realloc via Anchor Migration; idempotent (v2 accounts are skipped).
// Delegated accounts are upgraded gaslessly on the ER region that hosts them;
// non-delegated on base. Run once after the M5 program deploy:
//   node scripts/migrate-premium.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, pickErRpcUrl, erRpcEndpoints } from '../src/gfg-rpc.js';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const base = baseRpcUrl();
const ER_DEFAULT = pickErRpcUrl();
const bs58 = (await import('bs58')).default;
const DISC = Buffer.from([128,231,201,193,30,238,115,64]);

function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t)=>{ t.partialSign(kp); return t; }, signAllTransactions: async (ts)=>{ ts.forEach(t=>t.partialSign(kp)); return ts; } };
}

async function main() {
  const sponsor = loadSponsor();
  const conn = createConnection(base, 'confirmed');
  const basePublic = new Connection('https://api.devnet.solana.com', 'confirmed');
  const accounts = await basePublic.getProgramAccounts(PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC) } }] });
  console.log('[migrate-premium] program', PROGRAM.toBase58(), '· found', accounts.length, 'premium account(s)');
  for (const { pubkey, account } of accounts) {
    const d = account.data; const len = d.length; const ver = d.length >= 9 ? d[8] : 0;
    console.log('  ', pubkey.toBase58(), 'len=' + len, 'version=' + ver);
    if (ver >= 2 || len >= 124) { console.log('    already v2 (skip)'); continue; }

    // Are we delegated (hosted on a rollup region)?
    let regionUrl = null;
    try {
      const st = await getDelegationStatus(conn, pubkey);
      if (st && st.isDelegated) {
        const fq = String(st.fqdn || '').toLowerCase();
        regionUrl = erRpcEndpoints().find(e => fq.includes(e.region))?.url || ER_DEFAULT;
      }
    } catch (e) { /* router missed -> base */ }

    const sendBase = async (prog) => {
      const tx = await prog.methods.upgradePremiumPoints()
        .accounts({ payer: sponsor.publicKey, premiumPoints: pubkey, systemProgram: SystemProgram.programId })
        .transaction();
      tx.feePayer = sponsor.publicKey;
      const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig }, 'confirmed');
      return sig;
    };
    const sendEr = async (url) => {
      const erConn = new Connection(url, 'confirmed');
      const provider = new AnchorProvider(erConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
      const prog = new Program(idl, provider);
      return prog.methods.upgradePremiumPoints()
        .accounts({ payer: sponsor.publicKey, premiumPoints: pubkey, systemProgram: SystemProgram.programId })
        .rpc();
    };

    try {
      let sig;
      if (regionUrl) { sig = await sendEr(regionUrl); console.log('    upgraded (ER', regionUrl + ') sig', String(sig).slice(0, 24)); }
      else { sig = await sendBase(new Program(idl, new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }))); console.log('    upgraded (base) sig', String(sig).slice(0, 24)); }
    } catch (e) {
      console.log('    upgrade failed:', e.message);
    }
  }
  console.log('[migrate-premium] done');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });