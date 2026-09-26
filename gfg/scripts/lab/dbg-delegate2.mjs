import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import '../load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx } from '../../src/gfg-rpc.js';

const PROGRAM_ID = new PublicKey('CkzrmH8NjyT4GPxq4qvK3v4HLujnJcPHyLJViqrpHFcj');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const BASE_URL = baseRpcUrl();
const GAME_SEED = Buffer.from('gfgmove');
const idl = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/programs/target/idl/gfg_move.json', 'utf8'));
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
const mkWallet = (kp) => ({ publicKey: kp.publicKey, async signTransaction(t){return t;}, async signAllTransactions(ts){return ts;} });

const player = Keypair.generate();
const [pda] = PublicKey.findProgramAddressSync([GAME_SEED, player.publicKey.toBytes()], PROGRAM_ID);
const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

const conn = createConnection(BASE_URL, 'confirmed');
const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
const program = new Program(idl, provider);

console.log('BASE_URL:', BASE_URL);
console.log('player:', player.publicKey.toBase58());
console.log('pda   :', pda.toBase58());

async function sendAndConfirm(txPromise) {
  const tx = await txPromise;
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
  console.log('sendMagicTx sig:', sig);
  const status = await conn.confirmTransaction({ signature: sig }, 'confirmed');
  console.log('confirmed:', JSON.stringify(status.value));
  return sig;
}

async function main() {
  const info0 = await conn.getAccountInfo(pda);
  console.log('pre-init account:', info0 ? info0.owner.toBase58() : 'null');
  if (!info0) {
    const sigInit = await sendAndConfirm(program.methods.initGame()
      .accounts({ game: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey, systemProgram: SystemProgram.programId })
      .transaction());
    console.log('init sig:', sigInit);
  }
  const info1 = await conn.getAccountInfo(pda);
  console.log('post-init account:', info1 ? info1.owner.toBase58() + ' len=' + info1.data.length : 'null');

  const sigDel = await sendAndConfirm(program.methods.delegate()
    .accounts({
      payer: sponsor.publicKey,
      playerAuthority: player.publicKey,
      game: pda,
      bufferGame: buffer,
      delegationRecordGame: record,
      delegationMetadataGame: metadata,
      ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
    .transaction());
  console.log('delegate sig:', sigDel);

  // Check owner on multiple RPCs
  const basePublic = new Connection('https://api.devnet.solana.com', 'confirmed');
  for (const c of [[conn, 'router'], [basePublic, 'api.devnet.solana.com']]) {
    const info = await c[0].getAccountInfo(pda);
    console.log(`post-delegate ${c[1]}:`, info ? info.owner.toBase58() + ' len=' + info.data.length : 'null');
  }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
