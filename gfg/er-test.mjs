// Temporary ER end-to-end test for gfg-dice on devnet.
// Tests the full gasless flow: initialize (base) -> delegate (base) -> roll (ER) -> undelegate (ER).
import { readFileSync } from 'fs';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './scripts/load-env.mjs'; // load .env before resolving the RPC chain
import { baseRpcUrl, createConnection, sendMagicTx, pickErRpcUrl } from './src/gfg-rpc.js';
// NOTE: baseRpcUrl() returns the Magic Router (MagicBlock-first): init+delegate
// auto-route through it to base Solana. ER rolls run on the rotation-aware ER
// region endpoint (src/gfg-rpc.js registry, US/AS/EU failover); roll results
// are only readable on that region endpoint until undelegate commits state back
// to base.

const idl = JSON.parse(readFileSync(new URL('./src/gfg-dice-idl.json', import.meta.url), 'utf8'));

const PROGRAM_ID = new PublicKey(idl.address);
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_VRF_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const ER_VALIDATOR = new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd');

const BASE_URL = baseRpcUrl();
const ER_URL = pickErRpcUrl();
const PLAYER_SEED = Buffer.from('gfgplayerd');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lamports = (n) => (Number(n) / 1e9).toFixed(4);

const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/foskaay/.config/solana/id.json', 'utf8'))));

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

const baseConn = createConnection(BASE_URL, 'confirmed');
const baseProvider = new AnchorProvider(baseConn, mkWallet(sponsor), { commitment: 'confirmed', skipPreflight: true });
const baseProgram = new Program(idl, baseProvider);

const player = Keypair.generate();
console.log('Sponsor :', sponsor.publicKey.toString());
console.log('Player  :', player.publicKey.toString());

const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBytes()], PROGRAM_ID);
const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
console.log('PlayerPDA:', pda.toString());

async function main() {
  const bal0 = await baseConn.getBalance(sponsor.publicKey);

  // Base-layer txs MUST be sent via sendMagicTx: the Router answers plain
  // getLatestBlockhash with ITS OWN layer blockhash (invalid on base Solana).
  // sendMagicTx uses getBlockhashForAccounts, which returns the correct
  // base-layer blockhash (see src/gfg-rpc.js).

  // 1) initialize (base layer, sponsor pays rent+fee)
  console.log('\n--- initialize (base) ---');
  try {
    const tx = await baseProgram.methods.initialize()
      .accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey })
      .transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
    await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('init OK:', sig);
  } catch (e) { console.log('init ERR:', e.message.slice(0, 300)); return; }

  // 2) delegate (base layer, sponsor pays; pin devnet ER validator)
  console.log('\n--- delegate (base) ---');
  try {
    const tx = await baseProgram.methods.delegate()
      .accounts({
        payer: sponsor.publicKey,
        playerAuthority: player.publicKey,
        player: pda,
        bufferPlayer: buffer,
        delegationRecordPlayer: record,
        delegationMetadataPlayer: metadata,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
      .transaction();
    tx.feePayer = sponsor.publicKey;
    const sig = await sendMagicTx(baseConn, tx, [sponsor], { skipPreflight: true });
    await baseConn.confirmTransaction({ signature: sig }, 'confirmed');
    console.log('delegate OK:', sig);
  } catch (e) { console.log('delegate ERR:', e.message.slice(0, 300)); return; }

  // Wait for the validator to pick up the delegated account
  await sleep(4000);

  // 3) roll on the ER (gasless; player is fee payer + signer via session key)
  console.log('\n--- roll on ER (gasless) ---');
  const erConn = new Connection(ER_URL, 'confirmed');
  const erProvider = new AnchorProvider(erConn, mkWallet(player), { commitment: 'confirmed', skipPreflight: true });
  const erProgram = new Program(idl, erProvider);
  const clientSeed = Math.floor(Math.random() * 256);
  console.log('clientSeed:', clientSeed);
  try {
    const sig = await erProgram.methods.rollDice(clientSeed)
      .accounts({
        player: pda,
        payer: player.publicKey,
        playerAuthority: player.publicKey,
        oracleQueue: ER_VRF_QUEUE,
      })
      .rpc();
    console.log('rollDice ER tx:', sig);
  } catch (e) { console.log('rollDice ERR:', e.message.slice(0, 300)); return; }

  // 4) poll for the callback on the ER
  console.log('\n--- waiting for VRF callback (up to 40s) ---');
  let result = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try {
      const acc = await erProgram.account.playerDice.fetch(pda);
      if (Number(acc.lastClientSeed) === clientSeed && Number(acc.lastRoll1) > 0) { result = acc; break; }
    } catch (e) { /* not settled yet */ }
  }
  console.log('ER result:', result ? { roll1: Number(result.lastRoll1), roll2: Number(result.lastRoll2), seed: Number(result.lastClientSeed) } : 'NOT SETTLED');

  // 5) undelegate on the ER (commits state back to base layer)
  console.log('\n--- undelegate (ER) ---');
  try {
    const sig = await erProgram.methods.undelegate()
      .accounts({ payer: player.publicKey, playerAuthority: player.publicKey, player: pda })
      .rpc();
    console.log('undelegate OK:', sig);
  } catch (e) { console.log('undelegate ERR:', e.message.slice(0, 200)); }

  const bal1 = await baseConn.getBalance(sponsor.publicKey);
  console.log('\nSponsor balance:', lamports(bal0), '->', lamports(bal1), 'SOL (spent', lamports(bal0 - bal1) + ')');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
