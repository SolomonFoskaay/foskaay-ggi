// Probe (temp, scripts/lab, deleted after): can the SPONSOR move an already
// US-delegated account to AS with a DIRECT re-delegate (no undelegate)?
// Q1 dice: direct delegate on US-delegated dice PDA -> AS validator.
// Q2 points (NO undelegate variant exists for points): direct delegate_points
//    US -> AS must be the ONLY path — prove it flips fqdn + hosts the award.
// Then E3/E4: roll + record_points on AS to confirm callbacks land.
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
const V_AS = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const V_US = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');
const MP = new PublicKey('Magic11111111111111111111111111111111111111');
const MC = new PublicKey('MagicContext1111111111111111111111111111111');
const US_URL = 'https://devnet-us.magicblock.app/';
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const AS_URL = 'https://devnet-as.magicblock.app/';
const BASE_URL = baseRpcUrl();
const SEEDS = { gfgplayerd: null, gfgpoints: Buffer.from('ludo', 'utf8'), gfgresult: null };

const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
function mkWallet(kp) { return { publicKey: kp.publicKey, async signTransaction(t) { t.partialSign(kp); return t; }, async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); } }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pdaFor = (seed, pk) => PublicKey.findProgramAddressSync([Buffer.from(seed), pk.toBytes()], PROGRAM_ID)[0];
const pointsPdaFor = (pk) => PublicKey.findProgramAddressSync([Buffer.from('gfgpoints'), Buffer.from('ludo', 'utf8'), pk.toBytes()], PROGRAM_ID)[0];

async function delegateAny(method, initMethod, accountArg, pda, player, validator) {
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
  const acc = {};
  acc[`payer`] = sponsor.publicKey;
  acc.playerAuthority = player.publicKey;
  acc[accountArg] = pda;
  acc[`buffer${cap(accountArg)}`] = buffer;
  acc[`delegationRecord${cap(accountArg)}`] = record;
  acc[`delegationMetadata${cap(accountArg)}`] = metadata;
  acc.ownerProgram = PROGRAM_ID;
  acc.delegationProgram = DELEGATION_PROGRAM;
  acc.systemProgram = SystemProgram.programId;
  const tx = await initMethod(acc, validator);
  tx.feePayer = sponsor.publicKey;
  const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
  await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}

function cap(s) { return s[0].toUpperCase() + s.slice(1); }
async function waitPickup(url, pda, tag, ms = 15000) {
  const conn = createConnection(url, 'confirmed');
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try {
      const info = await conn.getAccountInfo(pda);
      if (info && info.data.length > 0) { console.log(`  [pickup ${tag}] OK`); return true; }
    } catch (e) { /* keep polling */ }
    await sleep(600);
  }
  console.log(`  [pickup ${tag}] TIMEOUT`);
  return false;
}

const baseConn = createConnection(BASE_URL, 'confirmed');
const baseProg = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true }));

async function sendAndLog(label, tx, conn = baseConn) {
  tx.feePayer = sponsor.publicKey;
  let sig;
  try {
    sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log(`  [${label}] OK`, sig);
    return sig;
  } catch (e) {
    console.log(`  [${label}] FAILED: ${(e.message || '').slice(0, 120)}`);
    try {
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
      console.log('  logs:', JSON.stringify((t && t.meta && t.meta.logMessages || []).slice(0, 20), null, 1));
    } catch (_) { console.log('  (no logs fetched)'); }
    throw e;
  }
}

