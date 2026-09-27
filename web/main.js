// web/main.js — Foskaay GGI standalone bootstrap.
//
// Auth via Dynamic: email one-time code, then Dynamic auto-creates the embedded
// Solana AND EVM wallets (both, exactly as GFG did). Arc (EVM) is the rail, so
// there is NO Solana/MagicBlock game SDK here.
//
// Exposes the globals the header and pages use, plus an EVM session-key helper
// (the user's seat is signed by a client-held key, never by the sponsor).
import {
  createDynamicClient, sendEmailOTP, verifyOTP, logout, getWalletAccounts,
} from '@dynamic-labs-sdk/client';
import { generateSessionKeys, getSessionKeys, getSignedSessionId } from '@dynamic-labs-sdk/client/core';
import { addSolanaExtension } from '@dynamic-labs-sdk/solana';
import { addEvmExtension } from '@dynamic-labs-sdk/evm';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Non-secret Dynamic environment id, injected at build time from the
// DYNAMIC_ENV_ID env var (vite define). The API token is server-side only and is
// never sent to the browser.
const ENVIRONMENT_ID = (typeof __DYNAMIC_ENV_ID__ !== 'undefined' && __DYNAMIC_ENV_ID__)
  || '0fd49c9c-1b54-4dc5-88a0-924dd3607bf3';

let dynamicClient = null;
try {
  dynamicClient = createDynamicClient({
    environmentId: ENVIRONMENT_ID,
    metadata: { name: 'Foskaay GGI', universalLink: window.location.origin },
  });
  addSolanaExtension();
  addEvmExtension();
  window.dynamicClient = dynamicClient;
} catch (e) {
  console.error('Foskaay GGI: Dynamic client init failed:', e.message || e);
}
window.currentUser = null;
window.currentProfile = null;

function getSolanaWallet() {
  try {
    const a = getWalletAccounts(dynamicClient);
    const s = a.find(w => w.chain === 'SOL' && w.address);
    return s ? s.address : null;
  } catch (e) { return null; }
}
function getEvmWallet() {
  try {
    const a = getWalletAccounts(dynamicClient);
    const e = a.find(w => w.chain === 'EVM' && w.address);
    return e ? e.address : null;
  } catch (e) { return null; }
}
window.getDynamicSolanaWallet = getSolanaWallet;
window.getDynamicEvmWallet = getEvmWallet;

// The email survives a reload so the header initial (first letter before @)
// keeps working after refresh. The address is not sensitive; store it locally.
window.__ggiEmail = (function () { try { return localStorage.getItem('ggi_email') || null; } catch (e) { return null; } })();
window.getDynamicEmail = function () {
  return (window.currentUser && window.currentUser.email) || window.__ggiEmail || null;
};

// Dynamic restores the signed-in session in the background after a reload. We
// poll until the embedded wallets are exposed, then set the user and tell the
// header and the profile page to re-render (gfg:auth-changed). This is what kept
// the header "logged out" on every page and left the wallets empty.
async function restoreSession() {
  if (!dynamicClient) return;
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < 10000) {
    const evm = getEvmWallet();
    const sol = getSolanaWallet();
    if (evm || sol) {
      seen = true;
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (seen) {
    await ensureSessionKeys();
    if (!window.currentUser) {
      window.currentUser = { dynamicId: getEvmWallet() || getSolanaWallet() || null, email: window.__ggiEmail, evm: getEvmWallet(), solana: getSolanaWallet() };
    }
  }
  try { window.dispatchEvent(new CustomEvent('gfg:auth-changed')); } catch (e) {}
}

async function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function ensureSessionKeys() {
  try {
    if (!getSessionKeys(dynamicClient)) await generateSessionKeys(dynamicClient);
    return getSessionKeys(dynamicClient) || null;
  } catch (e) { return null; }
}
window.getDynamicSessionKeys = function () {
  try { return getSessionKeys(dynamicClient) || null; } catch (e) { return null; }
};
window.verifyDynamicSession = async function () {
  try { return await getSignedSessionId(dynamicClient); } catch (e) { return null; }
};

// ---- EVM session key (the user seat's signer, no wallet popup) --------------
// The relay records this address as the user seat's session key at connect; the
// client signs the final settle hash with it. The private key never leaves the
// browser.
window.ggiSessionKey = null;
window.ggiCreateSessionKey = function () {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  window.ggiSessionKey = { privateKey, address: account.address, account };
  return window.ggiSessionKey;
};
window.ggiSignDigest = async function (digest) {
  if (!window.ggiSessionKey) window.ggiCreateSessionKey();
  return window.ggiSessionKey.account.sign({ hash: digest });
};

// ---- minimal email OTP modal (self-contained, no page markup needed) -------
let otpVerification = null;
let pendingEmail = null;

function ensureModal() {
  let m = document.getElementById('ggi-auth-modal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'ggi-auth-modal';
  m.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:10000;';
  m.innerHTML = '<div id="ggi-auth-box" style="background:#151515;border:1px solid #333;border-radius:14px;padding:22px;width:min(92vw,360px);color:#eee;font-family:inherit;"></div>';
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
  return m;
}
function openModal() { ensureModal().style.display = 'flex'; }
function closeModal() { const m = document.getElementById('ggi-auth-modal'); if (m) m.style.display = 'none'; otpVerification = null; }
function box() {
  // Ensure the modal exists before anything reads/writes it. This was the bug:
  // openDynamicLogin ran emailStep() (which uses box()) before openModal()
  // created the modal, so box() was null and the click did nothing.
  ensureModal();
  return document.getElementById('ggi-auth-box');
}

function emailStep() {
  box().innerHTML = '<h2 style="margin:0 0 6px;color:#f39c12">Sign in</h2>'
    + '<p style="margin:0 0 12px;font-size:.9rem;color:#bbb">Enter your email. We will send a one-time code.</p>'
    + '<input id="ggi-email" type="email" placeholder="Email address" style="width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#0e0e0e;color:#fff;box-sizing:border-box">'
    + '<button id="ggi-send" style="margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#f39c12;color:#111;font-weight:700;cursor:pointer">Send Code</button>';
  document.getElementById('ggi-send').onclick = sendOtp;
}
function otpStep(email) {
  box().innerHTML = '<h2 style="margin:0 0 6px;color:#f39c12">Enter Code</h2>'
    + '<p style="margin:0 0 12px;font-size:.9rem;color:#bbb">We sent a code to <b>' + email + '</b></p>'
    + '<input id="ggi-otp" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#0e0e0e;color:#fff;box-sizing:border-box">'
    + '<button id="ggi-verify" style="margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#f39c12;color:#111;font-weight:700;cursor:pointer">Verify and Sign In</button>'
    + '<button id="ggi-back" style="margin-top:8px;width:100%;padding:9px;border:1px solid #444;border-radius:8px;background:transparent;color:#ddd;cursor:pointer">Back</button>';
  document.getElementById('ggi-verify').onclick = verifyOtp;
  document.getElementById('ggi-back').onclick = emailStep;
}
async function sendOtp() {
  if (!dynamicClient) { banner('Sign in is not configured yet. Set DYNAMIC_ENV_ID and allow this domain in Dynamic.'); return; }
  const email = (document.getElementById('ggi-email').value || '').trim();
  if (!email) { banner('Please enter your email'); return; }
  pendingEmail = email;
  const b = document.getElementById('ggi-send'); b.disabled = true; b.textContent = 'Sending...';
  try { otpVerification = await sendEmailOTP({ email }); otpStep(email); }
  catch (e) { banner(e.message || 'Failed to send code'); b.disabled = false; b.textContent = 'Send Code'; }
}
async function verifyOtp() {
  const code = (document.getElementById('ggi-otp').value || '').trim();
  if (!code) { banner('Please enter the code'); return; }
  const b = document.getElementById('ggi-verify'); b.disabled = true; b.textContent = 'Verifying...';
  try {
    await verifyOTP({ otpVerification: otpVerification, verificationToken: code });
    try {
      const missing = getChainsMissingWaasWalletAccounts();
      if (missing && missing.length) await createWaasWalletAccounts({ chains: missing });
    } catch (e) { /* wallet may already exist */ }
    try { if (!getSolanaWallet()) await createWaasWalletAccounts({ chains: ['SOL'] }); } catch (e) {}
    try { if (!getEvmWallet()) await createWaasWalletAccounts({ chains: ['EVM'] }); } catch (e) {}
    await waitFor(getSolanaWallet);
    const evm = await waitFor(getEvmWallet);
    await ensureSessionKeys();
    window.currentUser = { dynamicId: evm || getSolanaWallet() || 'user', email: pendingEmail, evm, solana: getSolanaWallet() };
    try { localStorage.setItem('ggi_email', pendingEmail); } catch (e) {}
    window.__ggiEmail = pendingEmail;
    closeModal();
    banner('Signed in');
    if (typeof window.refreshAuthHeader === 'function') await window.refreshAuthHeader();
    try { window.dispatchEvent(new CustomEvent('gfg:auth-changed')); } catch (e) {}
  } catch (e) {
    banner(e.message || 'Invalid code'); b.disabled = false; b.textContent = 'Verify and Sign In';
  }
}

window.openDynamicLogin = function () { ensureModal(); openModal(); emailStep(); };
window.logoutDynamic = async function () {
  try { await logout(); } catch (e) {}
  window.currentUser = null;
  window.__ggiEmail = null;
  try { localStorage.removeItem('ggi_email'); } catch (e) {}
  if (typeof window.refreshAuthHeader === 'function') window.refreshAuthHeader();
  try { window.dispatchEvent(new CustomEvent('gfg:auth-changed')); } catch (e) {}
};
window.showAuthBanner = function (msg) { banner(msg); };
window.getDynamicEmail = function () { return (window.currentUser && window.currentUser.email) || null; };

function banner(msg) {
  let el = document.getElementById('ggi-auth-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ggi-auth-banner';
    el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:999px;border:1px solid #444;z-index:10001;font-size:.85rem;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

console.log('Foskaay GGI: Dynamic auth + EVM session key ready');
try { window.dispatchEvent(new Event('ggi:auth-ready')); } catch (e) {}
restoreSession();
