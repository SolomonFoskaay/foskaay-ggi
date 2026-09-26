// src/main-lab.js
// Ludo-lab entry (the architecture build). Same boot as src/main.js — both use
// the ER-named SDK (src/magicblock-er-vrf.js). The legacy pure-VRF module
// (src/magicblock-vrf.js) was removed with /ludo; ER VRF is the ONLY path.

// ===== Developer console safety warning (site-wide) =====
// Shown once when a player opens the developer tools, like Dynamic's own
// warning. Protects casual users (and deters cheaters) from pasting code or
// sharing login codes.
(function showConsoleWarning() {
  try {
    const title = '%c⚠ GlobalFolkGames, developer tools warning';
    const body = '%c\nThis browser feature is meant for developers and builders.\n\nIf someone told you to open this, paste code here, or share a code or password, STOP. That is a scam.\n\nPasting unknown code or tampering with this page can make your account unusable and is recorded. Play fair, your wins are provable on-chain anyway.';
    const titleStyle = 'color:#ffffff; background:#e74c3c; font-size:16px; font-weight:bold; padding:8px 12px; border-radius:6px 6px 0 0;';
    const bodyStyle = 'color:#ffd2c0; background:#7d1010; font-size:13px; padding:10px 12px; border-radius:0 0 6px 6px;';
    console.log(title, titleStyle, body, bodyStyle);
  } catch (e) { /* console may be unavailable */ }
})();

import './dynamic-auth.js';
import './magicblock-er-vrf.js';
import { initMagicBlockDice } from './magicblock-er-vrf.js';
import { GFG_DICE } from './gfg-dice-config.js';
import { loadAdapter, CHAIN } from './chain/adapter.js';

// Chain switch (arcv2m16): svm = Solana as today, evm = the Arc rail. Default
// is svm, so the live flow is untouched. Games read window.GFG_CHAIN through
// chain-gateway.js.
window.GFG_CHAIN = CHAIN || 'svm';
loadAdapter().then(function (a) { window.gfgChainAdapter = a; }).catch(function (e) { console.warn('[chain] adapter load failed', e); });

// Expose the dice module on window (requires the Dynamic client to be ready).
initMagicBlockDice();

// Activate provably-fair dice only when the gfg-dice program is deployed.
// ARC (arcv2m17 audit): on the Arc rail the Solana ER VRF SDK must NEVER be
// configured. Leaving it inert guarantees no Solana RPC can be reached from
// this SDK on Arc; the Arc dice come from the committed seed via the relayer.
if (window.GFG_CHAIN === 'evm') {
  console.log('[chain] Arc rail active: MagicBlock ER VRF (Solana) left inert by design.');
  if (window.magicblockDice && typeof window.magicblockDice.configure === 'function') {
    window.magicblockDice.configure = function () {
      console.warn('[chain] blocked magicblockDice.configure() on the Arc rail (Solana SDK stays inert).');
      return null;
    };
    window.magicblockDice.__arcInert = true;
  }
} else if (GFG_DICE.programId && GFG_DICE.idl && window.magicblockDice) {
  window.magicblockDice.configure(GFG_DICE);
  console.log('[VRF] MagicBlock ER VRF dice configured:', GFG_DICE.programId);
} else {
  console.log('[VRF] gfg-dice not configured yet — Ludo will use local rolls');
}

console.log('Vite + Dynamic auth layer loaded (ludo-lab / ER VRF build)');
