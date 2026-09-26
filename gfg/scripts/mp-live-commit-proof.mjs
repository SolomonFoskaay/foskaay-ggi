// scripts/mp-live-commit-proof.mjs
// PROVES the LIVE multiplayer on-chain write path headlessly against devnet:
//   start_match(host-only) -> delegate(gasless surface) -> begin_match (creator
//   signs) -> commit_move (player session key signs, seat authority) -> read back.
//
// Mirrors EXACTLY what the browser does:
//   - board seed gfgboard2 (deployed v3 with creator field)
//   - start_match with players=[host] only (player_count=1)
//   - begin by the CREATOR wallet (not sponsor)
//   - commit by the seat-0 player wallet, full 32-byte snapshot bytes
// Confirms move_count bumps + current_turn records + creator authority.
//
// Run: node scripts/mp-live-commit-proof.mjs   (needs env already in .env)

import './load-env.mjs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { BN } from 'bn.js';
import { baseRpcUrl, createConnection, sendMagicTx, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';
import { loadSponsor } from './delegate-relay.mjs';
import { readFileSync } from 'fs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const BOARD_SEED = Buffer.from('gfgboard2');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VALIDATOR_ID = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'); // AS region pin
const sponsor = loadSponsor();
const wallet = { publicKey: sponsor.publicKey, signTransaction: async (t) => { t.partialSign(sponsor); return t; }, signAllTransactions: async (ts) => { ts.forEach(t => t.partialSign(sponsor)); return ts; } };
const conn = createConnection(baseRpcUrl(), 'confirmed');
const prog = new Program(idl, new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function send(tx, sigs = [sponsor]) { tx.feePayer = sponsor.publicKey; const sig = await sendMagicTx(conn, tx, sigs, { skipPreflight: true }); await conn.confirmTransaction({ signature: sig }, 'confirmed'); return sig; }

const GAME = 1;
const REF = Math.floor(Date.now() / 1000) % 1000000; // unique ref
const p2 = Keypair.generate();
const boardPda = PublicKey.findProgramAddressSync([BOARD_SEED, Buffer.from([GAME]), new BN(REF).toArrayLike(Buffer, 'le', 8)], PROGRAM)[0];
console.log('BOARD PDA:', boardPda.toBase58(), '| REF:', REF);

// 1. start_match: host-only (creator = sponsor wallet here for proof; in the
//    browser this is the player's wallet host resolveHost()).
await send(await prog.methods.startMatch(GAME, new BN(REF), [sponsor.publicKey], 2, new BN(0), new BN(60), new BN(3600))
  .accounts({ payer: sponsor.publicKey, board: boardPda, systemProgram: SystemProgram.programId }).transaction());
console.log('1. start_match ok (host-only seat0)');

// 2. delegate board into ER (same as relay ensureBoardDelegated)
const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), boardPda.toBytes()], PROGRAM);
const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), boardPda.toBytes()], DELEGATION_PROGRAM_ID);
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), boardPda.toBytes()], DELEGATION_PROGRAM_ID);
await send(await prog.methods.delegateBoard(GAME, new BN(REF))
  .accounts({ payer: sponsor.publicKey, bufferBoard: buffer, delegationRecordBoard: record, delegationMetadataBoard: metadata, board: boardPda, ownerProgram: PROGRAM, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId })
  .remainingAccounts([{ pubkey: ER_VALIDATOR_ID, isSigner: false, isWritable: false }]).transaction());
console.log('2. delegate_board ok (AS region pin)');

