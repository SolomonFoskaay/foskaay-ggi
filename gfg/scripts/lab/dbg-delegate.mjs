// dbg-delegate.mjs — isolate why delegation isn't flipping ownership.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import '../load-env.mjs'; // load .env (Alchemy key) before resolving the RPC chain
import { baseRpcUrl, createConnection, pickErRpcUrl } from '../../src/gfg-rpc.js';

const PROGRAM_ID = new PublicKey('CkzrmH8NjyT4GPxq4qvK3v4HLujnJcPHyLJViqrpHFcj');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const BASE_URL = baseRpcUrl();
const ER_URL = pickErRpcUrl();
const GAME_SEED = Buffer.from('gfgmove');
const idl = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/programs/target/idl/gfg_move.json', 'utf8'));

const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
function mkWallet(kp) {
  return { publicKey: kp.publicKey, async signTransaction(t) { t.partialSign(kp); return t; }, async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); } };
}
const player = Keypair.generate();
const [pda] = PublicKey.findProgramAddressSync([GAME_SEED, player.publicKey.toBytes()], PROGRAM_ID);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const baseConn = createConnection(BASE_URL, 'confirmed');
const program = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));

console.log('program', PROGRAM_ID.toBase58());
console.log('player', player.publicKey.toBase58());
console.log('pda   ', pda.toBase58());

const initSig = await program.methods.initGame()
  .accounts({ game: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
console.log('init sig', initSig);
await sleep(2000);
let info = await baseConn.getAccountInfo(pda);
console.log('after init owner', info ? info.owner.toBase58() : 'null', 'len', info ? info.data.length : 0);

const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

try {
  const delegateSig = await program.methods.delegate()
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
    .rpc();
  console.log('delegate sig', delegateSig);
} catch (e) {
  console.log('delegate ERROR:', e.message);
  const logs = e.logs || e.txMeta?.logMessages;
  if (logs) console.log(JSON.stringify(logs.slice(0, 20), null, 2));
  process.exit(1);
}

await sleep(3000);
info = await baseConn.getAccountInfo(pda);
console.log('after delegate owner', info ? info.owner.toBase58() : 'null', 'len', info ? info.data.length : 0);
const tx = await baseConn.getTransaction(delegateSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
if (tx) console.log('tx logs tail:', (tx.meta?.logMessages || []).slice(-6));
await sleep(2000);
const er = new Connection(ER_URL, 'confirmed');
let erInfo = await er.getAccountInfo(pda).catch(() => null);
console.log('ER pickup owner', erInfo ? erInfo.owner.toBase58() : 'null', 'len', erInfo ? erInfo.data.length : 0);