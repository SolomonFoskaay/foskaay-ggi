/**
 * GlobalFolkGames Core Game Loop Engine
 * Manages active player loops, tournament matching, and progression hooks.
 */

// Core Variable Definitions
let currentTurn = 'green';

// M12 multiplayer: the game's turn is a global LEXICAL `let` (not on window),
// so `window.currentTurn` was always undefined. That made the multiplayer dice
// guard (gfgRemoteTurn, dice.js) block EVERY roll on both devices
// ("Waiting for the remote player's move") and the adapter's commit encoding
// default to green. Expose the live value through a safe getter instead.
window.getGameCurrentTurn = function () { return currentTurn; };
// Setter used by the multiplayer sync: the turn is advanced from the single
// on-chain board (current_turn), never from a device's guessed local sequence,
// so every phone converges on the same turn.
window.setGameCurrentTurn = function (color) {
    if (ALL_SEATS.indexOf(color) === -1) return;
    currentTurn = color;
    if (typeof displayEducationalLog === 'function') {
        displayEducationalLog(`${(color || '').toUpperCase()}'s turn — on-chain ${color} (board-synced).`);
    }
};
// Reset the per-turn roll flags so a newly-synced turn can roll cleanly (used
// by the multiplayer adapter AFTER applying a remote commit - the turn was
// already advanced from the board, so we only clear the stale roll state).
window.resetTurnForRoll = function () {
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0;
    if (typeof hideVerifyLink === 'function') hideVerifyLink();
};

let lastDiceRoll1 = 0;
let lastDiceRoll2 = 0;
let isDiceRolled = false;
let displayDiceOnBoard = false;

let currentTurnMoves = []; 
let consecutiveDoubleSixes = 0; 
let hasRolledThisTurn = false;

// Pause Loop Execution Control States
let isGamePaused = false;

// Endgame state (M1 locked spec, amended 2026-08-15): once the match is decided
// — at most ONE active seat left unfinished, the trailing seat auto-last — the
// loop STOPS (no infinite cycling, no reset-only ending) and a result ceremony
// 1st..Nth + "Play Again" is shown. matchOver guards every action.
let matchOver = false;

// arc2m1 SINGLE-PLAYER turn timer (separate from the multiplayer on-chain
// timer, which lives on the board). Solo has no board, so the same 45s rule is
// enforced here in the core turn loop: each new turn gets a fresh window, and a
// human's turn that runs out auto-passes (never a computer turn - the AI always
// acts instantly). This is DISPLAY + enforcement only and NEVER touches the MP
// rail - the 1s check below stands down the moment a multiplayer match is
// active (its own on-chain timer takes over).
const SOLO_TURN_MS = 45000;
let soloTurnDeadline = 0;
let soloTurnArmed = false;   // true once a live solo turn is being timed
window.__soloTurnDeadlineMs = function () { return soloTurnDeadline; };
window.__soloTurnArmed = function () { return soloTurnArmed; };
// (Re)arm the current solo turn's window. Called when a new solo turn begins
// (match start + every pass). Idempotent.
function armSoloTurnDeadline() {
    soloTurnDeadline = Date.now() + SOLO_TURN_MS;
    soloTurnArmed = true;
}
// Auto-pass a solo HUMAN turn whose window has elapsed. Called on the 1s tick
// AND defensively right before the AI would otherwise wait on an idle human.
function maybeAutoPassSoloTurn() {
    // Never in multiplayer (the on-chain expire_turn owns that path).
    if (window.gfgLudoAdapter && typeof window.gfgLudoAdapter.isActive === 'function' && window.gfgLudoAdapter.isActive()) return;
    if (isGamePaused || matchOver) return;
    if (!setupConfigurationLocked) return;
    if (!soloTurnArmed) return;
    if (Date.now() < soloTurnDeadline) return;
    // Only a HUMAN seat auto-passes on timeout (computers act instantly; a
    // finished seat is already auto-skipped by the turn loop).
    const p = window.playerProfiles && window.playerProfiles[currentTurn];
    if (!p || p.mode !== 'human') return;
    soloTurnArmed = false;
    displayEducationalLog(`${currentTurn.toUpperCase()}: Turn time is up - passing to the next player.`);
    if (typeof passTurnSequence === 'function') {
        try { passTurnSequence(); } catch (e) {}
    }
}

