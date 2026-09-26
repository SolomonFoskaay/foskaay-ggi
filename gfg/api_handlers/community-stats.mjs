// api/community-stats.mjs — public, safe "platform is growing" feed.
// Returns:
//   { count }        -> total registered players (Dynamic user count)
//   { latest }       -> the most recent signup's PUBLIC GFG handle only
//   { joinedMinutesAgo } -> when that person joined (for the notification)
//
// NO personal data is exposed: never email, never wallet, never the Dynamic id.
// The handle is the deterministic GFG-XXXXXX derived from the user id inside the
// same derivation as the rest of the site (scripts/handle.mjs mirror). Light,
// cached ~60s, one Dynamic API call. Fails soft (empty) if Dynamic is unset.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function code6(dynamicId) {
  const s = 'gfd:' + String(dynamicId);
  let h1 = fnv1a(s, 0x811c9dc5);
  let h2 = fnv1a(s, 0x01000193);
  const out = [];
  for (let i = 0; i < 6; i++) {
    h1 = Math.imul(h1, 2654435761) >>> 0;
    h1 = (h1 ^ h2) >>> 0;
    h2 = Math.imul(h2, 1597334677) >>> 0;
    out.push(B32[h1 % 32]);
  }
  return out.join('');
}
export function deriveProfileHandle(dynamicId, salt) {
  if (!dynamicId) return null;
  salt = salt || '';
  const code = code6(String(dynamicId) + (salt ? ':' + salt : ''));
  return 'GFG-' + code;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  const DYNAMIC_API_TOKEN = process.env.DYNAMIC_API_TOKEN || '';
  const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID || '';
  const out = { count: 0 };
  if (!DYNAMIC_API_TOKEN || !DYNAMIC_ENV_ID) {
    res.status(200).json(out);
    return;
  }
  try {
    const base = `https://app.dynamicauth.com/api/v0/environments/${DYNAMIC_ENV_ID}/users`;
    // Newest-first so the first item is the latest signup; count is the total.
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
        out.latest = deriveProfileHandle(first.id);
        const created = first.createdAt || first.created_at;
        if (created) out.joinedAt = created;
        if (created) out.joinedMinutesAgo = Math.max(0, Math.round((Date.now() - new Date(created).getTime()) / 60000));
      }
    }
  } catch (e) { /* soft fail -> only count */ }
  res.status(200).json(out);
}