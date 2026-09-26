// scripts/probe-resize.mjs
// ER resize proof: create a program-owned probe PDA, delegate it to the ER,
// then RESIZE (realloc) it on the ER and verify the new size. Decides whether
// the Player Core account can grow its per-game buckets dynamically.
//
// Run: node scripts/probe-resize.mjs

import './load-env.mjs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const PROBE_SEED = Buffer.from('gfgprobe');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');

const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function probePda() {
  return PublicKey.findProgramAddressSync([PROBE_SEED, sponsor.publicKey.toBytes()], PROGRAM)[0];
}
async function erUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function waitDelegated(pda, t) {
  const d = Date.now() + t;
  while (Date.now() < d) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); }
  return false;
}
async function erSend(buildTx) {
  const pda = probePda();
  const url = await erUrl(pda);
  const c = createConnection(url, 'confirmed', 9000);
  const bh = await c.getLatestBlockhash('confirmed');
  const tx = await buildTx();
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(sponsor);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await c.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}
async function erInfo(pda) {
  const url = await erUrl(pda);
  const c = createConnection(url, 'confirmed', 9000);
  return c.getAccountInfo(pda);
}

async function main() {
  const pda = probePda();
  console.log('[probe] PDA =', pda.toBase58());

  const before = await conn.getAccountInfo(pda).catch(() => null);
  if (!before) {
    console.log('[1/5] init probe (base)...');
    const tx = await prog.methods.probeInit().accounts({ payer: sponsor.publicKey, probe: pda, systemProgram: SystemProgram.programId }).transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
  } else {
    console.log('[1/5] probe already exists');
  }

  const st = await getDelegationStatus(conn, pda).catch(() => null);
  if (!(st && st.isDelegated)) {
    console.log('[2/5] delegate probe (base)...');
    const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM_ID);
    const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM_ID);
    const tx = await prog.methods.probeDelegate().accounts({
      payer: sponsor.publicKey,
      bufferProbe: buffer,
      delegationRecordProbe: record,
      delegationMetadataProbe: metadata,
      probe: pda,
      ownerProgram: PROGRAM,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).remainingAccounts([{ pubkey: ER_VALIDATOR_ID, isSigner: false, isWritable: false }]).transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(conn, tx, [sponsor], { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig }, 'confirmed');
  } else {
    console.log('[2/5] probe already delegated');
  }

  if (!await waitDelegated(pda, 20000)) throw new Error('probe did not delegate');
  console.log('[3/5] delegated to ER');

  const infoBefore = await erInfo(pda);
  const sizeBefore = infoBefore ? infoBefore.data.length : -1;
  console.log('      size before resize:', sizeBefore);

  const target = 2000;
  console.log('[4/5] resize on ER to', target, 'bytes...');
  await erSend(() => prog.methods.probeResize(target).accounts({ payer: sponsor.publicKey, probe: pda, systemProgram: SystemProgram.programId }).transaction());

  await sleep(800);
  const infoAfter = await erInfo(pda);
  const sizeAfter = infoAfter ? infoAfter.data.length : -1;
  console.log('      size after resize:', sizeAfter);

  console.log('[5/5] verify marker survived (data preserved):', infoAfter && infoAfter.data[9] === 0xA5 ? 'yes' : 'no');
  if (sizeAfter === target) console.log('[probe-resize] PASS: dynamic growth on the ER works');
  else { console.log('[probe-resize] FAIL: expected', target, 'got', sizeAfter); process.exit(1); }
}
main().catch(e => { console.error('[probe-resize] FAIL:', e.message); process.exit(1); });
