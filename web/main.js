// src/main.js
// Site-wide bootstrap: Dynamic auth + the MagicBlock EPHEMERAL ROLLUP VRF SDK
// (src/magicblock-er-vrf.js). Games and sites use ONE SDK now — the legacy
// pure/VRF module (magicblock-vrf.js) was removed with the /ludo page; every
// dice roll is ER VRF (gasless free queue) by design.

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

// Chain switch (arcv2m16/17): svm = Solana as today, evm = the Arc rail.
// This MUST be set on EVERY page, not just ludo-lab: chain-gateway.js reads
// window.GFG_CHAIN to decide Arc vs Solana. Without this line the whole site
// except ludo-lab fell back to 'svm', so "isArc()"-guarded modules silently ran
// their Solana branch on an Arc build. Default stays 'svm' when unset.
window.GFG_CHAIN = CHAIN || 'svm';
loadAdapter().then(function (a) { window.gfgChainAdapter = a; }).catch(function (e) { console.warn('[chain] adapter load failed', e); });

// Expose the dice module on window (requires the Dynamic client to be ready).
initMagicBlockDice();

// Activate provably-fair dice only when the gfg-dice program is deployed.
// ARC (arcv2m17 audit): on the Arc rail the Solana ER VRF SDK must NEVER be
// configured. Configuring it on Arc was a latent Solana path; leaving it inert
// guarantees no RPC can ever be reached from this SDK on Arc. The Arc dice come
// from the committed seed via the relayer (window.gfgChain.roll).
if (window.GFG_CHAIN === 'evm') {
  console.log('[chain] Arc rail active: MagicBlock ER VRF (Solana) left inert by design.');
} else if (GFG_DICE.programId && GFG_DICE.idl && window.magicblockDice) {
  window.magicblockDice.configure(GFG_DICE);
  console.log('[VRF] MagicBlock ER VRF dice configured:', GFG_DICE.programId);
} else {
  console.log('[VRF] gfg-dice not configured yet — Ludo will use local rolls');
}

// A page that must not touch Solana still loads this module (many files check
// for window.magicblockDice existence), but configure() is the only thing that
// arms an RPC. Belt-and-braces: on Arc, refuse to arm it even if called again.
if (window.GFG_CHAIN === 'evm' && window.magicblockDice && typeof window.magicblockDice.configure === 'function') {
  const _origConfigure = window.magicblockDice.configure.bind(window.magicblockDice);
  window.magicblockDice.configure = function () {
    console.warn('[chain] blocked magicblockDice.configure() on the Arc rail (Solana SDK stays inert).');
    return null;
  };
  window.magicblockDice.__arcInert = true;
  void _origConfigure; // kept for reference; never invoked on Arc
}

console.log('Vite + Dynamic auth layer loaded (ER VRF SDK)');