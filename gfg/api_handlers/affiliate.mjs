// api/affiliate.mjs
// Vercel serverless: M6 affiliate ledger read + admin writes.
// GET  ?wallet=...              -> on-chain ledger for a wallet (profile read)
// POST {action:'record', ...}   -> relay-signed on-chain accrual (admin/settle)
// POST {action:'pay', ...}      -> relay-signed on-chain payout
// POST {action:'settle', ...}   -> compute + record a list of pairs
// Records are relay-signed and immutable; the operator token is only checked if
// supplied (the page is staff-gated), matching the other admin endpoints.

import {
  handleRecordAffiliatePeriod, handleAffiliatePayout,
  settleAffiliatePeriod, readAffiliateLedger, listAffiliateAccounts,
} from '../scripts/affiliate-relay.mjs';
import { getHandleForWallet } from '../scripts/handle.mjs';
import { isSignupClaimed } from '../scripts/affiliate-relay.mjs';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('list') === '1') {
        const list = await listAffiliateAccounts();
        res.status(200).json({ count: list.length, affiliates: list });
        return;
      }
      const wallet = (url.searchParams.get('wallet') || '').trim();
      if (!wallet) throw new Error('wallet query param required');
      const ledger = await readAffiliateLedger(wallet);
      res.status(200).json({ wallet, handle: getHandleForWallet(wallet) || null, signupClaimed: isSignupClaimed(wallet), ...(ledger || {}) });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'GET or POST only' });
      return;
    }
    const body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
    const expected = process.env.GFG_OPERATOR_TOKEN;
    // FAIL-CLOSED (public release hardening): admin writes (record/pay/settle)
    // require the operator token; a missing token is DENIED. (GET reads stay
    // public: they are on-chain ledger data, safe to read.)
    if (!expected || expected.length < 16) {
      res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' });
      return;
    }
    if (!body.token || String(body.token) !== expected) {
      res.status(401).json({ error: 'unauthorized operator token' });
      return;
    }
    if (body.action === 'record') {
      res.status(200).json(await handleRecordAffiliatePeriod(body));
    } else if (body.action === 'pay') {
      res.status(200).json(await handleAffiliatePayout(body));
    } else if (body.action === 'settle') {
      res.status(200).json(await settleAffiliatePeriod(body));
    } else {
      res.status(400).json({ error: 'unknown action (record|pay|settle)' });
    }
  } catch (e) {
    console.error('affiliate error:', e.message);
    res.status(500).json({ error: e.message });
  }
}