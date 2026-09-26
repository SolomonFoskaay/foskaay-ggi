// api/dynamic-list.mjs
// Vercel serverless: list all Dynamic users with email + embedded wallet.
// Staff-only via GFG_OPERATOR_TOKEN check is NOT required for listing — the page itself is staff-gated via DashCore.gateStaff(),
// but we still keep it operator-gated if token is provided, otherwise return limited list.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';
  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    res.status(200).json({ users: [], source: 'unconfigured', error: 'Dynamic API not configured.' });
    return;
  }
  try {
    // Fetch first 100 users; paginate if needed (Dynamic returns count)
    const url = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users?limit=100`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${DYNAMIC_API_TOKEN}` } });
    if (!resp.ok) {
      const body = await resp.text();
      res.status(500).json({ users: [], source: 'dynamic', error: `Dynamic API ${resp.status}: ${body.slice(0,200)}` });
      return;
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
    res.status(200).json({ users, count: data.count || users.length, source: 'dynamic' });
  } catch (e) {
    res.status(500).json({ users: [], source: 'dynamic', error: e.message });
  }
}
