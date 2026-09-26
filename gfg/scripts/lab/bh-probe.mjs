// Probe: build the init (base) tx but set blockhash via MagicBlock's
// getBlockhashForAccounts (per-layer), send through the Router, then check the
// signature lands on base devnet.
import { readFileSync } from 'fs';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { createConnection, baseRpcUrl, getBlockhashForAccounts, getWritableAccounts, routerUrl } from '../../src/gfg-rpc.js';

const idl = JSON.parse(readFileSync(new URL('../../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/foskaay/.config/solana/id.json', 'utf8'))));
const PROGRAM_ID = new PublicKey(idl.address);
const PLAYER_SEED = Buffer.from('gfgplayerd');

const mkWallet = (kp) => ({ publicKey: kp.publicKey, async signTransaction(t){return t;}, async signAllTransactions(ts){return ts;} });

const router = new Connection(routerUrl(), 'confirmed');

console.log('Router getLatestBlockhash   :', JSON.stringify(await router.getLatestBlockhash()).slice(0, 160));
const bhForAccounts = await getBlockhashForAccounts(router, [sponsor.publicKey]);
console.log('getBlockhashForAccounts([s]):', JSON.stringify(bhForAccounts).slice(0, 160));
const baseConn = new Connection('https://api.devnet.solana.com', 'confirmed');
console.log('Base api.getLatestBlockhash :', JSON.stringify(await baseConn.getLatestBlockhash()).slice(0, 160));