// 2b. the invited player joins seat 1 (gasless ER, PLAYER signs) - fills the
//     board so begin's player_count==seats gate passes. p2 is a fresh keypair
//     standing in for the invited player's session wallet.
{
  const st = await getDelegationStatus(conn, boardPda);
  let region = pickErRpcUrl();
  if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) region = u; }
  const connEr = createConnection(region, 'confirmed');
  const bh = await connEr.getLatestBlockhash('confirmed');
  const jtx = await prog.methods.joinMatch(GAME, new BN(REF), 1, 'GFG-BTEST')
    .accounts({ signer: p2.publicKey, board: boardPda }).transaction();
  jtx.feePayer = p2.publicKey;
  jtx.recentBlockhash = bh.blockhash;
  jtx.lastValidBlockHeight = bh.lastValidBlockHeight;
  jtx.partialSign(p2);
  const jsig = await connEr.sendRawTransaction(jtx.serialize(), { skipPreflight: true });
  await connEr.confirmTransaction({ signature: jsig }, 'confirmed');
  console.log('2b. join_match ok (gasless ER, invited seat1)');
}

// 3. begin by CREATOR on the ER region (gasless, like the browser). Once the
//    board is delegated its owner moves to the Delegation Program, so begin
//    MUST be submitted to the ER region, NOT the base layer (base rejects it).
let regionUrl = pickErRpcUrl();
try {
  const st = await getDelegationStatus(conn, boardPda);
  if (st && st.fqdn) { const u = regionUrlForFqdn(st.fqdn); if (u) regionUrl = u; }
} catch (e) {}
console.log('3. deleg status region:', regionUrl);
{
  const connEr = createConnection(regionUrl, 'confirmed');
  const bh = await connEr.getLatestBlockhash('confirmed');
  const tx = await prog.methods.beginMatch(GAME, new BN(REF)).accounts({ signer: sponsor.publicKey, board: boardPda }).transaction();
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(sponsor);
  const sig = await connEr.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connEr.confirmTransaction({ signature: sig }, 'confirmed');
  console.log('3. begin_match ok (gasless ER, creator-signed)');
}

// 4b. a player's session-key-style signer: a fresh keypair signs, but the
//     program requires signer == creator for begin (sponsor). For commit the
//     program requires signer == players[seat]. Seat0 = creator = sponsor, so
//     use the sponsor to authenticate seat 0 (exactly like the browser's session
//     key which represents the player wallet).

// commit via the ER region (gasless, like the client)
const commitBytes = Array.from(new Uint8Array(32));
commitBytes[0] = 0; commitBytes[1] = 4; commitBytes[2] = 6; // dice 4+6
for (let i = 3; i < 19; i++) commitBytes[i] = 0;             // board snapshot: green token0 at step6
commitBytes[3] = 6;                                          // green[0].stepsWalked = 6 (left yard)
{
  const connEr = createConnection(regionUrl, 'confirmed');
  const bh = await connEr.getLatestBlockhash('confirmed');
  const tx = await prog.methods.commitMove(GAME, new BN(REF), 0, commitBytes)
    .accounts({ signer: sponsor.publicKey, board: boardPda }).transaction();
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.partialSign(sponsor);
  const sig = await connEr.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connEr.confirmTransaction({ signature: sig }, 'confirmed');
  console.log('5. commit_move ok (gasless ER) sig:', sig);
}
await sleep(1500);

// 6. read back from the region (like the browser boardState)
let d = null;
for (const url of [regionUrl, pickErRpcUrl(), baseRpcUrl()]) {
  try {
    const c = createConnection(url, 'confirmed');
    const info = await c.getAccountInfo(boardPda);
    if (info && info.data && info.data.length >= 655) { d = info.data; break; }
  } catch (e) {}
}
if (!d) { console.log('READBACK FAILED'); process.exit(1); }
const res = {
  version: d[8], status: d[18], playerCount: d[275], seats: d[276],
  currentTurn: d[469], moveCount: Number(d.readBigUInt64LE(574)),
  commitHead: Array.from(d.subarray(582, 590)),
  creator: new PublicKey(d.subarray(623, 655)).toBase58(),
};
console.log('BOARD:', JSON.stringify(res));
const pass = res.status === 1 && res.moveCount === 1 && res.playerCount === 2 && res.seats === 2 && res.creator === sponsor.publicKey.toBase58() && res.commitHead[0] === 0 && res.commitHead[1] === 4 && res.commitHead[2] === 6;
console.log('LIVE COMMIT PATH PASS:', pass ? 'YES' : 'NO');
process.exit(0);