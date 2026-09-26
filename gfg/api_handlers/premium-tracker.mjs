// api/premium-tracker.mjs
// Vercel serverless: list all premium subscribers from on-chain PDAs.
// Staff-only via GFG_OPERATOR_TOKEN. Returns array of {player, premiumLifetime, premiumSpendable, subscriptionLevel, activeUntil, daysLeft, status, lastCredit, lastCreditRef}

import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import bs58 from 'bs58';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }
  let token = '';
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
      token = body.token || '';
    } else {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token') || '';
    }
  } catch (e) { /* ignore */ }
  const expected = process.env.GFG_OPERATOR_TOKEN;
  // FAIL-CLOSED (public release hardening): this is a staff-only dataset, so the
  // token is REQUIRED. A missing token is denied (previously it was allowed).
  if (!expected || expected.length < 16) {
    res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' });
    return;
  }
  if (!token || String(token) !== expected) {
    res.status(401).json({ error: 'unauthorized operator token' });
    return;
  }
  try {
    const { baseRpcUrl } = await import('../src/gfg-rpc.js');
    const idl = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
    const programId = new PublicKey(idl.address || idl.metadata?.address);
    const baseUrl = baseRpcUrl();
    const conn = new Connection(baseUrl, 'confirmed');
    // PremiumPoints discriminator from IDL
    const disc = Buffer.from([128,231,201,193,30,238,115,64]);
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }]
    });
    const now = Date.now();
    const list = accounts.map(({ pubkey, account }) => {
      const d = account.data;
      // decode like decodePremiumPointsRaw: 8 disc, 1 version, 32 admin, 8 lifetime, 8 spendable, 1 level, 8 until, 8 creditTs, 8 creditPoints, 8 creditRef
      if (d.length < 66) return null;
      const premiumLifetime = Number(d.readBigUInt64LE(41));
      const premiumSpendable = Number(d.readBigUInt64LE(49));
      const level = d[57];
      const activeUntilMs = Number(d.readBigInt64LE(58)) * 1000;
      const lastCreditPoints = d.length >= 82 ? Number(d.readBigUInt64LE(74)) : 0;
      const lastCreditRef = d.length >= 90 ? String(d.readBigUInt64LE(82)) : '0';
      const lastCreditTs = d.length >= 74 ? Number(d.readBigInt64LE(66)) * 1000 : 0;
      // Derive player wallet from PDA seeds: need to reverse? Instead we can store player as pubkey? For now, we return pda and try to derive player via seeds? Simpler: return pda and premium data, player will be fetched via Dynamic mapping on client if needed.
      // But we can attempt to get player by inspecting account? Not stored. So we return pda as identifier; client will treat pda as player PDA and need wallet. Alternative: we can brute force by using getProgramAccounts with seeds? The PDA is derived from [gfgprem, player], so we cannot reverse directly. So we instead return pda and let client resolve via known wallet lists or show pda.
      // For tracker, we want player wallet, not pda. We can try to find player by scanning known wallets from spend ledger? For now return pda and premium data; the wallet can be looked up via Dynamic email search separately.
      // To make tracker useful, we will also try to decode player from PDA's seeds via Anchor? Not possible without storing.
      // Workaround: we will return the premium PDA pubkey as `premiumPda`, and the client will use `fetchPremiumPointsPdaFor` for single search; bulk list will show PDA + subscription status.
      let daysLeft = 0;
      if (level > 0 && activeUntilMs > now) daysLeft = Math.ceil((activeUntilMs - now) / 86400000);
      let status = 'ended';
      if (level > 0 && daysLeft > 7 && daysLeft <= 23) status = 'mid';
      else if (level > 0 && daysLeft > 0 && daysLeft <= 7) status = 'ending';
      else if (level > 0 && daysLeft > 23) status = 'new';
      else if (level > 0 && daysLeft <= 0) status = 'ended';
      else status = 'ended';
      return {
        premiumPda: pubkey.toBase58(),
        premiumLifetime,
        premiumSpendable,
        subscriptionLevel: level,
        subscriptionActiveUntil: activeUntilMs,
        daysLeft,
        status,
        lastCreditPoints,
        lastCreditRef,
        lastCreditTs,
        version: d[8],
      };
    }).filter(Boolean);
    res.status(200).json({ count: list.length, subscribers: list });
  } catch (e) {
    console.error('premium-tracker error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