async function run() {
  const player = Keypair.generate();
  console.log('player', player.publicKey.toBase58());
  const dice = pdaFor('gfgplayerd', player.publicKey);
  const points = pointsPdaFor(player.publicKey);

  // Initialize dice + points (sponsor pays rent)
  await sendAndLog('init dice', await baseProg.methods.initialize().accounts({ player: dice, payer: sponsor.publicKey, playerAuthority: player.publicKey }).transaction());
  await sendAndLog('init points', await baseProg.methods.initializePoints('ludo').accounts({ points, payer: sponsor.publicKey, playerAuthority: player.publicKey }).transaction());
  console.log('[init] dice + points OK');

  // Delegate BOTH to US (reproduce production state)
  const d1 = await baseProg.methods.delegate().accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: dice, bufferPlayer: PublicKey.findProgramAddressSync([Buffer.from('buffer'), dice.toBytes()], PROGRAM_ID)[0], delegationRecordPlayer: PublicKey.findProgramAddressSync([Buffer.from('delegation'), dice.toBytes()], DELEGATION_PROGRAM)[0], delegationMetadataPlayer: PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), dice.toBytes()], DELEGATION_PROGRAM)[0], ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId }).remainingAccounts([{ pubkey: V_US, isSigner: false, isWritable: false }]).transaction();
  d1.feePayer = sponsor.publicKey;
  await baseConn.confirmTransaction({ signature: await sendMagicTx(baseConn, d1, [sponsor], { skipPreflight: true }) }, 'confirmed');
  const p1 = await baseProg.methods.delegatePoints('ludo').accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, points, bufferPoints: PublicKey.findProgramAddressSync([Buffer.from('buffer'), points.toBytes()], PROGRAM_ID)[0], delegationRecordPoints: PublicKey.findProgramAddressSync([Buffer.from('delegation'), points.toBytes()], DELEGATION_PROGRAM)[0], delegationMetadataPoints: PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), points.toBytes()], DELEGATION_PROGRAM)[0], ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId }).remainingAccounts([{ pubkey: V_US, isSigner: false, isWritable: false }]).transaction();
  p1.feePayer = sponsor.publicKey;
  await baseConn.confirmTransaction({ signature: await sendMagicTx(baseConn, p1, [sponsor], { skipPreflight: true }) }, 'confirmed');
  await sleep(2500);
  console.log('[delegate->US] dice:', JSON.stringify(await getDelegationStatus(baseConn, dice)));
  console.log('[delegate->US] points:', JSON.stringify(await getDelegationStatus(baseConn, points)));

  // Q1/Q2: DIRECT re-delegate to AS (sponsor signs; no undelegate anywhere)
  console.log('\n=== Q1/Q2: DIRECT re-delegate US->AS (sponsor, no undelegate) ===');
  try {
    const d2 = await baseProg.methods.delegate().accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: dice, bufferPlayer: PublicKey.findProgramAddressSync([Buffer.from('buffer'), dice.toBytes()], PROGRAM_ID)[0], delegationRecordPlayer: PublicKey.findProgramAddressSync([Buffer.from('delegation'), dice.toBytes()], DELEGATION_PROGRAM)[0], delegationMetadataPlayer: PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), dice.toBytes()], DELEGATION_PROGRAM)[0], ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId }).remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }]).transaction();
    d2.feePayer = sponsor.publicKey;
    const s2 = await sendMagicTx(baseConn, d2, [sponsor], { skipPreflight: true });
    await baseConn.confirmTransaction({ signature: s2 }, 'confirmed');
    console.log('  [DICE direct re-delegate->AS] OK', s2);
  } catch (e) {
    console.log(`  [DICE direct re-delegate->AS] FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  try {
    const p2 = await baseProg.methods.delegatePoints('ludo').accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, points, bufferPoints: PublicKey.findProgramAddressSync([Buffer.from('buffer'), points.toBytes()], PROGRAM_ID)[0], delegationRecordPoints: PublicKey.findProgramAddressSync([Buffer.from('delegation'), points.toBytes()], DELEGATION_PROGRAM)[0], delegationMetadataPoints: PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), points.toBytes()], DELEGATION_PROGRAM)[0], ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM, systemProgram: SystemProgram.programId }).remainingAccounts([{ pubkey: V_AS, isSigner: false, isWritable: false }]).transaction();
    p2.feePayer = sponsor.publicKey;
    const s3 = await sendMagicTx(baseConn, p2, [sponsor], { skipPreflight: true });
    await baseConn.confirmTransaction({ signature: s3 }, 'confirmed');
    console.log('  [POINTS direct re-delegate->AS] OK', s3);
  } catch (e) {
    console.log(`  [POINTS direct re-delegate->AS] FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  await sleep(3000);
  console.log('[status] dice:', JSON.stringify(await getDelegationStatus(baseConn, dice).catch(() => null)));
  console.log('[status] points:', JSON.stringify(await getDelegationStatus(baseConn, points).catch(() => null)));

  // ===== Q3: full migration path for the DICE PDA =====
  // The ONLY way to move an already-delegated account is: undelegate on the
  // region that hosts it (program `undelegate`, payer can be ANYONE including
  // the sponsor; player_authority is NOT a signer), then re-delegate (relay
  // now pins AS). Test with the sponsor as payer on the US region.
  console.log('\n=== Q3: sponsor undelegates dice ON US, re-delegates to AS ===');
  const usConn = createConnection(US_URL, 'processed');
  const usProv = new AnchorProvider(usConn, mkWallet(sponsor), { commitment: 'processed', skipPreflight: true });
  const usProg = new Program(idl, usProv);
  await waitPickup(US_URL, dice, 'dice');
  try {
    const utx = await usProg.methods.undelegate()
      .accounts({ payer: sponsor.publicKey, playerAuthority: player.publicKey, player: dice, magicProgram: MP, magicContext: MC })
      .transaction();
    utx.feePayer = sponsor.publicKey;
    const usig = await sendMagicTx(usConn, utx, [sponsor], { skipPreflight: true });
    await usConn.confirmTransaction({ signature: usig }, 'processed');
    console.log('  [undelegate dice ON US (sponsor payer)] OK', usig);
  } catch (e) {
    console.log(`  [undelegate dice ON US] FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  await sleep(6000);
  const afterU = await getDelegationStatus(baseConn, dice).catch(() => null);
  console.log('  after undelegate:', JSON.stringify(afterU));

  // Re-delegate to AS through the SAME relay flow production uses (now pins AS).
  const { handleDelegate } = await import('../delegate-relay.mjs');
  const rd = await handleDelegate(player.publicKey.toBase58());
  console.log('  re-delegate via relay steps:', rd.steps.length ? rd.steps.map(s => s.step).join(',') : 'no-op');
  await sleep(4000);
  const afterR = await getDelegationStatus(baseConn, dice).catch(() => null);
  console.log('  after re-delegate:', JSON.stringify(afterR));

  console.log('\n=== E5: roll dice ON AS after migration (callback MUST land) ===');
  const asConn2 = createConnection(AS_URL, 'processed');
  await waitPickup(AS_URL, dice, 'dice');
  const asProv2 = new AnchorProvider(asConn2, mkWallet(player), { commitment: 'processed', skipPreflight: true });
  const asProg2 = new Program(idl, asProv2);
  const seed2 = Math.floor(Math.random() * 256);
  try {
    const tx = await asProg2.methods.rollDice(seed2).accounts({ player: dice, payer: player.publicKey, playerAuthority: player.publicKey, oracleQueue: ER_QUEUE }).transaction();
    tx.feePayer = player.publicKey;
    const sig = await sendMagicTx(asConn2, tx, [player], { skipPreflight: true });
    await asConn2.confirmTransaction({ signature: sig }, 'processed');
    console.log('  [E5 roll] tx OK', sig);
  } catch (e) {
    console.log(`  [E5 roll] submit FAILED: ${(e.message || '').slice(0, 200)}`);
  }
  let got2 = null;
  const dl2 = Date.now() + 30000;
  while (Date.now() < dl2 && !got2) {
    await sleep(150);
    try {
      const info = await asConn2.getAccountInfo(dice, 'processed');
      if (info && info.data.length >= 19) {
        const c = info.data.readUInt8(10), d1 = info.data.readUInt8(8), d2 = info.data.readUInt8(9);
        if (c === seed2 && d1 > 0) got2 = `${d1}+${d2}`;
      }
    } catch (_) {}
  }
  console.log(`  [E5] callback: ${got2 ? `LANDED -> ${got2}` : `NEVER LANDED seed=${seed2}`}`);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });