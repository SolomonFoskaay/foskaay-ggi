// bench-er-roll.mjs — how FAST is a real gfg-dice VRF roll on the ER?
// Follows MagicBlock's OWN roll-dice example (magicblock-engine-examples):
//   - base init+delegate via plain .rpc() on https://rpc.magicblock.app/devnet
//   - ER roll via direct validator connection, result detected via
//     onAccountChange WS subscription at 'processed' (no polling)
// Measures the true send -> VRF-result floor for the UX question:
// "can the dice be on-chain for EVERY roll and still feel web2?"
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { pickErRpcUrl } from '../../src/gfg-rpc.js';

const PROGRAM_ID = new PublicKey('CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ');
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ER_URL = pickErRpcUrl();
const ER_WS = ER_URL.replace(/^https:\/\//, 'wss://');
const BASE_ENDPOINT = 'https://rpc.magicblock.app/devnet';
const ROUTER_ENDPOINT = 'https://devnet-router.magicblock.app';
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const PLAYER_SEED = Buffer.from('gfgplayerd');
const N_ROLLS = 8;

const idl = JSON.parse(readFileSync('/home/foskaay/globalfolkgames/src/gfg-dice-idl.json', 'utf8'));

function loadSponsor() {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
}
const sponsor = loadSponsor();

function mkWallet(kp) {
  return {
    publicKey: kp.publicKey,
    async signTransaction(t) { t.partialSign(kp); return t; },
    async signAllTransactions(ts) { return Promise.all(ts.map(t => { t.partialSign(kp); return t; })); },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// PlayerDice = u8 disc(8) + last_roll1:u8 + last_roll2:u8 + last_client_seed:u8 + last_request_ts:i64
// 8 + 1 + 1 + 1 + 8 = 19 bytes. Manual parse (coder.accounts.decode throws).
function decodePlayerDice(data) {
  if (!data || data.length < 19) return null;
  return {
    lastRoll1: data.readUInt8(8),
    lastRoll2: data.readUInt8(9),
    lastClientSeed: data.readUInt8(10),
    lastRequestTs: data.readBigInt64LE(11),
  };
}

// Fallback result detection: poll the account until lastClientSeed matches.
async function pollForResult(conn, pda, seed) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      const info = await conn.getAccountInfo(pda, 'processed');
      const state = info && decodePlayerDice(info.data);
      if (state && state.lastClientSeed === seed) {
        return { roll1: state.lastRoll1, roll2: state.lastRoll2 };
      }
    } catch (_) {}
  }
  return null;
}

