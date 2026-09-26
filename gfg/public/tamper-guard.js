// public/tamper-guard.js
// Client tamper NOTICE pipeline (owner-requested).
// When the browser shows signs of local tampering (edited localStorage state,
// mocked/replaced key globals), we RECORD a notice to Supabase (user, kind,
// detail, date) and surface it on the staff dashboard.
//
// HONEST LIMITATION (do not overstate in copy): the client itself can always
// lie. A determined bad actor can delete or forge these notices, so this is a
// deterrent + audit trail for opportunistic tampering (DevTools edits,
// localStorage pokes, mocked globals), NOT a security boundary.

(function () {
  var SIG_PREFIX = '__gfgsig_';

  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h);
  }
  function checksum(key, value) { return djb2(key + '|' + String(value)); }
  function sigKey(k) { return SIG_PREFIX + k; }

  // ---- localStorage integrity: every gfg_* write gets a checksum sibling ----
  var installedStorage = false;
  function installStorageGuard() {
    if (installedStorage || !window.localStorage) return;
    installedStorage = true;

    var proto = window.Storage && window.Storage.prototype;
    if (!proto) return;

    var origSet = proto.setItem;
    proto.setItem = function (k, v) {
      origSet.call(this, k, v);
      try {
        if (typeof k === 'string' && k.indexOf('gfg_') === 0) {
          origSet.call(this, sigKey(k), checksum(k, v));
        }
      } catch (e) { /* ignore */ }
    };

    var origGet = proto.getItem;
    proto.getItem = function (k) {
      var v = origGet.call(this, k);
      try {
        if (typeof k === 'string' && k.indexOf('gfg_') === 0 && v != null) {
          var sig = origGet.call(this, sigKey(k));
          if (sig && sig !== checksum(k, v)) {
            // Value was edited behind our back.
            window.tamperGuardRecord && window.tamperGuardRecord('state_tamper', k);
          }
        }
      } catch (e) { /* ignore */ }
      return v;
    };
  }

  // ---- key-global redefinition check: mocked SDK / replaced Math.random ----
  function globalsIntact() {
    try {
      if (typeof Math.random !== 'function') return false;
      if (String(Math.random).indexOf('[native code]') === -1) return false;
      var w = window.getDynamicSolanaWallet;
      if (typeof w !== 'function') return false;
    } catch (e) { return true; }
    return true;
  }

  // ---- record a tamper notice ----
  function record(kind, detail) {
    try { console.warn('[tamper-guard] notice:', kind, detail); } catch (e) { /* ignore */ }

    var userId = null;
    var dynamicId = null;
    try {
      if (window.currentUser) userId = window.currentUser.id;
      if (window.currentProfile) dynamicId = window.currentProfile.dynamic_user_id || null;
    } catch (e) { /* ignore */ }

    var entry = {
      kind: String(kind),
      detail: String(detail),
      created_at: new Date().toISOString(),
      url: (window.location && window.location.href) || ''
    };
    try { window.gfgTamperLog = (window.gfgTamperLog || []).concat(entry); } catch (e) { /* ignore */ }

    if (!window.supabaseClient) return; // nothing to persist to
    // Reuse point_transactions (anon-writable, same RLS as point awards).
    // points = 0 so it cannot inflate rewards; game_id 'tamper' marks it.
    window.supabaseClient.from('point_transactions').insert({
      user_id: userId,
      game_id: 'tamper',
      points: 0,
      reason: 'TAMPER:' + kind,
      match_id: JSON.stringify(entry)
    }).then(function (r) {
      if (r && r.error) {
        console.warn('[tamper-guard] notice persist failed (RLS/network):', r.error.message);
      }
    }).catch(function (err) {
      console.warn('[tamper-guard] notice persist error:', err && err.message);
    });
  }

  function runCheck() {
    if (!globalsIntact()) {
      record('global_repacement', 'detected key global replaced or mocked');
    }
  }

  // ---- boot ----
  function boot() {
    try { installStorageGuard(); } catch (e) { /* ignore */ }
    // Check globals periodically + right away.
    setTimeout(runCheck, 800);
    setInterval(runCheck, 12000);

    window.tamperGuardRecord = record;
    window.tamperGuard = {
      record: record,
      runCheck: runCheck,
      checksum: checksum,
      getLog: function () { return window.gfgTamperLog || []; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();