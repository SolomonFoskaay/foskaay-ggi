// scripts/chess-smoke.mjs
// End-to-end smoke for the on-chain chess SINGLE-PLAYER path, using a FRESH
// guest host each run (sponsor pays onboarding + the AI, so the suite is
// repeatable even when the sponsor's own daily lives are spent).
//
// Flow: onboard guest -> create+delegate board -> start -> e2-e4 -> house AI
// reply -> read state -> commit+undelegate.
//
// Run: node scripts/chess-smoke.mjs

import './load-env.mjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor, handleDelegate } from './delegate-relay.mjs';
import { chessCreate, chessAiMove, chessState, chessPda } from './chess-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
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

async function erUrl(pda) {
  try { const st = await getDelegationStatus(conn, pda); if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) return u; } } catch (e) {}
  return pickErRpcUrl();
}
async function waitDelegated(pda, t) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { const st = await getDelegationStatus(conn, pda); if (st && st.isDelegated) return true; } catch (e) {} await sleep(700); }
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
  const guest = Keypair.generate();
  const host = guest.publicKey;
  lastRef = Date.now();
  console.log('[chess-smoke] fresh guest host =', host.toBase58(), 'matchRef =', lastRef);

  console.log('[1/6] onboard guest (sponsor pays)...');
  const onboard = await handleDelegate(host.toBase58(), 'ludo');
  console.log('      steps:', (onboard.steps || []).map(s => s.step).join(', ') || 'already delegated');
  const guestWallet = {
    publicKey: host,
    signTransaction: async (t) => { t.partialSign(guest); return t; },
    signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(guest)); return ts; },
  };
  const guestProg = new Program(idl, new AnchorProvider(conn, guestWallet, { commitment: 'confirmed', skipPreflight: true }));

  console.log('[2/6] create + delegate chess board (relay pays)...');
  const created = await chessCreate({ matchRef: lastRef, host: host.toBase58(), timeMs: 600000, incrementMs: 0, solo: 1 });
  console.log('      create:', JSON.stringify(created));
  if (!created.ok) throw new Error(created.error);
  const pda = chessPda(lastRef);
  if (!await waitDelegated(pda, 20000)) throw new Error('board did not delegate');

  console.log('[3/6] start (guest signs on ER, charges 1 life)...');
  await erSend(guestProg, guest, () => guestProg.methods.startChessMatch(new BN(lastRef)).accounts({ signer: host, board: pda, core: PublicKey.findProgramAddressSync([Buffer.from('gfgcore'), host.toBytes()], PROGRAM)[0] }).transaction());

  console.log('[4/6] white e2-e4...');
  await erSend(guestProg, guest, () => guestProg.methods.makeChessMove(new BN(lastRef), 12, 28, 0).accounts({ signer: host, board: pda }).transaction());

  console.log('[5/6] house AI reply...');
  const ai = await chessAiMove({ matchRef: lastRef, level: 1 });
  console.log('      ai:', JSON.stringify(ai));

  const s = await chessState({ matchRef: lastRef });
  console.log('      sideToMove:', s.sideToMove, 'moveCount:', s.moveCount);

  console.log('[6/6] commit + undelegate board (relay)...');
  await erSend(prog, sponsor, () => prog.methods.undelegateChessBoard(new BN(lastRef)).accounts({ payer: sponsor.publicKey, board: pda, magicProgram: new PublicKey('Magic11111111111111111111111111111111111111'), magicContext: new PublicKey('MagicContext1111111111111111111111111111111') }).transaction());

  if (s.moveCount >= 2) console.log('[chess-smoke] PASS');
  else { console.log('[chess-smoke] FAIL'); process.exit(1); }
}
main().catch(e => { console.error('[chess-smoke] FAIL:', e.message); process.exit(1); });
