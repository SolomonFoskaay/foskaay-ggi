// scripts/roll-relay.mjs
// Server-side "house" dice rolls for the Ludo COMPUTER seats, on the
// MagicBlock Ephemeral Rollup VRF queue (gasless, fast).
//
// Why a server-side house key:
//   - Computer turns must be as provably fair as the human's, but a computer
//     has no wallet/session key to sign a transaction.
//   - The house key (the app-owned sponsor wallet) is sponsored once: its
//     dice PDA is initialize+delegate'd through the existing relay flow,
//     then every computer roll runs FREE on the ER VRF queue.
//   - The key never leaves the server, so players cannot roll for the house.
//
// Concurrency: the house dice account stores only its LAST roll. Shape all
// computer rolls through a simple promise queue so two game tabs never hit
// the same PDA at once and race each other's callback.
//
// Env: reuses GFG_Gasless_Sponsor_Keypair (or ~/.config/solana/id.json), exactly like
// the delegate relay. No new secrets.

import { readFileSync } from 'fs';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import './load-env.mjs';
import { createConnection, pickErRpcUrl, markErRpcSuccess, markErRpcFailure, getDelegationStatus, baseRpcUrl, regionUrlForFqdn } from '../src/gfg-rpc.js';
import { handleDelegate, loadSponsor } from './delegate-relay.mjs';

const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const PLAYER_SEED = Buffer.from('gfgplayerd');
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc'); // devnet ER VRF queue (free)
const ER_PICKUP_WAIT_MS = 10000;
const CALLBACK_WAIT_MS = 25000;

// True when an error means the ER endpoint itself is unhealthy (transport /
// rate-limit / gateway) — i.e. we should rotate to another region. Program
// revert errors and "not settled yet" are not RPC failures.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isErNetworkError = (e) => {
  if (!e || !e.message) return false;
  const m = String(e.message);
  if (/fetch failed|Failed to fetch|ECONN|ETIMEDOUT|ESOCKET|UND_ERR|socket hang up|network error|timeout|aborted|timed out|banned/i.test(m)) return true;
  if (/\b429\b|\b50[0-9]\b|\brate limit|too many requests|service unavailable|bad gateway/i.test(m)) return true;
  return false;
};

// Rotating seed so two consecutive rolls never reuse the same clientSeed
// (a repeated seed can confuse the VRF callback check).
let seedCounter = Math.floor(Math.random() * 200);

// Delegation is expensive to re-check on every roll (2-4 RPC round trips).
// Cache "delegated + picked up" state for a short TTL: warm rolls then go
// straight to the gasless ER roll. Any failure resets the cache. On Vercel
// the instance may be cold per invocation, so the cache mostly helps the
// local relay (and warm serverless instances).
const DELEGATION_TTL_MS = 4 * 60 * 1000;
let lastEnsuredAt = 0;
let lastRollSucceeded = false;

// Region that hosts the house dice PDA. THE fix for house roll timeouts: the
// account lives on exactly ONE region (the validator the relay pinned it to),
// so submit + poll must stay on that region. Rotation would confirm the tx yet
// the VRF callback lands on the hosting region, unseen by a poll elsewhere.
let cachedHostUrl = null;

async function houseRegionUrl(pda) {
  if (cachedHostUrl) return cachedHostUrl;
  try {
    const baseConn = new Connection(baseRpcUrl(), 'confirmed');
    const st = await getDelegationStatus(baseConn, pda);
    const url = st && st.isDelegated ? regionUrlForFqdn(st.fqdn) : null;
    if (url) {
      cachedHostUrl = url;
      console.log(`[house roll] house dice PDA hosted on region ${url} - submitting + polling there`);
    }
  } catch (e) {
    // Router unreachable: fall back to the coordinated rotation for this roll.
  }
  return cachedHostUrl || null;
}

// Single-flight queue: serializes all house rolls in this process.
let rollQueue = Promise.resolve();

// Public entry: queue + run one gasless ER VRF roll for the house.
export function handleHouseRoll() {
  const run = rollQueue.catch(() => {}).then(() => houseRollOnce());
  rollQueue = run.catch(() => {});
  return run;
}