// Anti-Cheat Automation Settings Engine States
let setupConfigurationLocked = false;
// `isUser` marks the seat bound to the signed-in Dynamic user (the "You" seat).
// Exactly ONE seat may be the user seat; it is always played as a human.
window.playerProfiles = {
    green: { mode: 'human', isUser: true },
    yellow: { mode: 'computer', isUser: false },
    blue: { mode: 'computer', isUser: false },
    red: { mode: 'computer', isUser: false }
};

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

// The 1s solo timer tick: auto-pass an elapsed solo human turn + report the
// deadline for the display chip. Started by the page (non-MP path). Returns the
// remaining ms for the active solo turn (0 when idle), so the page can render
// 00m:45s:000ms under the turn name during solo play.
window.__soloTurnTick = function () {
    maybeAutoPassSoloTurn();
    return soloTurnArmed ? (soloTurnDeadline - Date.now()) : 0;
};

// Match mode: '2p' (exactly TWO seats, user picks any two colours) or '4p'
// (all four). Selectable BEFORE the match locks; after lock it is frozen.
// The locked spec's COMPLETED DEFINITION requires every ACTIVE seat to finish
// (2P: both chosen seats, 4P: all four), so the turn loop, endgame, ceremony
// and seam all derive from the ACTIVE seats only.
let matchMode = '4p';
const ALL_SEATS = ['green', 'yellow', 'blue', 'red'];
let activeSeats = ALL_SEATS.slice();   // mutable: the seats actually in the match

// Active seats for the current mode (what the turn loop, endgame and seam use).
function getActiveSeats() {
    return activeSeats.slice();
}
window.getActiveSeats = getActiveSeats;

// Public: select 2P / 4P before the match locks. In 2P, the user picks ANY two
// colours (defaults to green + red); in 4P all four seats are active.
window.selectMatchMode = function (mode) {
    if (setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match already active. Mode cannot be changed.");
        return;
    }
    matchMode = (mode === '2p') ? '2p' : '4p';

    if (matchMode === '4p') {
        activeSeats = ALL_SEATS.slice();
    } else {
        // Keep any previous 2P choice; first time defaults to green + red.
        if (activeSeats.length !== 2) {
            activeSeats = ['green', 'red'];
        }
    }

    ensureUserOnActiveSeat();
    syncModeUI();
    displayEducationalLog(`Match mode: ${matchMode === '2p' ? '2 Players - tap a colour to pick your two seats' : '4 Players'}.`);
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// Public: tap a seat colour to toggle it in/out of the match (2P only).
// During selection 1..2 seats stay active (so the pair can be freely swapped:
// remove one, add another); locking enforces EXACTLY two (initiateArenaMatch).
window.toggleActiveSeat = function (color) {
    if (setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match already active. Seats cannot be changed.");
        return;
    }
    if (matchMode !== '2p') {
        displayEducationalLog("Seat choice applies in 2 Players mode.");
        return;
    }

    const index = activeSeats.indexOf(color);
    if (index === -1) {
        // Adding beyond two is blocked — a 3rd seat has no turn slot in 2P.
        if (activeSeats.length >= 2) {
            displayEducationalLog("2 Players: exactly two seats play. Tap one of the active colours to swap it out first.");
            return;
        }
        activeSeats.push(color);
    } else {
        // Removing the last active seat is blocked — every match needs a seat.
        if (activeSeats.length <= 1) {
            displayEducationalLog("2 Players: at least one seat must stay active.");
            return;
        }
        activeSeats.splice(index, 1);
    }

    ensureUserOnActiveSeat();
    syncModeUI();
    displayEducationalLog(`2 Players: ${activeSeats.map(c => c.toUpperCase()).join(' vs ')}.`);
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// Keep the signed-in 'You' seat on an ACTIVE seat (never on a disabled one).
function ensureUserOnActiveSeat() {
    const userOnActive = activeSeats.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userOnActive) {
        ALL_SEATS.forEach(color => { if (playerProfiles[color]) playerProfiles[color].isUser = false; });
        const first = activeSeats[0] || 'green';
        playerProfiles[first] = { mode: 'human', isUser: true };
    }
}

// Restore the previously chosen active seats (2P corner choice) on reload.
window.setActiveSeats = function (colors) {
    if (setupConfigurationLocked) return;
    if (Array.isArray(colors) && colors.length > 0) {
        activeSeats = colors.filter(color => ALL_SEATS.indexOf(color) !== -1);
        if (activeSeats.length !== 2) {
            activeSeats = ['green', 'red'];
        }
        ensureUserOnActiveSeat();
        syncModeUI();
    }
};

// Reflect the active/inactive seats in the setup slots: inactive seats get a
// bold INACTIVE badge and a greyed (disabled) dropdown; active seats are live.
function syncModeUI() {
    const btn2 = document.getElementById('mode-2p');
    const btn4 = document.getElementById('mode-4p');
    if (btn2) btn2.classList.toggle('active', matchMode === '2p');
    if (btn4) btn4.classList.toggle('active', matchMode === '4p');

    ALL_SEATS.forEach(color => {
        const slot = document.getElementById(`slot-${color}`);
        const selectElement = document.getElementById(`type-${color}`);
        const statusEl = document.getElementById(`seat-status-${color}`);
        const active = activeSeats.indexOf(color) !== -1;
        if (slot) slot.classList.toggle('inactive', !active);
        if (selectElement) {
            selectElement.disabled = !active;
            selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
        }
        if (statusEl) statusEl.style.display = active ? 'none' : 'inline';
    });
}

function toggleArenaPauseState() {
    if (!setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match has not started yet. Cannot pause an inactive arena.");
        return;
    }

    isGamePaused = !isGamePaused;
    const pauseBtnElement = document.getElementById('pauseBtn');

    if (isGamePaused) {
        if (pauseBtnElement) {
            pauseBtnElement.innerText = '▶ Resume';
            pauseBtnElement.classList.add('paused-state');
        }
        displayEducationalLog("GAME PAUSED: Actions are suspended. Click 'Resume' to continue.");
    } else {
        if (pauseBtnElement) {
            pauseBtnElement.innerText = '⏸ Pause';
            pauseBtnElement.classList.remove('paused-state');
        }
        displayEducationalLog(`GAME RESUMED: Returning to active turn for ${currentTurn.toUpperCase()}.`);
        
        if (playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (isGamePaused) return;
                if (!isDiceRolled) {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else if (currentTurnMoves.length > 0) {
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }
            }, 1000);
        }
    }
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
}

function lockSetupDropdowns() {
    if (setupConfigurationLocked) return;
    setupConfigurationLocked = true;

    // Arc rail (arcv2m16): charge ONE life at match start through the self-hosted
    // relayer. On Solana this is a no-op (the life is charged on-chain at
    // begin/join), so the gateway returns null there.
    try {
        if (window.gfgChain && typeof window.gfgChain.isArc === 'function' && window.gfgChain.isArc()) {
            const arcMatchRef = window.gfgGameMatchRef || Date.now();
            window.gfgGameMatchRef = arcMatchRef;
            // The Arc game-flow bridge already charged this life at the gate
            // (chain-enforced, awaited). Never charge twice for the same match.
            if (window.__gfgArcLifeGateHandled === arcMatchRef) {
                window.__gfgArcLifeGateHandled = null;
            } else if (window.gfgChain.chargeLife) {
                window.gfgChain.chargeLife(arcMatchRef).catch(function (e) { console.warn('[gfgChain] chargeLife failed', e); });
            }
        }
    } catch (e) { /* soft: never block the match start */ }
    matchOver = false;

    // New match: arm exactly one fresh provably-fair proof roll (first human turn).
    if (typeof resetOnchainProofRollUsed === 'function') resetOnchainProofRollUsed();
    
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            // 'you' maps to a human player; the isUser flag is set separately.
            playerProfiles[color].mode = selectElement.value === 'you' ? 'human' : selectElement.value;
            selectElement.disabled = true;
        }
    });

    const startBtn = document.getElementById('startMatchBtn');
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.background = '#333';
        startBtn.style.color = '#666';
        startBtn.style.cursor = 'not-allowed';
        startBtn.innerText = 'Match Active';
    }

    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = false;
    
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
}

