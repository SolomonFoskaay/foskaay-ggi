// src/dynamic-auth.js
// Primary login via Dynamic (email OTP → self-custody Solana wallet)
// Supabase is backup only

import { createDynamicClient, sendEmailOTP, verifyOTP, logout, getWalletAccounts } from '@dynamic-labs-sdk/client';
import { generateSessionKeys, getSessionKeys, getSignedSessionId } from '@dynamic-labs-sdk/client/core';
import { addSolanaExtension } from '@dynamic-labs-sdk/solana';
import { addEvmExtension } from '@dynamic-labs-sdk/evm';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';

const ENVIRONMENT_ID = '0fd49c9c-1b54-4dc5-88a0-924dd3607bf3'; // ← your real ID

const dynamicClient = createDynamicClient({
  environmentId: ENVIRONMENT_ID,
  metadata: {
    name: 'GlobalFolkGames',
    universalLink: window.location.origin,
  },
});

addSolanaExtension();
// EVM extension: lets Dynamic create + read the embedded EVM wallet for the
// Arc rail (Arc / Sepolia) alongside the Solana wallet. Wallet creation stays
// FREE (no gas sponsorship): the app sponsors gas itself, never a paid
// third-party sponsorship plan.
addEvmExtension();
window.dynamicClient = dynamicClient;

console.log('Dynamic client initialized');

let currentOtpVerification = null;

// Read the current session's embedded Solana wallet address via the SDK.
// The client exposes wallet accounts through getWalletAccounts(), not via
// dynamicClient.auth.walletAccounts as older SDK versions did.
function getSolanaWallet() {
    try {
        const accounts = getWalletAccounts(dynamicClient);
        const sol = accounts.find(w => w.chain === 'SOL' && w.address);
        return sol ? sol.address : null;
    } catch (e) {
        console.warn('Could not read Solana wallet', e);
        return null;
    }
}

// Poll until Dynamic has actually registered the created wallet account.
// createWaasWalletAccounts() can resolve before the account is queryable,
// so we must wait for it before persisting the profile.
async function waitForSolanaWallet(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const address = getSolanaWallet();
        if (address) return address;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

// Expose for profiles.js so it reads the wallet through the same reliable path
window.getDynamicSolanaWallet = getSolanaWallet;

// Read the current session's embedded EVM wallet address (Arc rail). Dynamic
// reports EVM accounts with chain === 'EVM'.
function getEvmWallet() {
    try {
        const accounts = getWalletAccounts(dynamicClient);
        const evm = accounts.find(w => w.chain === 'EVM' && w.address);
        return evm ? evm.address : null;
    } catch (e) {
        console.warn('Could not read EVM wallet', e);
        return null;
    }
}

async function waitForEvmWallet(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const address = getEvmWallet();
        if (address) return address;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

// Expose so any page can show the EVM wallet next to the Solana one.
window.getDynamicEvmWallet = getEvmWallet;

// ---------- Session keys ----------
// Session keys let the embedded wallet sign on-chain actions (VRF dice rolls,
// settlements) during this session without prompting the user each time.
// The SDK auto-generates keys on init; we ensure they exist after login too.

async function ensureSessionKeys() {
    try {
        if (!getSessionKeys(dynamicClient)) {
            await generateSessionKeys(dynamicClient);
            console.log('Dynamic session keys generated');
        }
        return getSessionKeys(dynamicClient) || null;
    } catch (e) {
        console.error('Session key generation error:', e);
        return null;
    }
}

// Public getter for the current session public key (used by later stages)
window.getDynamicSessionKeys = function () {
    try {
        return getSessionKeys(dynamicClient) || null;
    } catch (e) {
        return null;
    }
};

// Sign the session id — proves the session-key signing path works.
// Later on-chain transactions rely on this same signing flow.
window.verifyDynamicSession = async function () {
    try {
        return await getSignedSessionId(dynamicClient);
    } catch (e) {
        console.error('Session signing error:', e);
        return null;
    }
};

window.openDynamicLogin = function () {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  showEmailStep();
  modal.classList.add('visible');
};

function showEmailStep() {
  const content = document.querySelector('.auth-modal-content');
  if (!content) return;

  content.innerHTML = `
    <button id="auth-modal-close" class="auth-modal-close">×</button>
    <h2>Sign in</h2>
    <p class="auth-hint">Enter your email. We will send you a one-time code.</p>
    <input type="email" id="auth-email" placeholder="Email address" autocomplete="email">
    <div class="auth-actions">
      <button id="btn-send-otp" class="auth-btn primary">Send Code</button>
    </div>
  `;

  document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-send-otp')?.addEventListener('click', handleSendOTP);
}

function showOtpStep(email) {
  const content = document.querySelector('.auth-modal-content');
  if (!content) return;

  content.innerHTML = `
    <button id="auth-modal-close" class="auth-modal-close">×</button>
    <h2>Enter Code</h2>
    <p class="auth-hint">We sent a code to <strong>${email}</strong></p>
    <input type="text" id="auth-otp" placeholder="6-digit code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
    <div class="auth-actions">
      <button id="btn-verify-otp" class="auth-btn primary">Verify & Sign In</button>
      <button id="btn-back-email" class="auth-btn secondary">Back</button>
    </div>
  `;

  document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-verify-otp')?.addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-back-email')?.addEventListener('click', showEmailStep);
}

function closeModal() {
  document.getElementById('auth-modal')?.classList.remove('visible');
  currentOtpVerification = null;
}

async function handleSendOTP() {
  const emailInput = document.getElementById('auth-email');
  const email = emailInput?.value.trim();
  const btn = document.getElementById('btn-send-otp');

  if (!email) {
    if (window.showAuthBanner) window.showAuthBanner('Please enter your email', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    currentOtpVerification = await sendEmailOTP({ email });
    showOtpStep(email);
  } catch (err) {
    console.error('Send OTP error:', err);
    if (window.showAuthBanner) window.showAuthBanner(err.message || 'Failed to send code', true);
    btn.disabled = false;
    btn.textContent = 'Send Code';
  }
}

async function handleVerifyOTP() {
  const otpInput = document.getElementById('auth-otp');
  const code = otpInput?.value.trim();
  const btn = document.getElementById('btn-verify-otp');

  if (!code || code.length < 4) {
    if (window.showAuthBanner) window.showAuthBanner('Please enter the code', true);
    return;
  }

  if (!currentOtpVerification) {
    if (window.showAuthBanner) window.showAuthBanner('Please request a new code', true);
    showEmailStep();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
  await verifyOTP({
    otpVerification: currentOtpVerification,
    verificationToken: code,
  });

  // === IMPORTANT: Create the embedded Solana wallet ===
  try {
    const missingChains = getChainsMissingWaasWalletAccounts();
    if (missingChains && missingChains.length > 0) {
      await createWaasWalletAccounts({ chains: missingChains });
      console.log('Embedded wallets created for:', missingChains.join(', '));
    } else if (!getSolanaWallet()) {
      // No missing chains reported but wallet not visible yet — create for Solana
      await createWaasWalletAccounts({ chains: ['SOL'] });
      console.log('Embedded Solana wallet created (forced)');
    }
  } catch (walletErr) {
    console.error('Wallet creation error:', walletErr);
  }

  // EVM wallet (Arc / Sepolia): ensure it exists so the Arc rail has a session.
  try {
    if (!getEvmWallet()) {
      await createWaasWalletAccounts({ chains: ['EVM'] });
      console.log('Embedded EVM wallet created');
    }
  } catch (evmErr) {
    console.error('EVM wallet creation error:', evmErr);
  }

  // Wait until Dynamic exposes the created wallet accounts, so the profile is
  // saved with the real address instead of null.
  const walletAddress = await waitForSolanaWallet();
  console.log('Solana wallet ready:', walletAddress || 'not yet available');
  const evmWalletAddress = await waitForEvmWallet();
  console.log('EVM wallet ready:', evmWalletAddress || 'not yet available');

  // Ensure session keys exist so future on-chain actions sign without prompts
  const sessionKeys = await ensureSessionKeys();
  console.log('Session keys ready:', sessionKeys ? sessionKeys.publicKey : null);

  closeModal();
  if (window.showAuthBanner) window.showAuthBanner('Signed in successfully!');

  // Refresh header now that the wallet is guaranteed available
  if (window.refreshAuthHeader) await window.refreshAuthHeader();

  // Tell universal modules (M3 local points, ...) the wallet is ready so they
  // can re-fetch their on-chain ledgers for the now-signed-in player.
  try {
    window.dispatchEvent(new CustomEvent('gfg:auth-changed'));
  } catch (e) { /* CustomEvent may be unavailable in odd sandboxes */ }

  } catch (err) {
    console.error('Verify OTP error:', err);
    if (window.showAuthBanner) window.showAuthBanner(err.message || 'Invalid code', true);
    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
  }
}

// Proper logout
window.logoutDynamic = async function () {
  try {
    await logout();
    console.log('Dynamic logout successful');
  } catch (err) {
    console.error('Dynamic logout error:', err);
  }

  window.currentUser = null;
  window.currentProfile = null;

  if (window.refreshAuthHeader) {
    window.refreshAuthHeader();
  }

  try {
    window.dispatchEvent(new CustomEvent('gfg:auth-changed'));
  } catch (e) { /* ignore */ }
};