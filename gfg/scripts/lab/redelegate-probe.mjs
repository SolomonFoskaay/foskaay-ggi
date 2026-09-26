// Decisive migration-mechanics probe (temp, repo scripts/lab, deleted after):
// Q1: can an account ALREADY delegated to the US validator be re-delegated
//     DIRECTLY to the AS validator (single `delegate` tx, no undelegate)?
// Q2: if not, does undelegate (dice-pda instruction) + re-delegate work?
// Q3: does the migrated account roll + resolve on the AS ER?
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
const MP = new PublicKey('Magic11111111111111111111111111111111111111');
const MC = new PublicKey('MagicContext1111111111111111111111111111111');
const V_US = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const V_AS = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const AS_URL = 'https://devnet-as.magicblock.app/';
const BASE_URL = baseRpcUrl();
const PLAYER_SEED = Buffer.from('gfgplayerd');

const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
function mkWallet(kp) { return { publicKey: kp.publicKey, async signTransaction(t){ t.partialSign(kp); return t; }, async signAllTransactions(ts){ return Promise.all(ts.map(t=>{t.partialSign(kp);return t;})); } }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(label, player) {
  console.log(`\n===== ${label} player=${player.publicKey.toBase58()} =====`);
  const conn = createConnection(BASE_URL, 'confirmed');
  const provider = new AnchorProvider(conn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
  const program = new Program(idl, provider);
  const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBytes()], PROGRAM_ID);
  console.log('pda=', pda.toBase58());

  if (!(await conn.getAccountInfo(pda))) {
    let tx = await program.methods.initialize().accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey }).transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('  [base] initialize OK');
  }

  const st = await getDelegationStatus(conn, pda);
  if (st && st.isDelegated) {
    console.log(`  already delegated fqdn=${st.fqdn}`);
  } else {
    // STEP A: pin to the US validator (reproduce the production state)
    const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
    const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
    let tx = await program.methods.delegate()
      .accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: pda, bufferPlayer: buffer, delegationRecordPlayer: record, delegationMetadataPlayer: metadata, ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId })
      .remainingAccounts([{ pubkey: V_US, isSigner: false, isWritable: false }])
      .transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('  [base] DELEGATED TO US', V_US.toBase58().slice(0, 8), sig);
  }
  await sleep(1500);
  let st2 = await getDelegationStatus(conn, pda);
  console.log('  after US delegate:', JSON.stringify(st2));

  // STEP B: try a DIRECT re-delegate to AS (no undelegate) on the US-pinned account
  const [buffer2] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record2] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata2] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
  let directOk = false;
  try {
    let tx = await program.methods.delegate()
      .accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: pda, bufferPlayer: buffer2, delegationRecordPlayer: record2, delegationMetadataPlayer: metadata2, ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId })
      .remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }])
      .transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    directOk = true;
    console.log('  [Q1] DIRECT re-delegate US->AS SUCCEEDED:', sig);
  } catch (e) {
    console.log(`  [Q1] DIRECT re-delegate US->AS FAILED: ${(e.message || '').slice(0, 160)}`);
  }
  await sleep(3000);
  const st3 = await getDelegationStatus(conn, pda).catch(() => null);
  console.log('  after direct re-delegate attempt:', JSON.stringify(st3));
  if (directOk) return pda; // done if direct worked

  // STEP C: undelegate (dice instruction) then re-delegate to AS
  console.log('  [Q2] trying undelegate on the US-pinned account (ER)');
  const asConn = createConnection(AS_URL, 'processed');
  const asProvider = new AnchorProvider(asConn, mkWallet(player), { commitment: 'processed', skipPreflight: true });
  const asProg = new Program(idl, asProvider);
  try {
    const tx = await asProg.methods.undelegate()
      .accounts({ payer: player.publicKey, playerAuthority: player.publicKey, player: pda, magicProgram: MP, magicContext: MC })
      .transaction();
    tx.feePayer = player.publicKey;
    const sig = await sendMagicTx(asConn, tx, [player], { skipPreflight: true });
    await asConn.confirmTransaction({ signature: sig }, 'processed');
    console.log('  [ER] undelegate tx sent:', sig);
  } catch (e) {
    console.log(`  [ER] undelegate FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  await sleep(3000);
  const st4 = await getDelegationStatus(conn, pda).catch(() => null);
  console.log('  after undelegate:', JSON.stringify(st4));

  // STEP D: re-delegate to AS from the (assumed) base state
  try {
    let tx = await program.methods.delegate()
      .accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: pda, bufferPlayer: buffer2, delegationRecordPlayer: record2, delegationMetadataPlayer: metadata2, ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId })
      .remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }])
      .transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('  [Q2] re-delegate to AS SUCCEEDED:', sig);
  } catch (e) {
    console.log(`  [Q2] re-delegate to AS FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  await sleep(3000);
  const st5 = await getDelegationStatus(conn, pda).catch(() => null);
  console.log('  final delegation:', JSON.stringify(st5));

  // STEP E: roll on the AS ER + wait for the callback (the real proof)
  await sleep(2000);
  console.log('  [Q3] rolling on AS ER...');
  const seed = Math.floor(Math.random() * 256);
  const erConn = createConnection(AS_URL, 'processed');
  const erProv = new AnchorProvider(erConn, mkWallet(player), { commitment: 'processed', skipPreflight: true });
  const erProg = new Program(idl, erProv);
  try {
    const tx = await erProg.methods.rollDice(seed)
      .accounts({ player: pda, payer: player.publicKey, playerAuthority: player.publicKey, oracleQueue: ER_QUEUE })
      .transaction();
    tx.feePayer = player.publicKey;
    const sig = await sendMagicTx(erConn, tx, [player], { skipPreflight: true });
    await erConn.confirmTransaction({ signature: sig }, 'processed');
    console.log('  [Q3] roll tx:', sig);
  } catch (e) {
    console.log(`  [Q3] roll FAILED at submit: ${(e.message || '').slice(0, 160)}`);
    return pda;
  }
  let got = null;
  const dl = Date.now() + 35000;
  while (Date.now() < dl && !got) {
    await sleep(150);
    try {
      const info = await erConn.getAccountInfo(pda, 'processed');
      if (info && info.data.length >= 19) {
        const c = info.data.readUInt8(10);
        const d1 = info.data.readUInt8(8), d2 = info.data.readUInt8(9);
        if (c === seed && d1 > 0) got = d1 + '+' + d2;
      }
    } catch (_) {}
  }
  console.log(`  [Q3] callback: ${got ? `LANDED -> ${got}` : 'NEVER LANDED (35s) seed=' + seed}`);
  return pda;
}

(async () => {
  await run('candidate-A', Keypair.generate());
  await run('candidate-B', Keypair.generate());
})().catch(e => { console.error('FATAL:', e); process.exit(1); });