function initiateArenaMatch() {
    if (setupConfigurationLocked) return;

    // Mandatory login: the match must be tied to the signed-in Dynamic user.
    const signedIn = !!(window.currentUser && (window.currentUser.dynamicId || window.currentUser.id));
    if (!signedIn) {
        displayEducationalLog("ERROR: Sign in to play. One seat must be assigned to the logged-in player (You).");
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Sign in to play GlobalFolkGames Ludo', true);
        }
        if (typeof window.openDynamicLogin === 'function') {
            window.openDynamicLogin();
        }
        return;
    }

    // Exactly one seat must be the logged-in user's seat ("You").
    const activeSeats = getActiveSeats();
    const userSeat = activeSeats.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userSeat) {
        displayEducationalLog("ERROR: Assign the logged-in player to a seat — choose 'You' on one seat.");
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Choose "You" on a seat to begin the match', true);
        }
        return;
    }

    // 2P mode locks with EXACTLY two active seats (corner choice is complete).
    if (matchMode === '2p' && activeSeats.length !== 2) {
        displayEducationalLog("ERROR: 2 Players needs exactly two active seats — tap the colour pills to pick your two.");
        return;
    }

    let humanCount = 0;
    activeSeats.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        const value = selectElement ? selectElement.value : playerProfiles[color].mode;
        if (value === 'human' || value === 'you') humanCount++;
    });

    if (humanCount === 0) {
        displayEducationalLog("ERROR: Integrity rule breach. At least one player seat must be Human.");
        return;
    }

    // M10 LIVES GATE: block the match start when today's free-play lives are
    // exhausted (refill at GMT+00). The gate reads window.gfgLives (loaded on
    // every page via the header); when the module is absent (dev page without
    // the header) play is NOT blocked.
    // MULTIPLAYER EXEMPTION: a player who JOINED a live multiplayer match is not
    // gated by their own lives — the host already consumed the entry life and
    // the invited device must start its board to mirror the shared game.
    const mpJoined = !!(window.gfgLudoAdapter && typeof window.gfgLudoAdapter.isActive === 'function' && window.gfgLudoAdapter.isActive());
    if (!mpJoined && typeof window.gfgLives === 'object' && window.gfgLives && typeof window.gfgLives.get === 'function') {
        const lives = window.gfgLives.get();
        if (lives && lives.livesLeft <= 0) {
            const mins = Math.ceil((lives.resetsInMs || 0) / 60000);
            displayEducationalLog(`ERROR: No lives left for today. Lives refill at midnight (GMT+00)${mins > 0 ? `, about ${mins} min away` : ''}.`);
            // Persistent centre overlay (never auto-dismisses) pointing to the
            // subscription page — stops the Replay-forever exploit where a stale
            // meter let users keep playing without a refresh.
            if (typeof window.showLivesBlocked === 'function') {
                window.showLivesBlocked(true);
            } else if (typeof window.showAuthBanner === 'function') {
                window.showAuthBanner(`No lives left today. Your meter refills at midnight (GMT), roughly ${mins > 0 ? mins + ' minutes' : 'soon'}.\n\nGo Premium for double lives.`, true);
            }
            return;
        }
    }

    // Fresh-match start seat: classic Ludo turn order is GREEN → YELLOW → BLUE
    // → RED regardless of 2P or 4P, so the match opens on the FIRST ACTIVE seat
    // in that canonical order (4P = GREEN; 2P = whichever of the chosen colours
    // comes first in GREEN/YELLOW/BLUE/RED). It is NEVER the user's seat and
    // never an inactive seat. Reset turn flags so the new turn starts clean.
    currentTurn = ALL_SEATS.find(color => activeSeats.indexOf(color) !== -1) || userSeat;
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;
    currentTurnMoves = [];

    // arc2m1 solo turn timer: the first solo turn starts now.
    armSoloTurnDeadline();

    console.log(`[GFG LUDO] Match started | mode=${matchMode} | activeSeats=${activeSeats.join(',')} | userSeat=${userSeat} | startingTurn=${currentTurn} | seatModes=${Object.keys(playerProfiles).map(c => `${c}:${playerProfiles[c].mode}`).join(',')}`);

    // Keep the dice-box turn label in sync with the actual starting seat
    // (previously it stayed on the HTML default "Green's Turn" until the first
    // turn pass, even when the match correctly started on YELLOW/RED etc).
    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }

    lockSetupDropdowns();
    displayEducationalLog(`${currentTurn.toUpperCase()}: Arena match successfully initiated. Roll dice.`);

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1200);
    }
}

