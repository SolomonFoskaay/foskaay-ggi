// auth.js
// Exposes global window.supabaseClient using the Publishable (anon) key.
// Handles Email signup / signin / signout + session restore.
// All UI feedback uses custom on-screen banners (no browser alerts).
// ONLY responsible for: creating supabaseClient + signup / signin / signout
// Everything about points lives in profiles.js

(function () {
    const SUPABASE_URL = 'https://ywrgxynjjgdicdzizpue.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_qbrLQtG1fx51sBIiDm_zGQ_dR6BcqEb';
    // The anon key is been sunset, so above is actual the new publishable key not anon key 
    // that can be published in frontend without exposing sensitie data

    if (!window.supabase) {
        console.error('Supabase SDK missing. Check CDN in index.html');
        return;
    }

    // Make the client available to the whole project
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Simple banner
    function showBanner(msg, isError = false) {
        const old = document.getElementById('auth-banner');
        if (old) old.remove();
        const b = document.createElement('div');
        b.id = 'auth-banner';
        b.className = isError ? 'auth-banner error' : 'auth-banner success';
        b.textContent = msg;
        document.body.appendChild(b);
        setTimeout(() => b.remove(), 4000);
    }
    window.showAuthBanner = showBanner;

    function openAuthModal() {
        document.getElementById('auth-modal')?.classList.add('visible');
    }
    function closeAuthModal() {
        document.getElementById('auth-modal')?.classList.remove('visible');
        document.getElementById('auth-email').value = '';
        document.getElementById('auth-password').value = '';
    }

    async function handleSignUp() {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!email || !password) return showBanner('Email and password required', true);
        if (password.length < 6) return showBanner('Password min 6 characters', true);

        const btn = document.getElementById('btn-signup');
        btn.disabled = true; btn.textContent = 'Creating…';
        const { error } = await window.supabaseClient.auth.signUp({ email, password });
        btn.disabled = false; btn.textContent = 'Create Account';
        if (error) return showBanner(error.message, true);
        showBanner('Account created!');
        closeAuthModal();
    }

    async function handleSignIn() {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!email || !password) return showBanner('Email and password required', true);

        const btn = document.getElementById('btn-signin');
        btn.disabled = true; btn.textContent = 'Signing in…';
        const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
        btn.disabled = false; btn.textContent = 'Sign In';
        if (error) return showBanner(error.message, true);
        showBanner('Welcome back!');
        closeAuthModal();
    }

    async function handleSignOut() {
        await window.supabaseClient.auth.signOut();
        showBanner('Signed out');
    }

    // Expose only what other files need
    window.openAuthModal = openAuthModal;
    window.handleSignOut = handleSignOut;
    // Expose for header.js (so modal buttons work on any page)
    window.handleSignIn = handleSignIn;
    window.handleSignUp = handleSignUp;

    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('auth-modal-close')?.addEventListener('click', closeAuthModal);
        document.getElementById('btn-signup')?.addEventListener('click', handleSignUp);
        document.getElementById('btn-signin')?.addEventListener('click', handleSignIn);
        document.getElementById('auth-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'auth-modal') closeAuthModal();
        });
    });
})();