// scripts/core-premium-smoke.mjs
// Verify DIRECT premium activation on the Player Core (admin-gated, no premium
// points): the sponsor activates a plan (level 2 -> lives pool 10) and a
// booster, and a non-admin (the guest) is rejected. Fresh guest per run.
//
// Run: node scripts/core-premium-smoke.mjs

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

async function regionUrl(pda) { try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {} return pickErRpcUrl(); }
async function waitDelegated(pda, t) { const end = Date.now() + t; while (Date.now() < end) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); } return false; }
async function readCore(pda) {
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 8000);
  let info = await c.getAccountInfo(pda).catch(() => null);
  if (!info) info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  return {
    pool: d.readUInt16LE(59),
    level: d[133],
    activeUntil: Number(d.readBigInt64LE(134)),
    boosterUntil: Number(d.readBigInt64LE(142)),
  };
}
async function erSend(progInst, signer, buildTx) {
  const pda = corePda;
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 9000);
  const bh = await c.getLatestBlockhash('confirmed');
  const tx = await buildTx();
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(signer);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await c.confirmTransaction({ signature: sig }, 'confirmed');
  return sig;
}
let corePda = null;

async function main() {
  const guest = Keypair.generate();
  const host = guest.publicKey;
  corePda = PublicKey.findProgramAddressSync([CORE, host.toBytes()], PROGRAM)[0];
  console.log('[premium] guest =', host.toBase58(), '| core =', corePda.toBase58());

  console.log('[1/5] onboard guest (core created; admin_authority = sponsor)...');
  await handleDelegate(host.toBase58(), 'ludo');
  if (!await waitDelegated(corePda, 20000)) throw new Error('core did not delegate');

  const guestProg = new Program(idl, new AnchorProvider(conn, { publicKey: host, signTransaction: async (t) => { t.partialSign(guest); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(guest)); return ts; } }, { commitment: 'confirmed', skipPreflight: true }));
  const sponsorProg = new Program(idl, new AnchorProvider(conn, { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } }, { commitment: 'confirmed', skipPreflight: true }));

  const before = await readCore(corePda);
  console.log('[2/5] before:', JSON.stringify(before));

  console.log('[3/5] sponsor activates plan L2 for 30 days (admin-gated)...');
  await erSend(sponsorProg, sponsor, () => sponsorProg.methods.activateCorePlan(2, 30, new BN(0)).accounts({ payer: sponsor.publicKey, playerAuthority: host, core: corePda }).transaction());
  await sleep(700);
  const afterPlan = await readCore(corePda);
  console.log('      after plan:', JSON.stringify(afterPlan));

  console.log('[4/5] sponsor activates a 72h booster...');
  await erSend(sponsorProg, sponsor, () => sponsorProg.methods.activateCoreBooster(72, new BN(0)).accounts({ payer: sponsor.publicKey, playerAuthority: host, core: corePda }).transaction());
  await sleep(700);
  const afterBoost = await readCore(corePda);
  console.log('      after booster:', JSON.stringify(afterBoost));

  console.log('[5/5] non-admin (guest) tries to activate -> must fail...');
  let rejected = false;
  try {
    await erSend(guestProg, guest, () => guestProg.methods.activateCorePlan(3, 30, new BN(0)).accounts({ payer: host, playerAuthority: host, core: corePda }).transaction());
  } catch (e) { rejected = true; console.log('      rejected:', (e.message || '').slice(0, 80)); }

  const now = Math.floor(Date.now() / 1000);
  const okPlan = afterPlan && afterPlan.level === 2 && afterPlan.pool === 10 && afterPlan.activeUntil > now;
  const okBoost = afterBoost && afterBoost.boosterUntil > now;
  if (okPlan && okBoost && rejected) console.log('[core-premium-smoke] PASS: direct activation works, non-admin rejected');
  else { console.log('[core-premium-smoke] FAIL plan=' + okPlan + ' boost=' + okBoost + ' rejected=' + rejected); process.exit(1); }
}
main().catch(e => { console.error('[core-premium-smoke] FAIL:', e.message); process.exit(1); });