function passTurnSequence() {
    if (isGamePaused) return;
    if (matchOver) return;

    // Endgame guard: once the match is decided (at most ONE active seat left
    // unfinished) the loop must STOP — the trailing seat is auto-last.
    if (typeof window.isMatchComplete === 'function' && window.isMatchComplete()) {
        return;
    }

    // Advance only within the ACTIVE seats (2P: the two chosen seats, 4P: all four).
    const active = getActiveSeats();
    let nextIndex = (active.indexOf(currentTurn) + 1) % active.length;
    currentTurn = active[nextIndex];
    console.log(`[GFG LUDO] Turn pass -> ${currentTurn} | activeSeats=${active.join(',')} | prevRolled=${lastDiceRoll1}+${lastDiceRoll2} | mode=${playerProfiles[currentTurn] ? playerProfiles[currentTurn].mode : '?'}`);

    // ENDGAME auto-skip: a finished seat (all 4 tokens off the board) has its
    // turn auto-passed (~1.5s log) with NO dice roll and NO tap — for human
    // AND computer seats alike. No skip-remaining toggle; End Match is the
    // only speed escape hatch (per the locked spec).
    if (typeof window.isSeatFinished === 'function' && window.isSeatFinished(currentTurn)) {
        console.log(`[GFG LUDO] Seat ${currentTurn} finished (all tokens home) - auto-skipping its turns.`);
        displayEducationalLog(`${currentTurn.toUpperCase()}: All tokens home - auto-skipping turn.`);
        if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            passTurnSequence();
        }, 1500);
        return;
    }

    isDiceRolled = false; 
    hasRolledThisTurn = false; 
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0; 
    lastDiceRoll2 = 0; 
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0; 
    if (typeof hideVerifyLink === 'function') hideVerifyLink(); 

    // arc2m1 solo turn timer: every new solo turn starts its own 45s window.
    armSoloTurnDeadline(); 

    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }
    
    displayEducationalLog(`${currentTurn.toUpperCase()}: New turn sequence initiated. Roll dice.`);
    if (typeof drawLudoLayout === 'function') drawLudoLayout(); 

    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1500);
    }
}

// The zero-lives centre overlay (persistent, no auto-dismiss). Shown when a
// match cannot start because lives are used up, and auto-shown right after a
// completed match the moment the meter reaches 0 (Play Again then cannot
// bypass the limit — the life was already consumed and the bar re-rendered).
window.showLivesBlocked = function (show) {
    const ov = document.getElementById('lives-blocked-overlay');
    if (!ov) return;
    if (show) {
        ov.style.display = 'flex';
        startLivesCountdown();
    } else {
        ov.style.display = 'none';
    }
};

