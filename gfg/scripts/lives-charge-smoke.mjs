// scripts/lives-charge-smoke.mjs
// Verify M10 lives are charged AT GAME START, using a FRESH guest player each
// run (the sponsor's own daily pool is often spent by other tests). Reads the
// guest's lives, creates + STARTS a chess match, and confirms `used` went up by
// exactly 1 while create charged nothing.
//
// Run: node scripts/lives-charge-smoke.mjs

import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';
import { chessCreate, chessPda } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const LIVES_SEED = Buffer.from('gfgcore');
const sponsor = loadSponsor();
const conn = createConnection(baseRpcUrl(), 'confirmed');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastRef = 0;

function livesPda(k) { return PublicKey.findProgramAddressSync([LIVES_SEED, k.toBytes()], PROGRAM)[0]; }
async function regionUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function readUsed(pubkey) {
  const pda = livesPda(pubkey);
  const url = await regionUrl(pda);
  const c = createConnection(url, 'confirmed', 8000);
  let info = await c.getAccountInfo(pda).catch(() => null);
  if (!info) info = await conn.getAccountInfo(pda).catch(() => null);
  if (!info) return null;
  const d = info.data;
  return { day: Number(d.readBigInt64LE(49)), used: d.readUInt16LE(57), pool: d.readUInt16LE(59) };
}
async function waitDelegated(pda, t) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); }
  return false;
}
async function erSend(prog, signer, buildTx) {
  const pda = chessPda(lastRef);
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

async function main() {
  const guest = Keypair.generate();
  const host = guest.publicKey;
  lastRef = Date.now();
  console.log('[lives] fresh guest =', host.toBase58());

  console.log('[0/5] onboard the guest (sponsor pays, fresh pool of 5)...');
  await handleDelegate(host.toBase58(), 'ludo');
  const guestWallet = {
    publicKey: host,
    signTransaction: async (t) => { t.partialSign(guest); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(guest)); return ts; },
  };
  const guestProg = new Program(idl, new AnchorProvider(conn, guestWallet, { commitment: 'confirmed', skipPreflight: true }));

  const before = await readUsed(host);
  console.log('[1/5] lives BEFORE:', JSON.stringify(before));

  console.log('[2/5] create + delegate chess board...');
  const c = await chessCreate({ matchRef: lastRef, host: host.toBase58(), timeMs: 600000, incrementMs: 0, solo: 1 });
  if (!c.ok) throw new Error(c.error);
  const pda = chessPda(lastRef);
  if (!await waitDelegated(pda, 20000)) throw new Error('board did not delegate');

  const mid = await readUsed(host);
  console.log('[3/5] lives BEFORE start (create must not charge):', JSON.stringify(mid));

  console.log('[4/5] START (must charge 1)...');
  await erSend(guestProg, guest, () => guestProg.methods.startChessMatch(new BN(lastRef)).accounts({ signer: host, board: pda, core: livesPda(host) }).transaction());

  const after = await readUsed(host);
  console.log('[5/5] lives AFTER start:', JSON.stringify(after));
  const charged = after && before && after.used === before.used + 1;
  const createFree = mid && before && mid.used === before.used;
  if (charged && createFree) console.log('[lives-charge-smoke] PASS: life charged at START, not at create');
  else { console.log('[lives-charge-smoke] FAIL charged=' + charged + ' createFree=' + createFree); process.exit(1); }
}
main().catch(e => { console.error('[lives-charge-smoke] FAIL:', e.message); process.exit(1); });
