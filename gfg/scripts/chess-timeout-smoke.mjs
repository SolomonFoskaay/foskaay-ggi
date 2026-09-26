// scripts/chess-timeout-smoke.mjs
// Phase 5 benchmark: the permissionless clock timeout. Create a 1.5s game,
// start it, do NOT move, wait for the clock to lapse, then claim_chess_timeout
// from a third party (the sponsor) and assert the result is a loss for the
// side that ran out (white), i.e. black wins.
//
// Run: node scripts/chess-timeout-smoke.mjs

import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';
import { chessCreate, chessPda, chessState } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const LIVES = Buffer.from('gfgcore');
const sponsor = loadSponsor();
const wallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastRef = 0;
function livesFor(k) { return PublicKey.findProgramAddressSync([LIVES, k.toBytes()], PROGRAM)[0]; }
async function erUrl(pda) { try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {} return pickErRpcUrl(); }
async function waitDelegated(pda, t) { const d = Date.now() + t; while (Date.now() < d) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); } return false; }
async function erSend(buildTx, signer) {
  signer = signer || sponsor;
  const pda = chessPda(lastRef);
  const url = await erUrl(pda);
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
  console.log('[timeout] matchRef =', lastRef, '| fresh host =', host.toBase58());
  await handleDelegate(host.toBase58(), 'ludo');
  const guestWallet = { publicKey: host, signTransaction: async (t) => { t.partialSign(guest); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(guest)); return ts; } };
  const guestProg = new Program(idl, new AnchorProvider(conn, guestWallet, { commitment: 'confirmed', skipPreflight: true }));
  const c = await chessCreate({ matchRef: lastRef, host: host.toBase58(), timeMs: 1500, incrementMs: 0, solo: 1 });
  console.log('[1/4] create:', JSON.stringify(c));
  if (!c.ok) throw new Error(c.error);
  const pda = chessPda(lastRef);
  if (!await waitDelegated(pda, 20000)) throw new Error('board did not delegate');

  console.log('[2/4] start (1.5s clock)...');
  await erSend(() => guestProg.methods.startChessMatch(new BN(lastRef)).accounts({ signer: host, board: pda, core: livesFor(host) }).transaction(), guest);

  console.log('[3/4] wait 2.6s for white to run out (no moves)...');
  await sleep(2600);

  console.log('[4/4] permissionless claim_chess_timeout (third party)...');
  await erSend(() => prog.methods.claimChessTimeout(new BN(lastRef)).accounts({ signer: sponsor.publicKey, board: pda }).transaction());

  const s = await chessState({ matchRef: lastRef });
  console.log('      status:', s.status, 'result:', s.result, '(1=black wins)', 'endReason:', s.endReason, '(3=timeout)');
  if (s.status === 2 && s.result === 1 && s.endReason === 3) console.log('[chess-timeout-smoke] PASS');
  else { console.log('[chess-timeout-smoke] FAIL'); process.exit(1); }
}
main().catch(e => { console.error('[chess-timeout-smoke] FAIL:', e.message); process.exit(1); });