// Live HH:MM:SS countdown to the lives reset (GMT midnight) shown on the
// zero-lives overlay — one second tick, reads gfgLives.get().resetsInMs.
let livesCountdownTimer = null;
function startLivesCountdown() {
    if (livesCountdownTimer) return;
    const el = document.getElementById('lives-reset-countdown');
    if (el) {
        const ms = window.gfgLives && typeof window.gfgLives.get === 'function'
            ? (window.gfgLives.get().resetsInMs || 0) : 0;
        const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
        el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    livesCountdownTimer = setInterval(() => {
        const e2 = document.getElementById('lives-reset-countdown');
        if (!e2 || !document.getElementById('lives-blocked-overlay') ||
            document.getElementById('lives-blocked-overlay').style.display === 'none') {
            clearInterval(livesCountdownTimer); livesCountdownTimer = null; return;
        }
        const ms = window.gfgLives && typeof window.gfgLives.get === 'function'
            ? (window.gfgLives.get().resetsInMs || 0) : 0;
        const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
        e2.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }, 1000);
}

// Auto-show the zero-lives overlay after the ceremony if the meter just hit 0.
function maybeBlockOnZeroLives() {
    try {
        if (window.gfgLives && typeof window.gfgLives.get === 'function') {
            const lives = window.gfgLives.get();
            if (lives && lives.livesLeft <= 0 && typeof window.showLivesBlocked === 'function') {
                setTimeout(function () { window.showLivesBlocked(true); }, 400);
            }
        }
    } catch (e) { /* ignore */ }
}

// ===== ENDGAME (M1 locked spec) =====
// Called by win-detection.js the moment ALL active seats are finished. Stops
// the loop, locks every action and hands control to the result ceremony.
window.markMatchOver = function () {
    matchOver = true;
    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = false;
    currentTurnMoves = [];
    console.log(`[GFG LUDO] Match over (all active seats finished). Loop stopped, result ceremony starts.`);
    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = true;
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// The result ceremony overlay: 1st..4th finish order + "Play Again".
window.showResultCeremony = function () {
    const overlay = document.getElementById('result-ceremony-overlay');
    if (!overlay) return;

    const order = (typeof window.getFinishOrder === 'function') ? window.getFinishOrder() : [];
    const listEl = document.getElementById('result-ceremony-list');
    if (listEl) {
        const medals = ['🥇', '🥈', '🥉', '4'];
        listEl.innerHTML = order.map((color, i) => {
            const medal = medals[i] || (i + 1);
            const isUser = window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].isUser === true;
            const label = isUser ? 'You' : (window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].mode === 'human' ? 'Human' : 'Computer');
            const name = color.charAt(0).toUpperCase() + color.slice(1);
            return `<div class="ceremony-row"><span class="ceremony-medal">${medal}</span><span class="ceremony-seat" style="color:${colorsMap[color]}">${name}</span><span class="ceremony-actor">${label}</span></div>`;
        }).join('');
    }

    const msgEl = document.getElementById('result-ceremony-msg');
    if (msgEl) {
        const winner = order && order[0];
        const winnerIsUser = winner && window.playerProfiles && window.playerProfiles[winner] && window.playerProfiles[winner].isUser === true;
        msgEl.innerText = winnerIsUser
            ? 'You win! Match complete.'
            : 'Match complete.';
    }

    // On-chain game record line. The full 1st..4th finish order is committed
    // to the player's on-chain result PDA (gasless ER write, initiated in
    // win-detection.js). ER tx receipts aren't indexed by public explorers, so
    // we show a truthful status with a copyable receipt and, when the relay
    // freshly created the result account this session, a working devnet link
    // to that base-layer tx (proves the account exists on-chain).
    const proofEl = document.getElementById('result-ceremony-proof');
    if (proofEl) {
        proofEl.innerHTML = '';
        const renderOnchainGameRecordLine = function (sig) {
            if (!proofEl) return;
            if (sig) {
                const receipt = typeof sig === 'string' ? sig : '';
                            // Arc: the match is a leaf in the batched settlement window. Show the
            // honest pending state, then the on-chain proof once the window flushes.
            if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                proofEl.innerHTML = '<span class="ceremony-proof-status">Match queued for the Arc settlement window. It becomes verifiable on-chain when the window flushes (100 games or 24h, and the dashboard can flush it sooner).</span>';
                try {
                    var __mr = (typeof window.gfgGameMatchRef !== 'undefined' && window.gfgGameMatchRef) ? window.gfgGameMatchRef : Date.now();
                    window.gfgChain.batchProof(__mr).then(function (bp) {
                        if (bp && bp.ok && bp.valid) {
                            proofEl.innerHTML = '<span class="ceremony-proof-status">Verified on-chain in the Arc settlement window (Merkle root ' + String(bp.root).slice(0, 14) + '…, proof valid).</span>';
                        }
                    }).catch(function () { /* stays pending */ });
                } catch (e) { /* stays pending */ }
                return;
            }
proofEl.innerHTML = '<span class="ceremony-proof-status">Whole match committed to the on-chain record (' + (window.gfgChain ? window.gfgChain.shortLabel() : 'on-chain') + ').</span>'
                    + (receipt ? '<span class="ceremony-proof-receipt">Receipt: <code class="ceremony-proof-sig" title="Click to copy">' + receipt + '</code></span>' : '')
                    + (receipt ? ' <span class="ceremony-proof-status"><a href="/verify/?tx=' + encodeURIComponent(receipt) + '" target="_blank" rel="noopener noreferrer" style="color:#f87818;text-decoration:underline;">See on-chain receipt</a></span>' : '');
                const sigCode = proofEl.querySelector('.ceremony-proof-sig');
                if (sigCode) {
                    sigCode.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(receipt).catch(function () {});
                        }
                    });
                }
            } else {
                proofEl.innerHTML = '<span class="ceremony-proof-status">Match result recorded. On-chain commit pending (receipt unavailable this session).</span>';
            }
            // Solana-only onboarding/record links. On Arc none of this applies
            // (Arc has real explorer links per transaction instead), so the game
            // never shows a Solana/devnet reference while running on Arc.
            const isArc = !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc());
            const resultDelegateSig = (!isArc && window.magicblockDice && typeof window.magicblockDice.getLastResultDelegationSignature === 'function')
                ? window.magicblockDice.getLastResultDelegationSignature() : null;
            if (resultDelegateSig && window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                proofEl.innerHTML += ' <span class="ceremony-proof-status">Game record account created on devnet: ' + window.gfgExplorer.txLink(resultDelegateSig, 'view tx') + '.</span>';
            }
            const diceDelegateSig = (!isArc && window.magicblockDice && typeof window.magicblockDice.getLastDiceDelegationSignature === 'function')
                ? window.magicblockDice.getLastDiceDelegationSignature() : null;
            if (diceDelegateSig && window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                proofEl.innerHTML += ' <span class="ceremony-proof-status">Dice account created and delegated on devnet (sponsored once by GlobalFolkGames, every roll afterwards ran free on the ER): ' + window.gfgExplorer.txLink(diceDelegateSig, 'view onboarding tx') + '.</span>';
            }
        };
        if (window.__onchainGameRecordPromise) {
            proofEl.innerHTML = '<span class="ceremony-proof-status">Whole match: committing to the on-chain game record...</span>';
            window.__onchainGameRecordPromise
                .then(renderOnchainGameRecordLine)
                .catch(() => renderOnchainGameRecordLine(null));
        } else {
            renderOnchainGameRecordLine(null);
        }
    }

    // M3 — on-chain award line. The local-points module banks the 'You' seat's
    // award gasless on the ER right after the seam fires. NEVER promise points
    // that have not landed: while the write is in flight we only say the
    // amount is "loading... don't refresh" (no banked claim), a failed write
    // shows a neutral pending line with NO amount, and the definitive
    // "+N banked on-chain" line appears ONLY once the award is confirmed.
    const ptsEl = document.getElementById('result-ceremony-points');
    if (ptsEl) {
        ptsEl.style.display = 'none';
        const showAward = function (award) {
            if (!award || award.gameTag !== 'ludo' || !award.points) return;
            if (award.status === 'banking') {
                ptsEl.innerHTML = '+' + award.points + ' Ludo points loading... don\u2019t refresh the page (confirming on-chain)';
            } else if (award.status === 'failed') {
                ptsEl.innerHTML = 'Points pending (on-chain write hiccup, will re-sync automatically).';
            } else {
                ptsEl.innerHTML = '+' + award.points + ' Ludo points banked on-chain'
                    + (award.position === 1 ? ' 🏆' : '');
            }
            ptsEl.style.display = 'block';
        };
        if (window.localPoints) {
            const recent = window.localPoints.lastAward;
            if (recent && Date.now() - recent.at < 15000) {
                showAward(recent);
            } else if (typeof window.localPoints.subscribe === 'function') {
                const off = window.localPoints.subscribe(function (gameTag, ledger, award) {
                    if (award) {
                        showAward(award);
                        // Terminal states (banked / failed) stop the listener;
                        // 'banking' keeps listening for the outcome.
                        if (award.status !== 'banking') off();
                    }
                });
                // If the bank already happened before we subscribed (fast path),
                // grab the latest award without waiting for the next one.
                setTimeout(function () {
                    const cur = window.localPoints.lastAward;
                    if (cur && Date.now() - cur.at < 15000) { showAward(cur); off(); }
                }, 1500);
            }
        }
    }

    // M4 credit line (mirror of the M3 award line: banking / neutral pending /
    // '+N global points banked on-chain', never-promise rule). Separate element
    // so the platform-wide ledger (M4) and the per-game ledger (M3) stay
    // distinct in the ceremony.
    const gEl = document.getElementById('result-ceremony-global');
    if (gEl) {
        gEl.style.display = 'none';
        const showCredit = function (credit) {
            if (!credit || credit.points <= 0) return;
            if (credit.status === 'banking') {
                gEl.innerHTML = '+' + credit.points + ' global points loading... don\u2019t refresh the page (confirming on-chain)';
            } else if (credit.status === 'failed') {
                gEl.innerHTML = 'Global points pending (on-chain write hiccup, will re-sync automatically).';
            } else {
                gEl.innerHTML = '+' + credit.points + ' global points banked on-chain';
            }
            gEl.style.display = 'block';
        };
        if (window.globalLedger) {
            const recentCredit = window.globalLedger.lastCredit;
            if (recentCredit && Date.now() - recentCredit.at < 15000) {
                showCredit(recentCredit);
            } else if (typeof window.globalLedger.subscribe === 'function') {
                const off = window.globalLedger.subscribe(function (ledger, credit) {
                    if (credit) {
                        showCredit(credit);
                        if (credit.status !== 'banking') off();
                    }
                });
                setTimeout(function () {
                    const cur = window.globalLedger.lastCredit;
                    if (cur && Date.now() - cur.at < 15000) { showCredit(cur); off(); }
                }, 1500);
            }
        }
    }

    overlay.classList.add('visible');

    // If this completed match used the last life, block Replay (persistent).
    maybeBlockOnZeroLives();
};

// "Play Again": start a fresh match with the SAME locked seat setup (no
// re-lock, no reload). Clears the finish order + match-over state, resets the
// board and drops straight back to the first turn.
window.playAgainAfterCeremony = function () {
    const overlay = document.getElementById('result-ceremony-overlay');
    if (overlay) overlay.classList.remove('visible');
    const proofEl = document.getElementById('result-ceremony-proof');
    if (proofEl) proofEl.innerHTML = '';
    const gProofEl = document.getElementById('result-ceremony-global');
    if (gProofEl) gProofEl.innerHTML = '';
    window.__onchainGameRecordPromise = null;
    window.__lastOnchainGameRecordSig = null;
    if (window.localPoints && typeof window.localPoints.clearTransient === 'function') {
        window.localPoints.clearTransient();
    }
    if (window.globalLedger && typeof window.globalLedger.clearTransient === 'function') {
        window.globalLedger.clearTransient();
    }

    if (typeof window.resetWinDetection === 'function') window.resetWinDetection();
    if (typeof resetOnchainProofRollUsed === 'function') resetOnchainProofRollUsed();
    matchOver = false;
    currentTurn = 'green';
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0;
    if (typeof hideVerifyLink === 'function') hideVerifyLink();

    // Reset every token back to its home yard slot.
    Object.keys(window.tokens).forEach(color => {
        const home = HOME_YARDS[color];
        window.tokens[color].forEach((token, idx) => {
            token.pathIndex = -1;
            token.stepsWalked = 0;
            if (home && home[idx]) {
                token.c = home[idx].c;
                token.r = home[idx].r;
            }
        });
    });

    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }

    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = false;

    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
    if (typeof drawLudoLayout === 'function') drawLudoLayout();

    displayEducationalLog(`${currentTurn.toUpperCase()}: New match started. Roll dice.`);
    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1200);
    }
};

