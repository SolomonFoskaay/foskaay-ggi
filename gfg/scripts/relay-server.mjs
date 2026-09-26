// scripts/relay-server.mjs
// Local dev relay: `npm run relay` -> http://localhost:8787
//   POST /api/delegate   app-sponsored initialize + delegate for gfg-dice
//   POST /api/roll       server-side house VRF roll for computer turns
//   POST /api/comp       S2 competition lifecycle (create/fund/close/settle)
//   POST /api/comp/claim winner claims their allocation (gasless ER)
//   GET  /api/comp       current competition state
//   GET  /api/endpoints  admin dashboard health probe (see endpoints-probe.mjs)
//   GET  /api/dynamic-search?email=... user lookup via Dynamic API (or Supabase fallback)
//   POST /api/backfill-global  backfill orphaned M3 points into M4 (auto-reads gap from chain)
// The Vite dev server proxies /api to this port (see vite.config.js).

import { createServer } from 'http';
import { Keypair } from '@solana/web3.js';
import { handleDelegate, handleMigratePoints, handleCreditPremium, handleCancelPremium, handleAdminActivatePremium } from './delegate-relay.mjs';
import { runProbe } from './endpoints-probe.mjs';
import { handleHouseRoll } from './roll-relay.mjs';
import { createComp, fundComp, closeComp, settleComp, claimComp, fetchCompState } from './comp-relay.mjs';
import { pickErRpcUrl } from '../src/gfg-rpc.js';
import { sourceCodeFor } from './point-sources.mjs';
import {
  handleRecordAffiliatePeriod, handleAffiliatePayout,
  settleAffiliatePeriod, readAffiliateLedger, handleSignupFlow, listAffiliateAccounts,
} from './affiliate-relay.mjs';
import { getHandleForWallet } from './handle.mjs';
import { isSignupClaimed } from './affiliate-relay.mjs';
import { ensureTally, createCompetition, closeCompetition, cancelCompetition, settleCompetition,
  recordCompetitionWinner, markWinnerPaid, getCompetition, listCompetitions, getWinners, getBoard, recordWin,
} from './competitions-relay.mjs';
import { addWin, addEntry, hasEntry } from './competitions-wins.mjs';
import { PLAN_LADDER, AFFILIATE_RATE } from './plans-config.mjs';
import { verifyAndCredit as verifyAndCreditVerifier } from '../api_handlers/verify-and-credit.mjs';
import arcRelay from '../api_handlers/arc-relay.mjs';
import ggiSponsor from '../api_handlers/foskaay-ggi-sponsor.mjs';
import './load-env.mjs';

const PORT = process.env.RELAY_PORT || 8787;

