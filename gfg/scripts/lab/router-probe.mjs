// Probe F (repo scripts/lab, deleted after): does the MAGIC ROUTER auto-route
// ER txs + callback reads to whatever region the account is pinned to?
// F1: roll a US-pinned account via the Router (submit+poll through router).
// F2: roll a US-pinned account via EU region (confirm mismatch breaks it).
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './../load-env.mjs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus } from '../../src/gfg-rpc.js';

const idl = JSON.parse(readFileSync(new URL('../../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const V_US = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const ROUTER = 'https://devnet-router.magicblock.app';
const US_URL = 'https://devnet-us.magicblock.app/';
const EU_URL = 'https://devnet-eu.magicblock.app/';
const BASE_URL = baseRpcUrl();
const PLAYER_SEED = Buffer.from('gfgplayerd');

const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
function mkWallet(kp) { return { publicKey: kp.publicKey, async signTransaction(t){ t.partialSign(kp); return t; }, async signAllTransactions(ts){ return Promise.all(ts.map(t=>{t.partialSign(kp);return t;})); } }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rollAndWait(url, player, pda, tag) {
  const conn = createConnection(url, 'processed');
  const prov = new AnchorProvider(conn, mkWallet(player), { commitment: 'processed', skipPreflight: true });
  const prog = new Program(idl, prov);
  const seed = Math.floor(Math.random() * 256);
  try {
    const tx = await prog.methods.rollDice(seed)
      .accounts({ player: pda, payer: player.publicKey, playerAuthority: player.publicKey, oracleQueue: ER_QUEUE })
      .transaction();
    tx.feePayer = player.publicKey;
    const sig = await sendMagicTx(conn, tx, [player], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'processed');
    console.log(`  [${tag}] roll tx CONFIRMED (seed ${seed})`);
  } catch (e) {
    console.log(`  [${tag}] roll submit FAILED: ${(e.message || '').slice(0, 180)}`);
    return;
  }
  let got = null;
  const dl = Date.now() + 30000;
  while (Date.now() < dl && !got) {
    await sleep(150);
    try {
      const info = await conn.getAccountInfo(pda, 'processed');
      if (info && info.data.length >= 19) {
        const c = info.data.readUInt8(10), d1 = info.data.readUInt8(8), d2 = info.data.readUInt8(9);
        if (c === seed && d1 > 0) got = `${d1}+${d2}`;
      }
    } catch (_) {}
  }
  console.log(`  [${tag}] callback: ${got ? `LANDED -> ${got}` : `NEVER LANDED (30s) seed=${seed}`}`);
}

(async () => {
  const player = Keypair.generate();
  const pda = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBytes()], PROGRAM_ID)[0];
  console.log('player', player.publicKey.toBase58(), 'pda', pda.toBase58());
  const baseConn = createConnection(BASE_URL, 'confirmed');
  const baseProg = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);

  if (!(await baseConn.getAccountInfo(pda))) {
    let tx = await baseProg.methods.initialize().accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey }).transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
    await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('  [init] OK');
  }
  let tx = await baseProg.methods.delegate()
    .accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: pda, bufferPlayer: buffer, delegationRecordPlayer: record, delegationMetadataPlayer: metadata, ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId })
    .remainingAccounts([{ pubkey: V_US, isSigner: false, isWritable: false }])
    .transaction();
  tx.feePayer = sponsor.publicKey;
  const sig1 = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig1 }, 'confirmed');
  console.log('  [delegate->US] OK');
  await sleep(2500);
  console.log('  status:', JSON.stringify(await getDelegationStatus(baseConn, pda)));

  console.log('\n=== F1: US-pinned account, submit+poll via MAGIC ROUTER ===');
  await rollAndWait(ROUTER, player, pda, 'F1-ROUTER');

  console.log('\n=== F2: US-pinned account, submit+poll via EU region (mismatch) ===');
  await rollAndWait(EU_URL, player, pda, 'F2-EU');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });