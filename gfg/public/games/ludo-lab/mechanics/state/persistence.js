/**
 * GlobalFolkGames State Persistence Layer
 * Handles device-level state caching to safeguard matches during reloads.
 */

function displayEducationalLog(message) {
    console.log(message);
    const logBox = document.getElementById('ludo-log');
    if (logBox) logBox.innerText = message;
}

// ---------------------------------------------------------------------------
// Device-level resume cache ("no more persistence" hardening).
//
// The board snapshot is stored locally so a REFRESH resumes the match instead
// of resetting to fresh setup. It is a resume cache ONLY: the authoritative,
// non-tamperable records live ON-CHAIN (each VRF roll's proof signature, the
// points ledger PDA, and the reward row keyed by the winning roll sig). The
// MagicBlock guidance is that ER state is ephemeral and must be explicitly
// committed to base layer; committing every move is too costly, so the match
// snapshot stays local while the game's *authority* stays on-chain.
//
// A client can always edit its own localStorage (console tampering cannot be
// fully prevented client-side). We store a deterministic digest next to the
// payload so corruption / naive tampering is DETECTED on load and a fresh
// match is issued instead of silently resuming a doctored one. Blocked
// localStorage (some mobile browsers / private modes) degrades gracefully:
// the game still plays, it just cannot resume after a refresh.
// ---------------------------------------------------------------------------
const PERSISTENCE_KEY = 'gfg_ludo_lab_persistence_state';
const PERSISTENCE_HASH_KEY = PERSISTENCE_KEY + '_digest';

function hashStateString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
}

function clearPersistedState() {
    // Purge any LEGACY localStorage board (pre-2026-09-21 builds wrote one).
    // The live board is in-memory only now; this makes sure an old stored board
    // can never be resumed after this deploy.
    try { localStorage.removeItem(PERSISTENCE_KEY); } catch (e) {}
    try { localStorage.removeItem(PERSISTENCE_HASH_KEY); } catch (e) {}
    try { window.__gfgLudoLiveSnapshot = null; } catch (e) {}
}
// Expose for the multiplayer adapter: a stale SOLO save must never resurrect
// divergent local state inside a shared multiplayer match.
window.clearPersistedState = clearPersistedState;

// ---------------------------------------------------------------------------
// SIGN-OUT = MATCH OVER (anti-cheat, owner 2026-09-21).
//
// Before this, the saved board survived a logout: a player could sign in,
// start a match, sign out, and keep playing the already-loaded board with no
// account. That was free unlimited play (and could fire a second start commit
// when a stale save reloaded). The fix: when auth goes away, the local match
// is DISCARDED - a match requires a signed-in player. The life already spent at
// match start is non-refundable, so logging out can never be a free restart.
//
// This is deliberately conservative: it clears the local resume cache and the
// win/detection state, and reloads to a clean, signed-out setup. It never
// touches on-chain data; the chain remains the source of truth.
// ---------------------------------------------------------------------------
function discardMatchOnSignOut() {
    try { clearPersistedState(); } catch (e) {}
    try { if (typeof window.resetWinDetection === 'function') window.resetWinDetection(); } catch (e) {}
    try { if (typeof window.setMatchStatus === 'function') window.setMatchStatus('abandoned'); } catch (e) {}
    try {
        // A signed-out page must not offer to resume or replay: return to a
        // fresh setup once, without a reload loop.
        if (typeof setupConfigurationLocked !== 'undefined' && setupConfigurationLocked) {
            setupConfigurationLocked = false;
            const startBtn = document.getElementById('startMatchBtn');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.style.background = '#2ecc71';
                startBtn.style.color = '#fff';
                startBtn.innerText = 'Start Arena Match';
            }
        }
    } catch (e) { /* soft */ }
}
window.discardMatchOnSignOut = discardMatchOnSignOut;

// ---------------------------------------------------------------------------
// Pending on-chain push queue ("backup plan with a tamper-proof hash").
//
// When an on-chain record (match result proof, future M3/M4 reward record)
// cannot be pushed because the network is down or the push fails, the game
// queues it here. On the next load and on every network restore the queue is
// flushed: each entry's digest is re-verified BEFORE it is pushed. A tampered
// entry is dropped and surfaces a loud warning, so an altered play is NEVER
// recorded on-chain and the player is told their data was rejected.
//
// Note (honest limit): a player can always re-sign their own device data, so
// this is DETECTION + deterrence, not a security boundary. The authoritative,
// non-tamperable records are the on-chain VRF proofs and the reward row keyed
// by the proof-roll signature.
// ---------------------------------------------------------------------------
const PENDING_PUSH_KEY = 'gfg_pending_onchain_pushes';
let pendingPushHandlers = {};
let lastPersistenceWarning = null;

window.registerPendingPushHandler = function (type, fn) {
    if (typeof fn === 'function') pendingPushHandlers[type] = fn;
};

function readPendingPushes() {
    try {
        const raw = localStorage.getItem(PENDING_PUSH_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
}

function writePendingPushes(arr) {
    try { localStorage.setItem(PENDING_PUSH_KEY, JSON.stringify(arr)); } catch (e) {}
}

function queuePendingPush(type, payload) {
    try {
        const arr = readPendingPushes();
        arr.push({
            type,
            payload,
            createdAt: Date.now(),
            digest: hashStateString(type + '|' + JSON.stringify(payload)),
        });
        writePendingPushes(arr);
        return true;
    } catch (e) { return false; }
}
window.queuePendingPush = queuePendingPush;

window.getPendingPushes = function () { return readPendingPushes(); };

async function flushPendingPushes() {
    const arr = readPendingPushes();
    if (!arr.length) return;
    const remaining = [];
    for (const entry of arr) {
        const expected = hashStateString(entry.type + '|' + JSON.stringify(entry.payload));
        if (entry.digest !== expected) {
            // Tampered entry: refuse to push it and warn the player loudly so
            // they never believe an altered play was recorded on-chain.
            console.warn('[persistence] discarded tampered pending push:', entry.type);
            showPersistenceWarning('Some of your match data on this device was modified and cannot be recorded on-chain. It has been discarded.');
            continue;
        }
        const handler = pendingPushHandlers[entry.type];
        if (!handler) { remaining.push(entry); continue; }
        try {
            const ok = await handler(entry.payload);
            if (ok) continue; // pushed successfully -> drop the entry
        } catch (e) {
            console.warn(`[persistence] pending push '${entry.type}' failed, will retry:`, e);
        }
        remaining.push(entry);
    }
    writePendingPushes(remaining);
}
window.flushPendingPushes = flushPendingPushes;

// Records the last warning shown (survives stubbed DOM in tests / consoles).
window.getLastPersistenceWarning = function () { return lastPersistenceWarning; };

// Visible, dismissible warning so a player is ALWAYS aware when their play can
// no longer be recorded on-chain (tampered data, unverifiable save).
function showPersistenceWarning(message) {
    lastPersistenceWarning = message;
    try {
        ensureWarningOverlay();
        const overlay = document.getElementById('gfg-persistence-warning');
        if (!overlay) return;
        const msgEl = overlay.querySelector('.gfg-pw-msg');
        if (msgEl) msgEl.textContent = message;
        overlay.style.display = 'flex';
        const okBtn = document.getElementById('gfg-pw-ok');
        if (okBtn) {
            okBtn.onclick = () => { overlay.style.display = 'none'; };
        }
    } catch (e) {
        console.warn('PERSISTENCE: warning popup unavailable:', e);
    }
}
window.showPersistenceWarning = showPersistenceWarning;

function ensureWarningOverlay() {
    if (document.getElementById('gfg-persistence-warning')) return;
    const overlay = document.createElement('div');
    overlay.id = 'gfg-persistence-warning';
    overlay.className = 'gfg-persistence-warning';
    const box = document.createElement('div');
    box.className = 'gfg-pw-box';
    const title = document.createElement('p');
    title.className = 'gfg-pw-title';
    title.textContent = 'Match data could not be verified';
    const msg = document.createElement('p');
    msg.className = 'gfg-pw-msg';
    const okBtn = document.createElement('button');
    okBtn.id = 'gfg-pw-ok';
    okBtn.textContent = 'Got it';
    box.appendChild(title);
    box.appendChild(msg);
    box.appendChild(okBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

// Best-effort: ask the browser not to evict the save under storage pressure
// (research-backed: localStorage can be evicted on mobile). Never fails loudly.
function requestPersistentStorage() {
    try {
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => {});
        }
    } catch (e) { /* best-effort */ }
}
requestPersistentStorage();

function saveGameStateToStorage() {
    const winState = (typeof window.serializeWinState === 'function')
        ? window.serializeWinState()
        : null;

    const statePayload = {
        currentTurn,
        lastDiceRoll1,
        lastDiceRoll2,
        isDiceRolled,
        currentTurnMoves,
        consecutiveDoubleSixes,
        hasRolledThisTurn,
        isGamePaused,
        isChainDown: (typeof isChainDown !== 'undefined') ? isChainDown : false,
        setupConfigurationLocked,
        playerProfiles,
        matchMode: (typeof matchMode !== 'undefined') ? matchMode : '4p',
        activeSeats: (typeof getActiveSeats === 'function') ? getActiveSeats() : null,
        winState,
        tokensSnapshot: typeof tokens !== 'undefined' ? tokens : null,
        savedAt: Date.now()
    };
    // NO localStorage BOARD (owner 2026-09-21): the live board is held IN MEMORY
    // for the session only. A locally-stored board is not the source of truth
    // and can conflict with the GFG-BS window Merkle tree (stale actions), and
    // it let a logged-out page keep playing a started match. On-chain (start
    // commit + co-signed settlement + window flush) is the truth; points and the
    // result live on-chain. The signed cross-device resume is built separately
    // (item 17vii) - it will rehydrate from SIGNED match events, never from this
    // editable snapshot.
    window.__gfgLudoLiveSnapshot = statePayload;
}

function loadGameStateFromStorage() {
    // Only ever resume from the IN-MEMORY snapshot (same session, e.g. a
    // component remount). Never from localStorage: that path is removed.
    let rawData = null;
    try { rawData = window.__gfgLudoLiveSnapshot ? JSON.stringify(window.__gfgLudoLiveSnapshot) : null; } catch (e) { rawData = null; }
    if (!rawData) return false;

    // No integrity check needed: the in-memory snapshot cannot be edited from
    // outside the page (there is no localStorage board to tamper with anymore).

    try {
        const savedState = JSON.parse(rawData);
        
        currentTurn = savedState.currentTurn;
        lastDiceRoll1 = savedState.lastDiceRoll1;
        lastDiceRoll2 = savedState.lastDiceRoll2;
        isDiceRolled = savedState.isDiceRolled;
        currentTurnMoves = savedState.currentTurnMoves;
        consecutiveDoubleSixes = savedState.consecutiveDoubleSixes;
        hasRolledThisTurn = savedState.hasRolledThisTurn;
        isGamePaused = savedState.isGamePaused;
        setupConfigurationLocked = savedState.setupConfigurationLocked;

        // Interrupted-roll recovery: a page closed while an on-chain roll was
        // in flight (isDiceRolled set at roll start, result never finalized)
        // must NOT hang the turn. Re-arm it so the roll runs cleanly again.
        if (isDiceRolled && hasRolledThisTurn && (!currentTurnMoves || currentTurnMoves.length === 0)) {
            isDiceRolled = false;
            hasRolledThisTurn = false;
        }

        // Restore the match mode (2P / 4P) FIRST so active-seat logic lines up.
        // NOTE: we restore matchMode + activeSeats DIRECTLY instead of calling
        // selectMatchMode()/setActiveSeats() — both are USER actions guarded by
        // setupConfigurationLocked and would NO-OP on a mid-match reload, leaving
        // activeSeats at the 4P default and silently re-activating the seats the
        // player never picked (the 2P-refresh bug). The persisted mode + corner
        // choice are internal restore data, not user edits.
        if (typeof matchMode !== 'undefined' && savedState.matchMode) {
            const restoredMode = savedState.matchMode === '2p' ? '2p' : '4p';
            matchMode = restoredMode;

            let restoredActive = null;
            if (savedState.activeSeats && Array.isArray(savedState.activeSeats) && savedState.activeSeats.length > 0) {
                const valid = savedState.activeSeats.filter(color => ALL_SEATS.indexOf(color) !== -1);
                if (valid.length > 0) restoredActive = valid;
            }

            if (restoredMode === '4p') {
                activeSeats = ALL_SEATS.slice();
            } else if (restoredActive && restoredActive.length === 2) {
                activeSeats = restoredActive;
            } else {
                activeSeats = ['green', 'red'];
            }

            if (typeof ensureUserOnActiveSeat === 'function') ensureUserOnActiveSeat();
            if (typeof syncModeUI === 'function') syncModeUI();
        }
        
        for (let color in savedState.playerProfiles) {
            if (!playerProfiles[color]) continue;
            playerProfiles[color].mode = savedState.playerProfiles[color].mode || 'human';
            playerProfiles[color].isUser = savedState.playerProfiles[color].isUser === true;
        }

        // Restore crowns / finishing order + match outcome so they survive reloads.
        if (typeof window.hydrateWinState === 'function' && savedState.winState) {
            window.hydrateWinState(savedState.winState);
        }

        // A finished match restores to the ceremony (never resumes play).
        let restoredStatus = (typeof window.getMatchStatus === 'function')
            ? window.getMatchStatus() : 'in-progress';

        // REFRESH-SAFE RESUME (fixes "refresh starts a fresh game"): a reload
        // mid-match must resume the exact same board. Only a truly STALE
        // in-progress match (untouched for a full day, i.e. a session that
        // ended long ago) is treated as abandoned and cleared to fresh setup.
        const STALE_MATCH_MS = 24 * 60 * 60 * 1000;
        if (restoredStatus === 'in-progress' && savedState.savedAt && (Date.now() - savedState.savedAt) > STALE_MATCH_MS) {
            if (typeof window.setMatchStatus === 'function') window.setMatchStatus('abandoned');
            if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
            restoredStatus = 'abandoned';
        }

        // An abandoned match never resumes: clear the cache back to fresh setup.
        if (restoredStatus === 'abandoned') {
            clearPersistedState();
            displayEducationalLog("Previous match was abandoned (never rewarded). Ready for a fresh match.");
            if (typeof window.resetWinDetection === 'function') window.resetWinDetection();
            setupConfigurationLocked = false;
            const startBtn = document.getElementById('startMatchBtn');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.style.background = '#2ecc71';
                startBtn.style.color = '#fff';
                startBtn.innerText = 'Start Arena Match';
            }
            turnSequence.forEach(color => {
                const selectElement = document.getElementById(`type-${color}`);
                if (selectElement) selectElement.disabled = false;
            });
            // Re-apply the mode's active-seat disable (2P: yellow + blue stay off).
            if (typeof window.getActiveSeats === 'function') {
                const active = window.getActiveSeats();
                turnSequence.forEach(color => {
                    const selectElement = document.getElementById(`type-${color}`);
                    if (selectElement && active.indexOf(color) === -1) selectElement.disabled = true;
                });
            }
            const diceBtn = document.getElementById('diceBtn');
            if (diceBtn) diceBtn.disabled = true;
            return true;
        }

        if (savedState.tokensSnapshot && typeof tokens !== 'undefined') {
            for (let color in tokens) {
                tokens[color] = savedState.tokensSnapshot[color];
            }
        }

        const turnIndicator = document.getElementById('turn-indicator');
        if (turnIndicator) {
            turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
            turnIndicator.style.color = colorsMap[currentTurn];
        }

        const d1Box = document.getElementById('val-d1');
        const d2Box = document.getElementById('val-d2');
        const totalBox = document.getElementById('val-total');
        if (d1Box) d1Box.innerText = lastDiceRoll1 || '-';
        if (d2Box) d2Box.innerText = lastDiceRoll2 || '-';
        if (totalBox) totalBox.innerText = lastDiceRoll1 ? `= Total: ${lastDiceRoll1 + lastDiceRoll2}` : 'Total: -';

        const pauseBtn = document.getElementById('pauseBtn');
        if (pauseBtn) {
            if (isGamePaused) {
                pauseBtn.innerText = '▶ Resume';
                pauseBtn.classList.add('paused-state');
            } else {
                pauseBtn.innerText = '⏸ Pause';
                pauseBtn.classList.remove('paused-state');
            }
        }

        turnSequence.forEach(color => {
            const selectElement = document.getElementById(`type-${color}`);
            if (selectElement) {
                selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
                selectElement.disabled = setupConfigurationLocked;
            }
        });
        // In 2P mode the yellow + blue seats are not part of the match: keep
        // their dropdowns disabled even when unlocked (restored pre-lock setup).
        if (typeof window.getActiveSeats === 'function') {
            const active = window.getActiveSeats();
            turnSequence.forEach(color => {
                const selectElement = document.getElementById(`type-${color}`);
                if (selectElement && active.indexOf(color) === -1) selectElement.disabled = true;
            });
        }

        const startBtn = document.getElementById('startMatchBtn');
        if (startBtn) {
            if (setupConfigurationLocked) {
                startBtn.disabled = true;
                startBtn.style.background = '#333';
                startBtn.style.color = '#666';
                startBtn.innerText = 'Match Active';
            } else {
                startBtn.disabled = false;
                startBtn.style.background = '#2ecc71';
                startBtn.style.color = '#fff';
                startBtn.innerText = 'Start Arena Match';
            }
        }

        const diceBtn = document.getElementById('diceBtn');
        if (diceBtn) diceBtn.disabled = !setupConfigurationLocked;

        displayEducationalLog(`STATE PERSISTENCE: Saved match recovered. Active Turn: ${currentTurn.toUpperCase()}`);
        
        if (typeof drawLudoLayout === 'function') drawLudoLayout();

        // A finished match must NOT resume the loop — re-show the ceremony.
        if (restoredStatus === 'finished') {
            if (typeof window.markMatchOver === 'function') window.markMatchOver();
            if (typeof window.showResultCeremony === 'function') window.showResultCeremony();
            return true;
        }

        // An outage pause survives a refresh: re-arm the banner + monitor so the
        // match stays paused (never a false roll) and auto-resumes on recovery.
        if (savedState.isChainDown === true && typeof window.rearmChainDownState === 'function') {
            window.rearmChainDownState();
        }

        if (setupConfigurationLocked && !isGamePaused && !isChainDown && playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (typeof matchOver !== 'undefined' && matchOver) return;
                if (!isDiceRolled) {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else if (currentTurnMoves.length > 0) {
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }
            }, 1500);
        }

        // Retry any on-chain pushes that could not go through while offline.
        if (typeof window.flushPendingPushes === 'function') {
            try { window.flushPendingPushes(); } catch (e) { console.warn('[persistence] pending-push flush failed:', e); }
        }

        return true;
    } catch (e) {
        console.error("State recovery parsing error: ", e);
        return false;
    }
}

/**
 * Triggers the custom mobile warning confirmation overlay modal panel view
 */
function triggerManualArenaReset() {
    const customConfirmBox = document.getElementById('custom-confirm-overlay');
    if (customConfirmBox) {
        customConfirmBox.style.display = 'flex';
    }
}

/**
 * Handles action callbacks derived from clicking choice buttons in the warning dialogue portal box
 */
function handleConfirmationCallback(userApproved) {
    const customConfirmBox = document.getElementById('custom-confirm-overlay');
    if (customConfirmBox) {
        customConfirmBox.style.display = 'none'; // Clear window layout view out right away
    }

    if (!userApproved) {
        displayEducationalLog("RESET ABORTED: Match sequence preserved safely.");
        return;
    }

    // End Match: commit status=abandoned (never rewarded), then clear + reload.
    if (typeof window.endMatchAbandon === 'function') {
        window.endMatchAbandon();
        return;
    }

    // ===== RESET WIN DETECTION: Reset only the win-detection flag (so a new match can award points again) =====
    if (typeof window.resetWinDetection === 'function') {
        window.resetWinDetection();
    }
    // =============================================

    clearPersistedState();
    displayEducationalLog("SYSTEM RESET: Persistent cache cleared. Re-initializing arena canvas...");
    setTimeout(() => {
        window.location.reload();
    }, 500);
}

// Bind the sign-out discard. gfg:auth-changed fires on both sign-in and sign-out,
// so only act when there is genuinely NO signed-in user. Guarded so a transient
// wallet-not-ready state cannot wipe a live match by accident: we require the
// absence to persist briefly before discarding.
(function () {
    var missSince = 0;
    function signedIn() {
        try {
            if (window.currentUser) return true;
            var a = window.gfgChainAdapter;
            if (a && typeof a.walletAddress === 'function' && a.walletAddress()) return true;
            if (typeof window.getDynamicSolanaWallet === 'function' && window.getDynamicSolanaWallet()) return true;
            if (typeof window.getDynamicEvmWallet === 'function' && window.getDynamicEvmWallet()) return true;
        } catch (e) { /* treat as signed out */ }
        return false;
    }
    function recheck() {
        if (typeof window.getMatchStatus === 'function' && window.getMatchStatus() !== 'in-progress') return;
        if (signedIn()) { missSince = 0; return; }
        if (!missSince) { missSince = Date.now(); return; }
        if (Date.now() - missSince < 4000) return; // grace: ignore a transient blip
        missSince = 0;
        console.warn('[persistence] sign-out detected during a live match: discarding the local match.');
        discardMatchOnSignOut();
    }
    try {
        window.addEventListener('gfg:auth-changed', function () {
            // Give the header a moment to resolve the wallet before judging.
            setTimeout(recheck, 400);
        });
        window.addEventListener('load', function () { setTimeout(recheck, 1200); });
    } catch (e) { /* soft */ }
})();