// End Match / ABANDONED: closes the match in game state as status=abandoned
// (never rewarded, never emits the seam), then clears the cached board.
window.endMatchAbandon = function () {
    if (typeof window.setMatchStatus === 'function') {
        window.setMatchStatus('abandoned');
    }
    matchOver = true;
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    const overlay = document.getElementById('result-ceremony-overlay');
    if (overlay) overlay.classList.remove('visible');

    // Best-effort on tab close: clear the cached board so no stale match
    // resumes, then reload to the fresh setup.
    localStorage.removeItem('gfg_ludo_lab_persistence_state');
    displayEducationalLog('MATCH ABANDONED: Match closed as abandoned (never rewarded).');
    setTimeout(() => window.location.reload(), 500);
};

// REFRESH-SAFE RESUME: no `beforeunload` abandonment. A reload mid-match must
// resume the exact same board (the stale-match clear lives in persistence.js:
// only an in-progress match untouched for 24h+ is treated as abandoned).

document.addEventListener('DOMContentLoaded', () => {
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
            selectElement.addEventListener('change', (e) => {
                if (e.target.value === 'you') {
                    // A new seat became the user seat — release any previous one.
                    turnSequence.forEach(c => {
                        if (c !== color && playerProfiles[c].isUser) {
                            playerProfiles[c].isUser = false;
                            const prevEl = document.getElementById(`type-${c}`);
                            if (prevEl) prevEl.value = playerProfiles[c].mode;
                        }
                    });
                    playerProfiles[color].mode = 'human';
                    playerProfiles[color].isUser = true;
                } else {
                    playerProfiles[color].mode = e.target.value;
                    playerProfiles[color].isUser = false;
                }
                if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
            });
        }
    });

    setTimeout(() => {
        // ANTI-CHEAT (owner 2026-09-21): never resume a saved match when nobody
        // is signed in. Otherwise a logged-out page would keep playing an
        // already-started board (free unlimited play). Signed out = fresh setup.
        var _signedIn = false;
        try {
            if (window.currentUser) _signedIn = true;
            else {
                var _a = window.gfgChainAdapter;
                if (_a && typeof _a.walletAddress === 'function' && _a.walletAddress()) _signedIn = true;
                else if (typeof window.getDynamicSolanaWallet === 'function' && window.getDynamicSolanaWallet()) _signedIn = true;
                else if (typeof window.getDynamicEvmWallet === 'function' && window.getDynamicEvmWallet()) _signedIn = true;
            }
        } catch (e) { _signedIn = false; }
        if (!_signedIn) {
            if (typeof window.clearPersistedState === 'function') { try { window.clearPersistedState(); } catch (e) {} }
            displayEducationalLog("Sign in to start a match. Ready for fresh setup.");
            return;
        }
        if (typeof loadGameStateFromStorage === 'function') {
            const stateFound = loadGameStateFromStorage();
            if (!stateFound) {
                displayEducationalLog("PERSISTENCE: Ready for fresh match setup.");
            }
        }
    }, 200);
});
