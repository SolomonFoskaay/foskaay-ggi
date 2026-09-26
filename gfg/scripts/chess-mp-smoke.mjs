// scripts/chess-mp-smoke.mjs
// End-to-end smoke test for on-chain chess MULTIPLAYER (Phase 3).
// Sponsor = host (white, seat 0); a throwaway 0-SOL key = joiner (black, seat 1).
// Flow: onboard joiner -> create MP board -> join -> start -> white move ->
// black move -> black resigns -> white wins.
//
// Run: node scripts/chess-mp-smoke.mjs

import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { chessCreate, chessPda, chessState } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const LIVES = Buffer.from('gfgcore');
const sponsor = loadSponsor();
const sponsorWallet = {
  publicKey: sponsor.publicKey,
  signTransaction: async (t) => { t.partialSign(sponsor); return t; },
  signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; },
};
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, sponsorWallet, { commitment: 'confirmed', skipPreflight: true }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastRef = 0;
function livesFor(k) { return PublicKey.findProgramAddressSync([LIVES, k.toBytes()], PROGRAM)[0]; }

async function erUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function waitDelegated(pda, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {}
    await sleep(700);
  }
  return false;
}
async function erSend(progInst, signer, buildTx) {
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
  const hostG = Keypair.generate();
  const joiner = Keypair.generate();
  lastRef = Date.now();
  console.log('[mp] host(white) =', sponsor.publicKey.toBase58());
  console.log('[mp] joiner(black) =', joiner.publicKey.toBase58(), '| matchRef =', lastRef);

  console.log('[1/7] onboard joiner (sponsor pays, all PDAs incl. lives)...');
  const { handleDelegate } = await import('./delegate-relay.mjs');
  const hostSteps = await handleDelegate(hostG.publicKey.toBase58(), 'ludo');
  const steps = await handleDelegate(joiner.publicKey.toBase58(), 'ludo');
  console.log('      steps:', (steps.steps || []).map(s => s.step).join(', ') || 'already delegated');

  const joinerWallet = {
    publicKey: joiner.publicKey,
    signTransaction: async (t) => { t.partialSign(joiner); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(joiner)); return ts; },
  };
  const joinerProg = new Program(idl, new AnchorProvider(conn, joinerWallet, { commitment: 'confirmed', skipPreflight: true }));
  const hostWallet = { publicKey: hostG.publicKey, signTransaction: async (t) => { t.partialSign(hostG); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(hostG)); return ts; } };
  const hostProg = new Program(idl, new AnchorProvider(conn, hostWallet, { commitment: 'confirmed', skipPreflight: true }));

  console.log('[2/7] create + delegate MP board (solo=0, sponsor pays)...');
  const created = await chessCreate({ matchRef: lastRef, host: hostG.publicKey.toBase58(), timeMs: 600000, incrementMs: 0, solo: 0 });
  console.log('      create:', JSON.stringify(created));
  if (!created.ok) throw new Error(created.error);
  const pda = chessPda(lastRef);
  if (!await waitDelegated(pda, 20000)) throw new Error('board did not delegate');

  console.log('[3/7] black joins (0-SOL key signs on ER)...');
  const joinSig = await erSend(joinerProg, joiner, () => joinerProg.methods.joinChessMatch(new BN(lastRef))
    .accounts({ signer: joiner.publicKey, board: pda, core: livesFor(joiner.publicKey) }).transaction());
  console.log('      join sig:', joinSig);

  let s = await chessState({ matchRef: lastRef });
  console.log('      seats:', s.seats.join(' , '));

  console.log('[4/7] host starts (ER)...');
  await erSend(hostProg, hostG, () => hostProg.methods.startChessMatch(new BN(lastRef))
    .accounts({ signer: hostG.publicKey, board: pda, core: livesFor(hostG.publicKey) }).transaction());
  s = await chessState({ matchRef: lastRef });
  console.log('      status:', s.status, 'sideToMove:', s.sideToMove);

  console.log('[5/7] white e2-e4, then black e7-e5 (both sign on ER)...');
  await erSend(hostProg, hostG, () => hostProg.methods.makeChessMove(new BN(lastRef), 12, 28, 0)
    .accounts({ signer: hostG.publicKey, board: pda }).transaction());
  await erSend(joinerProg, joiner, () => joinerProg.methods.makeChessMove(new BN(lastRef), 52, 36, 0)
    .accounts({ signer: joiner.publicKey, board: pda }).transaction());
  s = await chessState({ matchRef: lastRef });
  console.log('      moveCount:', s.moveCount, 'sideToMove:', s.sideToMove);

  console.log('[6/7] black resigns (ER)...');
  await erSend(joinerProg, joiner, () => joinerProg.methods.resignChessMatch(new BN(lastRef))
    .accounts({ signer: joiner.publicKey, board: pda }).transaction());

  console.log('[7/7] read result...');
  s = await chessState({ matchRef: lastRef });
  console.log('      status:', s.status, 'result:', s.result, '(0=white wins)', 'endReason:', s.endReason);
  if (s.status === 2 && s.result === 0) console.log('[chess-mp-smoke] PASS');
  else { console.log('[chess-mp-smoke] FAIL'); process.exit(1); }
}

main().catch(e => { console.error('[chess-mp-smoke] FAIL:', e.message); process.exit(1); });