// getDelegationStatus via the Magic Router (authoritative).
async function getDelegationStatus(conn, account) {
  const accountAddress = account.toBase58();
  const res = await fetch(`${conn.rpcEndpoint}/getDelegationStatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [accountAddress] }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`getDelegationStatus failed: ${JSON.stringify(data.error || data)}`);
  return data.result;
}

// init + delegate on base, exactly like MagicBlock's roll-dice example
// (plain .rpc() against rpc.magicblock.app/devnet). Requires healthy devnet.
async function onboard(player, pda) {
  const baseConn = new Connection(BASE_ENDPOINT, 'confirmed');
  const baseProgram = new Program(idl, new AnchorProvider(baseConn, mkWallet(sponsor), AnchorProvider.defaultOptions()));
  if (!(await baseConn.getAccountInfo(pda))) {
    console.log('[base] initialize...');
    await baseProgram.methods.initialize()
      .accounts({ player: pda, payer: sponsor.publicKey, playerAuthority: player.publicKey })
      .rpc({ skipPreflight: true, commitment: 'confirmed' });
  }
  const routerConn = new Connection(ROUTER_ENDPOINT, 'confirmed');
  let delegated = false;
  try { const s = await getDelegationStatus(routerConn, pda); delegated = !!(s && s.isDelegated); } catch (_) {}
  if (!delegated) {
    console.log('[base] delegate...');
    const [buffer] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), pda.toBytes()], PROGRAM_ID);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), pda.toBytes()], DELEGATION_PROGRAM);
    const [metadata] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), pda.toBytes()], DELEGATION_PROGRAM);
    await baseProgram.methods.delegate()
      .accounts({
        payer: sponsor.publicKey,
        playerAuthority: player.publicKey,
        bufferPlayer: buffer,
        delegationRecordPlayer: record,
        delegationMetadataPlayer: metadata,
        player: pda,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM,
        systemProgram: new PublicKey('11111111111111111111111111111111'),
      })
      .remainingAccounts([{ pubkey: new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd'), isSigner: false, isWritable: false }])
      .rpc({ skipPreflight: true, commitment: 'confirmed' });

    const dl = Date.now() + 25000;
    while (Date.now() < dl) {
      await sleep(1000);
      try { const s = await getDelegationStatus(routerConn, pda); if (s && s.isDelegated) { delegated = true; break; } } catch (_) {}
    }
    if (!delegated) throw new Error('delegation did not register on the Magic Router');
  }
  console.log('[base] delegated: true');
}

async function main() {
  // REUSE an already-delegated PDA so devnet-base being down doesn't block the
  // measurement. The sponsor's own gfg-dice PDA (delegated at 03:42) is live.
  // Uncomment the 'reuse' line to skip init+delegate entirely.
  const reuse = process.env.REUSE_PDA === '1';
  const player = reuse ? sponsor : Keypair.generate();
  const pda = PublicKey.findProgramAddressSync([PLAYER_SEED, player.publicKey.toBytes()], PROGRAM_ID)[0];
  console.log('player:', player.publicKey.toBase58());
  console.log('pda    :', pda.toBase58());
  if (!reuse) {
    console.log('[setup] devnet base must be healthy to onboard a new player.');
    console.log('[setup] (Solana devnet is DOWN right now — numTransactions: 0.)');
  }
  if (!reuse) await onboard(player, pda);
  console.log('[setup] using delegated PDA on ER.\n');

  // --- ER: connect directly to the validator, subscribe to account changes ---
  const erConn = new Connection(ER_URL, { wsEndpoint: ER_WS, commitment: 'processed' });
  const erProgram = new Program(idl, new AnchorProvider(erConn, mkWallet(player), AnchorProvider.defaultOptions()));

  // Wait for ER pickup + warm the account.
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const info = await erConn.getAccountInfo(pda, 'processed'); if (info && info.data.length > 0) break; } catch (_) {}
  }
  console.log('[ER] account picked up.\n');

  const tSends = [], tCbs = [];
  for (let i = 0; i < N_ROLLS; i++) {
    const seed = Math.floor(Math.random() * 256);

    // Pre-arm the account-change promise (like onAccountChange in the example).
    let resolveCb;
    const cbPromise = new Promise(r => { resolveCb = r; });
    const subId = await erConn.onAccountChange(pda, (info, ctx) => {
      try {
        const state = decodePlayerDice(info.data);
        if (state && state.lastClientSeed === seed) resolveCb({ roll1: state.lastRoll1, roll2: state.lastRoll2, slot: ctx.slot });
      } catch (_) {}
    }, 'processed');

    const t0 = Date.now();
    const sig = await erProgram.methods.rollDice(seed)
      .accounts({ player: pda, payer: player.publicKey, playerAuthority: player.publicKey, oracleQueue: ER_QUEUE })
      .rpc({ skipPreflight: true, commitment: 'confirmed' });
    tSends.push(Date.now() - t0);

    // Primary: account-change WS push. Fallback: 250ms poll (the official
    // example does exactly this when the WS push is missed).
    const result = await Promise.race([
      cbPromise,
      pollForResult(erConn, erProgram, pda, seed).then(r => r ? { ...r, viaPoll: true } : null),
      new Promise(r => setTimeout(() => r(null), 10000)),
    ]).finally(() => erConn.removeAccountChangeListener(subId));
    if (!result) {
      const debug = await erConn.getAccountInfo(pda, 'processed').catch(() => null);
      let dbg = 'no account';
      if (debug) {
        const st = decodePlayerDice(debug.data);
        dbg = st ? `lastClientSeed=${st.lastClientSeed} want=${seed} rolls=${st.lastRoll1},${st.lastRoll2}` : `undecodable(${debug.data.length}b)`;
      }
      throw new Error(`roll ${i} never settled (seed ${seed}). account: ${dbg}`);
    }
    tCbs.push(Date.now() - t0);
    console.log(`roll ${i}: send-confirm ${tSends[i].toFixed(0)}ms  to-callback ${tCbs[i].toFixed(0)}ms  [${result.viaPoll ? 'poll' : 'ws'}] -> ${result.roll1} + ${result.roll2}`);
  }

  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0);
  const p95 = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)]?.toFixed(0) ?? 0;
  console.log(`\navg send-confirm ${avg(tSends)}ms   avg to-callback ${avg(tCbs)}ms   p95 to-callback ${p95(tCbs)}ms`);
  console.log('Perceived UX floor for an on-chain roll: ~' + avg(tCbs) + 'ms');
}

main().catch(e => { console.error('bench failed:', e); process.exit(1); });