async function handleDynamicSearch(email) {
  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';

  console.log('[dynamic-search] env check: token=' + (DYNAMIC_API_TOKEN ? 'set (' + DYNAMIC_API_TOKEN.slice(0, 8) + '...)' : 'MISSING') + ' envId=' + (DYNAMIC_ENV_ID || 'MISSING'));

  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    return {
      users: [],
      source: 'unconfigured',
      error: 'Dynamic API not configured. Add DYNAMIC_API_TOKEN and DYNAMIC_ENV_ID to env. Or enter a wallet address directly.',
    };
  }

  try {
    const filter = JSON.stringify({ filterColumn: 'email', filterValue: email });
    const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users?filter=${encodeURIComponent(filter)}&limit=5`;
    console.log('[dynamic-search] GET', url);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` },
    });
    console.log('[dynamic-search] response:', resp.status, resp.statusText);
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[dynamic-search] API error:', resp.status, body.slice(0, 300));
      return { users: [], source: 'dynamic', error: `Dynamic API ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    console.log('[dynamic-search] count:', data.count, 'users:', data.users?.length);
    const users = (data.users || []).map((u) => {
      let wallet = null;
      let walletChain = null;
      if (u.verifiedCredentials && Array.isArray(u.verifiedCredentials)) {
        const solCred = u.verifiedCredentials.find(c => c.chain === 'SOL' || c.format === 'blockchain');
        if (solCred) { wallet = solCred.address; walletChain = solCred.chain || 'SOL'; }
      }
      if (!wallet && u.wallets && Array.isArray(u.wallets)) {
        const solWallet = u.wallets.find(w => w.chain === 'SOL');
        if (solWallet) { wallet = solWallet.publicKey; walletChain = solWallet.chain; }
      }
      if (!wallet && u.walletPublicKey) wallet = u.walletPublicKey;
      return { id: u.id, email: u.email, wallet, walletChain, createdAt: u.createdAt || u.created_at, source: 'dynamic' };
    });
    return { users, source: 'dynamic' };
  } catch (e) {
    console.error('[dynamic-search] error:', e.message, e.cause || '');
    return { users: [], source: 'dynamic', error: e.message + (e.cause ? ' (' + e.cause + ')' : '') };
  }
}

async function handleBackfillGlobal({ wallet, sourceTag, matchRef }) {
  const { Connection: Conn3, PublicKey: PubKey3 } = await import('@solana/web3.js');
  const { AnchorProvider: AP3, Program: Prog3 } = await import('@anchor-lang/core');
  const { BN: BN3 } = await import('bn.js');
  const { loadSponsor: loadS, mkWallet: mkW } = await import('./delegate-relay.mjs');
  const { sendMagicTx: sendTx } = await import('../src/gfg-rpc.js');
  const { readFileSync: rfs } = await import('fs');

  if (!wallet || !sourceTag || !matchRef) throw new Error('missing wallet/sourceTag/matchRef');

  // Convert the tag -> on-chain source_code exactly like the live M4 path
  // (source of truth is the M3 game tag; never let a caller input a source
  // code the live path would bank differently). Unknown tag -> refuse.
  const sourceCode = sourceCodeFor(sourceTag);
  if (sourceCode === 0) throw new Error('invalid sourceTag (no source_code for: ' + sourceTag + ')');

  const idl2 = JSON.parse(rfs(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
  const programId2 = new PubKey3(idl2.address || idl2.metadata?.address);
  const playerPub2 = new PubKey3(wallet);
  const POINTS_SEED2 = Buffer.from('gfgpoints', 'utf8');
  const GLOBAL_SEED2 = Buffer.from('global', 'utf8');
  const ER_URL2 = pickErRpcUrl();
  const erConn2 = new Conn3(ER_URL2, 'confirmed');

  // Re-derive gap from chain
  const m3Pda2 = PubKey3.findProgramAddressSync(
    [POINTS_SEED2, Buffer.from(sourceTag, 'utf8'), playerPub2.toBytes()], programId2,
  )[0];
  let m3Info2 = await erConn2.getAccountInfo(m3Pda2).catch(() => null);
  if (!m3Info2) {
    const baseConn2 = new Conn3('https://api.devnet.solana.com', 'confirmed');
    m3Info2 = await baseConn2.getAccountInfo(m3Pda2);
  }
  if (!m3Info2) throw new Error('No M3 points found for this game');
  const m3Pure2 = Number(m3Info2.data.readBigUInt64LE(8));

  const m4Pda2 = PubKey3.findProgramAddressSync(
    [POINTS_SEED2, GLOBAL_SEED2, playerPub2.toBytes()], programId2,
  )[0];
  let m4Info2 = await erConn2.getAccountInfo(m4Pda2).catch(() => null);
  if (!m4Info2) {
    const baseConn2b = new Conn3('https://api.devnet.solana.com', 'confirmed');
    m4Info2 = await baseConn2b.getAccountInfo(m4Pda2);
  }
  const m4Pure2 = m4Info2 ? Number(m4Info2.data.readBigUInt64LE(8)) : 0;
  const gap2 = m3Pure2 - m4Pure2;
  if (gap2 <= 0) return { ok: false, error: 'No orphaned points (M3=' + m3Pure2 + ', M4=' + m4Pure2 + ')' };

  // Execute backfill
  const sponsor2 = loadS();
  const provider2 = new AP3(erConn2, mkW(sponsor2), { commitment: 'confirmed', skipPreflight: true });
  const program2 = new Prog3(idl2, provider2);
  const tx2 = await program2.methods.recordGlobalPoints(
    0, sourceCode, new BN3(gap2), 1, new BN3(Date.now()),
  ).accounts({
    payer: sponsor2.publicKey, playerAuthority: playerPub2, globalPoints: m4Pda2,
  }).transaction();
  tx2.feePayer = sponsor2.publicKey;
  const sig2 = await sendTx(erConn2, tx2, [sponsor2], { skipPreflight: true });
  await erConn2.confirmTransaction({ signature: sig2 }, 'confirmed');
  return { ok: true, signature: sig2, gap: gap2, m3Pure: m3Pure2, m4PureBefore: m4Pure2 };
}

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/api/endpoints') {
    try {
      const result = await runProbe();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('endpoints probe error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/comp') {
    try {
      const { compPda, compPda: _c } = await import('./comp-relay.mjs').then(async m => {
        const { loadSponsor } = await import('./delegate-relay.mjs');
        const sponsor = loadSponsor();
        return { compPda: m.compPda(sponsor.publicKey.toBase58()).toString() };
      });
      const state = await fetchCompState(compPda);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ compPda, state }));
    } catch (e) {
      console.error('comp state error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/roll') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleHouseRoll();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('roll error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/delegate') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, gameTag } = JSON.parse(body || '{}');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleDelegate(player, gameTag);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('relay error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/migrate-points') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, gameTag } = JSON.parse(body || '{}');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleMigratePoints(player, gameTag);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('migrate error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/credit-premium') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, points, creditRef, token } = JSON.parse(body || '{}');
      const expected = process.env.GFG_OPERATOR_TOKEN;
      // FAIL-CLOSED: token required; missing is denied (public release hardening).
      if (!expected || expected.length < 16) throw new Error('server misconfigured: GFG_OPERATOR_TOKEN is not set');
      if (!token || String(token) !== expected) throw new Error('unauthorized operator token');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleCreditPremium(player, points, creditRef);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('credit-premium error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/cancel-premium') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, token } = JSON.parse(body || '{}');
      const expected = process.env.GFG_OPERATOR_TOKEN;
      if (!expected || expected.length < 16) throw new Error('server misconfigured: GFG_OPERATOR_TOKEN is not set');
      if (!token || String(token) !== expected) throw new Error('unauthorized operator token');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleCancelPremium(player);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('cancel-premium error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/activate-premium') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { player, token, level } = JSON.parse(body || '{}');
      const expected = process.env.GFG_OPERATOR_TOKEN;
      if (!expected || expected.length < 16) throw new Error('server misconfigured: GFG_OPERATOR_TOKEN is not set');
      if (!token || String(token) !== expected) throw new Error('unauthorized operator token');
      if (!player) throw new Error('missing "player" pubkey');
      const result = await handleAdminActivatePremium(player, level);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('activate-premium error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/verify-and-credit') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { owner, plan, txSignature, token } = JSON.parse(body || '{}');
      const result = await verifyAndCreditVerifier({ owner, plan, txSignature, token });
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('verify-and-credit error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/arc') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reqShim = { method: 'POST', body, headers: req.headers || {} };
    let statusCode = 200, sent = false;
    const resShim = {
      setHeader() {},
      status(c) { statusCode = c; return this; },
      json(obj) { sent = true; res.writeHead(statusCode, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); },
      end() { if (!sent) { res.writeHead(statusCode, cors); res.end(); } },
    };
    try { await arcRelay(reqShim, resShim); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/foskaay-ggi-sponsor') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reqShim = { method: 'POST', body, headers: req.headers || {} };
    let statusCode = 200, sent = false;
    const resShim = {
      setHeader() {},
      status(c) { statusCode = c; return this; },
      json(obj) { sent = true; res.writeHead(statusCode, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); },
      end() { if (!sent) { res.writeHead(statusCode, cors); res.end(); } },
    };
    try { await ggiSponsor(reqShim, resShim); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/comp') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { action, amount, entryFee, endsAt, winners, amounts } = JSON.parse(body || '{}');
      let result;
      if (action === 'create') result = await createComp({ entryFee: entryFee || 0, endsAt });
      else if (action === 'fund') result = await fundComp(Number(amount));
      else if (action === 'close') result = await closeComp();
      else if (action === 'settle') result = await settleComp(winners, amounts);
      else throw new Error('unknown action (create|fund|close|settle)');
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('comp error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/affiliate/list') {
    try {
      const list = await listAffiliateAccounts();
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ count: list.length, affiliates: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/affiliate')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const wallet = (url.searchParams.get('wallet') || '').trim();
      if (!wallet) throw new Error('wallet query param required');
      const ledger = await readAffiliateLedger(wallet);
      const handle = getHandleForWallet(wallet) || null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify({ wallet, handle, signupClaimed: isSignupClaimed(wallet), ...(ledger || {}) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/affiliate/record') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleRecordAffiliatePeriod(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/affiliate/pay') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleAffiliatePayout(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/affiliate/settle') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await settleAffiliatePeriod(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/signup') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body || '{}');
      if (!b.wallet) throw new Error('missing wallet');
      const result = await handleSignupFlow({ wallet: b.wallet, handle: b.handle, refHandle: b.refHandle });
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      // A repeat claim of the lifetime 500P bonus is a clean "already claimed",
      // never an error: tell the client so it can disable the button for good.
      if (isSignupClaimed(b.wallet)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true, signupClaimed: true, alreadyClaimed: true }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/comp/claim') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { compPda, winnerIndex, winnerSecret } = JSON.parse(body || '{}');
      if (!compPda || winnerIndex == null || !winnerSecret) throw new Error('missing compPda/winnerIndex/winnerSecret');
      const winnerKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(winnerSecret)));
      const result = await claimComp(compPda, Number(winnerIndex), winnerKeypair);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('comp claim error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/competitions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body || '{}');
      const base = { creator: b.creator || null };
      let result;
      switch (b.action) {
        case 'ensure':
          result = await ensureTally({ creator: base.creator, seq: Number(b.seq), wallet: b.wallet });
          break;
        case 'record':
          result = await recordWin({ creator: base.creator, seq: Number(b.seq), ts: Number(b.ts), game: Number(b.game), wallet: b.wallet });
          break;
        case 'win':
          result = { recorded: addWin({ compCreator: base.creator, seq: Number(b.seq), wallet: b.wallet, ts: Number(b.ts), proofSig: b.proofSig, game: b.game }) };
          break;
        case 'enter':
          if (hasEntry({ compCreator: base.creator, seq: Number(b.seq), wallet: b.wallet })) { result = { entered: false, already: true }; break; }
          addEntry({ compCreator: base.creator, seq: Number(b.seq), wallet: b.wallet });
          result = { entered: true };
          break;
        case 'create':
          result = await createCompetition({ ...base, seq: Number(b.seq), name: b.name, games: b.games, tierBits: Number(b.tierBits), requireAll: b.requireAll != null ? Number(b.requireAll) : 0, entryCost: Number(b.entryCost), entryFamilies: Number(b.entryFamilies), startsAt: Number(b.startsAt), endsAt: Number(b.endsAt), poolUsdCents: Number(b.poolUsdCents), poolPoints: Number(b.poolPoints), winnerCount: Number(b.winnerCount), prizeShares: (b.prizeShares || []).map(Number), redemption: b.redemption != null ? Number(b.redemption) : 0, payoutMode: b.payoutMode != null ? Number(b.payoutMode) : 0, desc: b.desc || '', redLabel: b.redLabel || '', redAmount: Number(b.redAmount) || 0, pool: Number(b.pool) || 0 });
          break;
        case 'close': result = await closeCompetition({ ...base, seq: Number(b.seq) }); break;
        case 'cancel': result = await cancelCompetition({ ...base, seq: Number(b.seq) }); break;
        case 'settle': result = await settleCompetition({ ...base, seq: Number(b.seq) }); break;
        case 'recordWinner': result = await recordCompetitionWinner({ ...base, seq: Number(b.seq), rank: Number(b.rank), player: b.player }); break;
        case 'markPaid': result = await markWinnerPaid({ ...base, seq: Number(b.seq), rank: Number(b.rank) }); break;
        default: throw new Error('unknown action: ' + b.action);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('competitions error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/competitions')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const creator = (url.searchParams.get('creator') || '').trim() || null;
      const seq = url.searchParams.get('seq');
      const winners = url.searchParams.get('winners') === '1';
      if (seq) {
        const comp = await getCompetition({ creator, seq: Number(seq) });
        if (!comp) { res.writeHead(404, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ error: 'competition not found' })); return; }
        if (url.searchParams.get('board') === '1') {
          const board = await getBoard({ creator, seq: Number(seq) });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
          res.end(JSON.stringify(board));
          return;
        }
        const w = winners ? await getWinners({ creator, seq: Number(seq) }) : undefined;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
        res.end(JSON.stringify({ competition: w ? { ...comp, winners: w } : comp }));
        return;
      }
      const list = await listCompetitions({ creator: creator || undefined });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify({ count: list.length, competitions: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/community-stats') {
    try {
      const { deriveProfileHandle } = await import('./../scripts/handle.mjs');
      const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
      const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';
      const out = { count: 0 };
      if (DYNAMIC_API_TOKEN && DYNAMIC_ENV_ID) {
        const base = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users`;
        let data = null;
        for (const url of [`${base}?limit=1&ordering=-created_at`, `${base}?limit=5`]) {
          try {
            const resp = await fetch(url, { headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` } });
            if (resp.ok) { data = await resp.json(); break; }
          } catch (e) { /* try next */ }
        }
        if (data) {
          if (typeof data.count === 'number') out.count = data.count;
          const first = (data.users || [])[0];
          if (first && first.id) {
            out.latest = (deriveProfileHandle && deriveProfileHandle(first.id)) || null;
            const created = first.createdAt || first.created_at;
            if (created) { out.joinedAt = created; out.joinedMinutesAgo = Math.max(0, Math.round((Date.now() - new Date(created).getTime()) / 60000)); }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...cors });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ count: 0 }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/pay-config') {
    try {
      const { publicPayConfig } = await import('./pay-config.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...cors });
      res.end(JSON.stringify(publicPayConfig()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/plans') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...cors });
      res.end(JSON.stringify({ plans: PLAN_LADDER, affiliateRate: AFFILIATE_RATE, basePointsPerUsdCent: 5 }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/dynamic-search')) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      if (!email) throw new Error('email query param required');
      const result = await handleDynamicSearch(email);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('dynamic-search error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/dynamic-list') {
    try {
      const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
      const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';
      if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ users: [], source: 'unconfigured', error: 'Dynamic API not configured.' }));
        return;
      }
      const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users?limit=100`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` } });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Dynamic API ${resp.status}: ${body.slice(0,200)}`);
      }
      const data = await resp.json();
      const users = (data.users || []).map((u) => {
        let wallet = null;
        if (u.verifiedCredentials && Array.isArray(u.verifiedCredentials)) {
          const solCred = u.verifiedCredentials.find(c => c.chain === 'SOL' || c.format === 'blockchain');
          if (solCred) wallet = solCred.address;
        }
        if (!wallet && u.wallets && Array.isArray(u.wallets)) {
          const solWallet = u.wallets.find(w => w.chain === 'SOL');
          if (solWallet) wallet = solWallet.publicKey;
        }
        if (!wallet && u.walletPublicKey) wallet = u.walletPublicKey;
        return { id: u.id, email: u.email || '', wallet: wallet || '', createdAt: u.createdAt || u.created_at || '' };
      }).filter(u => u.email || u.wallet);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify({ users, count: data.count || users.length, source: 'dynamic' }));
    } catch (e) {
      console.error('dynamic-list error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ users: [], source: 'dynamic', error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/backfill-global') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handleBackfillGlobal(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('backfill-global error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // Arc2 AGM lobby route (delegates to the shared handler module; body passed
  // through as an object so the handler's own JSON parse sees a string).
  if (req.method === 'POST' && req.url === '/api/multiplayer') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { action, game, matchRef, seats, stakeUsdCents, turnSecs, maxMatchSecs, seat, winnerSeat, moveCommit, regionUrl, code, handle, host } = JSON.parse(body || '{}');
      const { dispatch } = await import('./multiplayer-relay.mjs');
      const r = await dispatch(action, { game, matchRef, seats, stakeUsdCents, turnSecs, maxMatchSecs, seat, winnerSeat, moveCommit, regionUrl, code, handle, host });
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // Chess relay (M1A Chess): create + delegate the board, house AI, state read.
  if ((req.method === 'POST' || req.method === 'GET') && req.url.split('?')[0] === '/api/chess') {
    let params = {};
    try {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        params = JSON.parse(body || '{}');
      } else {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        params = {
          action: url.searchParams.get('action'),
          matchRef: Number(url.searchParams.get('matchRef')),
          host: url.searchParams.get('host'),
          timeMs: Number(url.searchParams.get('timeMs') || 0) || 0,
          incrementMs: Number(url.searchParams.get('incrementMs') || 0) || 0,
          level: Number(url.searchParams.get('level') || 1) || 1,
        };
      }
      const { dispatch } = await import('./chess-relay.mjs');
      const r = await dispatch(params.action, params);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/multiplayer') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const action = (url.searchParams.get('action') || '').toString();
      const { dispatch } = await import('./multiplayer-relay.mjs');
      const r = await dispatch(action, {
        game: Number(url.searchParams.get('game')), matchRef: Number(url.searchParams.get('matchRef') || url.searchParams.get('match_ref')),
        seats: Number(url.searchParams.get('seats')), seat: Number(url.searchParams.get('seat')),
        winnerSeat: Number(url.searchParams.get('winnerSeat')), moveCommit: url.searchParams.get('moveCommit'),
        regionUrl: url.searchParams.get('regionUrl'), stakeUsdCents: Number(url.searchParams.get('stakeUsdCents') || 0) || 0,
        turnSecs: Number(url.searchParams.get('turnSecs') || 0) || 0, maxMatchSecs: Number(url.searchParams.get('maxMatchSecs') || 3600) || 3600,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.url === '/api/agm' || (req.url || '').startsWith('/api/agm/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { default: agmHandler } = await import('../api_handlers/agm.mjs');
      const captured = { status: 200, json: null };
      const fakeRes = {
        setHeader: () => {},
        status: (c) => { captured.status = c; return { json: (o) => { captured.json = o; } }; },
        json: (o) => { captured.json = o; },
      };
      const fakeReq = { method: req.method, url: req.url, [Symbol.asyncIterator]: () => (function* () { yield body; })() };
      await agmHandler(fakeReq, fakeRes);
      res.writeHead(captured.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify(captured.json));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] sponsor relay listening on http://localhost:${PORT}`));

// A port conflict (EADDRINUSE, e.g. a stale relay from an earlier dev exit)
// must not become an unhandled 'error' that crashes Node with a stack dump.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[relay] port ${PORT} already in use (stale relay? kill it and rerun).`);
  } else {
    console.error(`[relay] server error:`, err.message);
  }
});
