// api/dynamic-search.mjs
// Vercel serverless: queries Dynamic Management API for users by email.
// Dynamic is the source of truth (auth provider). No Supabase fallback.
// Requires DYNAMIC_API_TOKEN + DYNAMIC_ENV_ID in Vercel env vars.
// API docs: https://www.dynamic.xyz/docs/api-reference/users/get-all-users-for-an-environment

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email query param required' });

  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';

  console.log('[dynamic-search] env: token=' + (DYNAMIC_API_TOKEN ? DYNAMIC_API_TOKEN.slice(0, 8) + '...' : 'MISSING') + ' envId=' + (DYNAMIC_ENV_ID || 'MISSING'));

  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    return res.json({
      users: [],
      source: 'unconfigured',
      error: 'Dynamic API not configured. Add DYNAMIC_API_TOKEN and DYNAMIC_ENV_ID to Vercel env vars.',
    });
  }

  try {
    // Dynamic Management API v0: filter by email column
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
      return res.json({ users: [], source: 'dynamic', error: `Dynamic API ${resp.status}: ${body.slice(0, 200)}` });
    }
    const data = await resp.json();
    console.log('[dynamic-search] count:', data.count, 'users:', data.users?.length);

    const users = (data.users || []).map((u) => {
      // Wallet is in verifiedCredentials[].address where chain='SOL', or in wallets[].publicKey
      let wallet = null;
      let walletChain = null;
      if (u.verifiedCredentials && Array.isArray(u.verifiedCredentials)) {
        const solCred = u.verifiedCredentials.find(c => c.chain === 'SOL' || c.format === 'blockchain');
        if (solCred) {
          wallet = solCred.address;
          walletChain = solCred.chain || 'SOL';
        }
      }
      if (!wallet && u.wallets && Array.isArray(u.wallets)) {
        const solWallet = u.wallets.find(w => w.chain === 'SOL');
        if (solWallet) {
          wallet = solWallet.publicKey;
          walletChain = solWallet.chain;
        }
      }
      if (!wallet && u.walletPublicKey) {
        wallet = u.walletPublicKey;
      }
      return {
        id: u.id,
        email: u.email,
        wallet,
        walletChain,
        createdAt: u.createdAt || u.created_at,
        source: 'dynamic',
      };
    });
    return res.json({ users, source: 'dynamic' });
  } catch (e) {
    console.error('[dynamic-search] error:', e.message, e.cause || '');
    return res.json({ users: [], source: 'dynamic', error: e.message + (e.cause ? ' (' + e.cause + ')' : '') });
  }
}