async function houseRollOnce() {
  const sponsor = loadSponsor();
  const housePubkey = sponsor.publicKey;
  const [pda] = PublicKey.findProgramAddressSync([PLAYER_SEED, housePubkey.toBytes()], PROGRAM_ID);

  // 1) Ensure the house dice account exists and is delegated (idempotent;
  //    the sponsor pays the one-time init+delegate cost, ~0.0013 SOL).
  //    Skip the re-check when we recently succeeded (warm roll).
  const warm = Date.now() - lastEnsuredAt < DELEGATION_TTL_MS && lastRollSucceeded;
  if (!warm) await handleDelegate(housePubkey.toBase58());

  // Resolve the region that hosts the house dice PDA and lock every connection
  // to it (rotation only applies if the Router cannot report the account yet).
  const hostUrl = await houseRegionUrl(pda);

  // ER connection on the hosting region (or the current best region as a
  // fallback); reconnects to the same region when an endpoint errors.
  const makeConn = () => createConnection(hostUrl || pickErRpcUrl(), 'confirmed', 30000, { backoffMs: [400, 800, 1200, 1800, 2500] });
  let erConn = makeConn();
  let erUrl = erConn.rpcEndpoint.replace(/\/+$/, '/');

  // 2) Wait until the ER validator has picked the account up.
  if (!warm) {
    const pickupDeadline = Date.now() + ER_PICKUP_WAIT_MS;
    let pickedUp = false;
    while (Date.now() < pickupDeadline) {
      try {
        const info = await erConn.getAccountInfo(pda);
        if (info && info.owner.toBase58() === PROGRAM_ID.toBase58() && info.data.length > 0) {
          markErRpcSuccess(erUrl);
          pickedUp = true;
          break;
        }
      } catch (e) {
        if (isErNetworkError(e)) {
          // Host region down: reconnect to it (makeConn is host-locked) and
          // resume the pickup poll there.
          markErRpcFailure(erUrl);
          erConn = makeConn();
          erUrl = erConn.rpcEndpoint.replace(/\/+$/, '/');
        }
        // else ER not ready yet; keep polling.
      }
      await sleep(600);
    }
    if (!pickedUp) throw new Error('House dice account never picked up by the ER validator');
  }

  // 3) Gasless rollDice on the ER, signed by the house key. Retry once on a
  //    fresh connection to the SAME hosting region if its RPC errors mid-send.
  const walletAdapter = {
    publicKey: housePubkey,
    async signTransaction(t) { t.partialSign(sponsor); return t; },
    async signAllTransactions(ts) { ts.forEach(t => t.partialSign(sponsor)); return ts; },
  };
  const providerFor = (conn) => new AnchorProvider(conn, walletAdapter, { commitment: 'confirmed', skipPreflight: true });

  seedCounter = (seedCounter + 1) % 256;
  const clientSeed = seedCounter;

  let program = new Program(idl, providerFor(erConn));
  let signature = null;
  for (let attempt = 0; attempt < 2 && !signature; attempt++) {
    try {
      signature = await program.methods
        .rollDice(clientSeed)
        .accounts({
          player: pda,
          payer: housePubkey,
          playerAuthority: housePubkey,
          oracleQueue: ER_QUEUE,
        })
        .rpc();
      markErRpcSuccess(erUrl);
    } catch (e) {
      if (!isErNetworkError(e) || attempt === 1) throw e;
      markErRpcFailure(erUrl);
      erConn = makeConn();
      erUrl = erConn.rpcEndpoint.replace(/\/+$/, '/');
      program = new Program(idl, providerFor(erConn));
    }
  }

  // 4) Wait for the VRF oracle to callback into the program. Poll the hosting
  //    region; if it dies mid-wait, reconnect there and keep polling.
  const callbackDeadline = Date.now() + CALLBACK_WAIT_MS;
  while (Date.now() < callbackDeadline) {
    await sleep(750);
    try {
      const account = await program.account.playerDice.fetch(pda);
      if (account.lastClientSeed === clientSeed) {
        markErRpcSuccess(erUrl);
        lastEnsuredAt = Date.now();
        lastRollSucceeded = true;
        return {
          roll1: Number(account.lastRoll1),
          roll2: Number(account.lastRoll2),
          seed: clientSeed,
          signature,
          pda: pda.toString(),
        };
      }
    } catch (e) {
      if (isErNetworkError(e)) {
        markErRpcFailure(erUrl);
        erConn = makeConn();
        erUrl = erConn.rpcEndpoint.replace(/\/+$/, '/');
        program = new Program(idl, providerFor(erConn));
      }
      // else not settled yet; keep polling.
    }
  }

  lastRollSucceeded = false;
  throw new Error('House VRF roll timed out waiting for the callback');
}

// Allow running a house roll directly for debugging:
//   node scripts/roll-relay.mjs
if (process.argv[1] && process.argv[1].endsWith('roll-relay.mjs')) {
  handleHouseRoll()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}