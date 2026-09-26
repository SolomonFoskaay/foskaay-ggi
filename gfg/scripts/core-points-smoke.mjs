// scripts/core-points-smoke.mjs
// Verify record_core_points writes a per-game bucket into the Player Core
// (arcv2m3), with NO per-game PDA created. Fresh guest per run.
//
// Run: node scripts/core-points-smoke.mjs

import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const CORE = Buffer.from('gfgcore');
const sponsor = loadSponsor();
const conn = createConnection(baseRpcUrl(), 'confirmed');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function regionUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function waitDelegated(pda, t) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); }
  return false;
}
async function readCore(pda) {
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 8000);
  let info = await c.getAccountInfo(pda).catch(() => null);
  if (!info) info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  const bucketCount = d[182];
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const o = 183 + i * 24;
    const tag = Buffer.from(d.subarray(o, o + 8)).toString('utf8').replace(/\0+$/, '');
    buckets.push({ tag, pure: Number(d.readBigUInt64LE(o + 8)), spendable: Number(d.readBigUInt64LE(o + 16)) });
  }
  return { day: Number(d.readBigInt64LE(49)), used: d.readUInt16LE(57), pool: d.readUInt16LE(59), bucketCount, buckets, globalPure: Number(d.readBigUInt64LE(93)), globalLifetime: Number(d.readBigUInt64LE(101)), globalSpendable: Number(d.readBigUInt64LE(109)) };
}

async function main() {
  const guest = Keypair.generate();
  const host = guest.publicKey;
  const core = PublicKey.findProgramAddressSync([CORE, host.toBytes()], PROGRAM)[0];
  console.log('[core-points] guest =', host.toBase58(), '| core =', core.toBase58());

  console.log('[1/4] onboard (creates + delegates the core)...');
  await handleDelegate(host.toBase58(), 'ludo');
  if (!await waitDelegated(core, 20000)) throw new Error('core did not delegate');

  const guestWallet = { publicKey: host, signTransaction: async (t) => { t.partialSign(guest); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(guest)); return ts; } };
  const guestProg = new Program(idl, new AnchorProvider(conn, guestWallet, { commitment: 'confirmed', skipPreflight: true }));

  const before = await readCore(core);
  console.log('[2/4] core before:', JSON.stringify(before));

  const matchRef = Date.now();
  console.log('[3/4] record_core_points ludo 100 (ER, guest signs)...');
  const url = await regionUrl(core);
  const c = createConnection(url, 'confirmed', 9000);
  const bh = await c.getLatestBlockhash('confirmed');
  const tx = await guestProg.methods.recordCorePoints('ludo', new BN(100), 1, new BN(matchRef))
    .accounts({ payer: host, playerAuthority: host, core }).transaction();
  tx.feePayer = host;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(guest);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await c.confirmTransaction({ signature: sig }, 'confirmed');

  await sleep(700);
  const after = await readCore(core);
  console.log('[4/4] core after:', JSON.stringify(after));
  const b = after && after.buckets.find(x => x.tag === 'ludo');
  // global-ledger write on the core
  const gRef = Date.now() + 1;
  console.log('[5/5] record_core_global kind 0 (ER)...');
  const tx2 = await guestProg.methods.recordCoreGlobal(0, new BN(100), 1, new BN(gRef)).accounts({ payer: host, playerAuthority: host, core }).transaction();
  tx2.feePayer = host; tx2.recentBlockhash = bh.blockhash; tx2.lastValidBlockHeight = bh.lastValidBlockHeight; tx2.partialSign(guest);
  const sig2 = await c.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
  await c.confirmTransaction({ signature: sig2 }, 'confirmed');
  await sleep(700);
  const g = await readCore(core);
  console.log('      global pure/lifetime/spendable:', g.globalPure, g.globalLifetime, g.globalSpendable);
  const okPts = after && after.bucketCount === 1 && b && b.pure === 100 && b.spendable === 100;
  const okGlob = g && g.globalPure === 100 && g.globalLifetime === 100 && g.globalSpendable === 100;
  if (okPts && okGlob) console.log('[core-points-smoke] PASS: bucket + global ledgers written on the core, no per-game PDA');
  else { console.log('[core-points-smoke] FAIL pts=' + okPts + ' glob=' + okGlob); process.exit(1); }
}
main().catch(e => { console.error('[core-points-smoke] FAIL:', e.message); process.exit(1); });
