// public/universal/identity/handle.js
// M6 — public identity HANDLE derivation (client mirror of scripts/handle.mjs).
// A display handle is derived deterministically from Dynamic's stable, unique
// user id (which never changes) — never from email or wallet. Format GFG-XXXXXX
// (Crockford base32 style, no ambiguity). Sync fnv-1a based so it works in every
// browser without crypto.subtle. The same derivation must match the server.
(function () {
  if (window.deriveProfileHandle) return;

  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Deterministic 6-char half of the derivation (shared with the server).
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

  // Full handle including the prefix and an optional collision-retry salt.
  window.deriveProfileHandle = function (dynamicId, salt) {
    if (!dynamicId) return null;
    salt = salt || '';
    const code = code6(String(dynamicId) + (salt ? ':' + salt : ''));
    return 'GFG-' + code;
  };

  // Validate a handle the server will accept.
  window.isValidProfileHandle = function (h) {
    return /^GFG-[0-9A-Z]{6}$/i.test(h || '');
  };
})();