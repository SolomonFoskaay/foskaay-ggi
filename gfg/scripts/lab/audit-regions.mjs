// Read-only audit: delegation region of every PDA for every known wallet.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey } from '@solana/web3.js';
import { baseRpcUrl, createConnection, getDelegationStatus } from '../../src/gfg-rpc.js';
import { loadSponsor } from '../delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const SEEDS = { dice: Buffer.from('gfgplayerd'), points: Buffer.from('gfgpoints'), result: Buffer.from('gfgresult') };
const GAME_TAGS = ['ludo', 'ludo_lab', 'sandbox', 'ayo_olopon', 'ayo_lab'];
const conn = createConnection(baseRpcUrl(), 'confirmed');

const walletSet = new Set();
for (const pk of Object.keys(JSON.parse(readFileSync('.gfg-spend-ledger.json','utf8')).players || {})) walletSet.add(pk);
const SUPABASE_URL = 'https://ywrgxynjjgdicdzizpue.supabase.co';
const KEY = 'sb_publishable_qbrLQtG1fx51sBIiDm_zGQ_dR6BcqEb';
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=solana_wallet`, { headers: h });
const rows = await r.json();
for (const p of rows) if (p.solana_wallet) walletSet.add(p.solana_wallet);
walletSet.add(loadSponsor().publicKey.toBase58()); // house

const pdaFor = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const status = async (pda) => { try { return await getDelegationStatus(conn, pda); } catch(e){ return null; } };

for (const w of [...walletSet].sort()) {
  const player = new PublicKey(w);
  const list = [];
  list.push(['dice', pdaFor([SEEDS.dice, player.toBytes()])]);
  for (const tag of GAME_TAGS) list.push([`pts[${tag}]`, pdaFor([SEEDS.points, Buffer.from(tag,'utf8'), player.toBytes()])]);
  list.push(['result', pdaFor([SEEDS.result, player.toBytes()])]);
  list.push(['global', pdaFor([SEEDS.points, Buffer.from('global'), player.toBytes()])]);
  const lines = [];
  for (const [label, pda] of list) {
    const st = await status(pda);
    const region = st && st.isDelegated ? (st.fqdn || 'delegated?').split('.magicblock.app')[0] : (st && st.isDelegated ? 'delegated?' : '-');
    if (st && st.isDelegated) lines.push(`${label}=${region.replace('https://','')}`);
  }
  console.log(w === loadSponsor().publicKey.toBase58() ? `HOUSE ${w.slice(0,12)}: ${lines.join(' ')}` : `${w.slice(0,16)}: ${lines.join(' ')}`);
}
process.exit(0);
