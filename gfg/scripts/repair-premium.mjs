// scripts/repair-premium.mjs
// One-time devnet repair: the first migration build wrote shifted bytes into the 3
// premium accounts (level/until corrupt). Close the corrupted accounts (sponsor is
// stored admin_authority) so they can be re-created clean, then re-credit the owner's
// real wallet fresh. Run ONCE after the close_premium_points deploy:
//   node scripts/repair-premium.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus } from '../src/gfg-rpc.js';
import { handleCreditPremium } from './delegate-relay.mjs';
import './load-env.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address || idl.metadata?.address);
const base = baseRpcUrl();

function loadSponsor() {
  if (process.env.GFG_Gasless_Sponsor_Keypair) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.GFG_Gasless_Sponsor_Keypair)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
function mkWallet(kp) {
  return { publicKey: kp.publicKey, signTransaction: async (t)=>{ t.partialSign(kp); return t; }, signAllTransactions: async (ts)=>{ ts.forEach(t=>t.partialSign(kp)); return ts; } };
}

// { pda, playerAuthority (the seed basis for that PDA) }
const CORRUPT = [
  { pda: '2RNxpaKs7Trqrrjzp7TcZAFGFPdC7Q6JKzxAbDpdcUMx', player: '42xs2owrbnkszxdfvbzxegg3b2b3qdm3wd4uhujgsjew' }, // phantom (lowercased)
  { pda: 'FtBywJ4X8SehZCNEuANqhf8DZ411i8HGq7Uo6fmvdyAS', player: '42Xs2owrBnKsZXDfVbzxEGG3b2b3QDm3WD4uHujgSjew' }, // owner
];
const OWNER_WALLET = '42Xs2owrBnKsZXDfVbzxEGG3b2b3QDm3WD4uHujgSjew';
const OWNER_PDA = 'FtBywJ4X8SehZCNEuANqhf8DZ411i8HGq7Uo6fmvdyAS';
// Bpf-upgradeable ProgramData address of the gfg-dice program (public, from solana program show).
const PROGRAMDATA = new PublicKey('2DsrLtZcbNqY9rVqw4SZ7bKtbz1tS28y6BPFpykuEduV');

async function main() {
  const sponsor = loadSponsor();
  const conn = createConnection(base, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);

  for (const { pda, player } of CORRUPT) {
    const key = new PublicKey(pda);
    const auth = new PublicKey(player);
    try {
      const tx = await program.methods.closePremiumPoints()
        .accounts({ admin: sponsor.publicKey, destination: sponsor.publicKey, premiumPoints: key, playerAuthority: auth, programdata: PROGRAMDATA })
        .transaction();
      tx.feePayer = sponsor.publicKey;
      const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig }, 'confirmed');
      console.log('closed', pda, String(sig).slice(0, 24));
    } catch (e) {
      console.log('close failed', pda, e.message);
    }
  }

  // Re-create the owner's wallet fresh with 5,000P (v2 init + credit reason 1).
  try {
    const r = await handleCreditPremium(OWNER_WALLET, 5000, Date.now() % 2147483647, 1);
    console.log('owner wallet re-credited fresh', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.log('owner re-credit failed:', e.message);
  }
  const pda = await PublicKey.findProgramAddress([Buffer.from('gfgprem'), new PublicKey(OWNER_WALLET).toBytes()], PROGRAM);
  console.log('owner premium PDA should be', pda[0].toBase58());
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });