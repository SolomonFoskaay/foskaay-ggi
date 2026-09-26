// Dice source indicator: 'onchain' (MagicBlock ER VRF on Solana) or 'offchain' (local)
let activeDiceSource = 'offchain';

// Provably-fair roll policy (Scope A): EVERY dice roll resolves on the
// MagicBlock ER VRF (gasless, fast queue):
//   - the signed-in player's seat ("You") rolls via the player's own delegated
//     dice PDA on every turn;
//   - computer seats roll via the server-side house key (POST /api/roll),
//     which is also delegated once and rolls gasless on the same ER queue;
//   - there is NO offline fallback for core dice: a failed roll is retried,
//     and if the chain is genuinely down the match pauses with a banner and
//     auto-resumes (with an alert) once the on-chain network returns.
// The flag is set when any on-chain roll succeeds; the last on-chain roll's
// signature is the verifiable proof of play used by the win-reward gate.
let onchainProofRollUsedThisMatch = false;
let lastProofRollSignature = null;

// Reward gates: the Ludo win-detector uses these to confirm the proof-of-play
// before awarding the +100 points for a 1st-place user finish.
window.getOnchainProofUsedThisMatch = () => onchainProofRollUsedThisMatch;
window.getLastProofRollSignature = () => lastProofRollSignature;

// Called by the match-start flow (turn.js lockSetupDropdowns) when a NEW match
// begins, so each match gets exactly one fresh proof roll.
function resetOnchainProofRollUsed() {
    onchainProofRollUsedThisMatch = false;
}

// Bracket tag shown in the Ludo log + console so players know where the
// CURRENT dice click was resolved: on-chain (MagicBlock ER VRF on Solana) or not.
function currentDiceSourceTag() {
    // Chain-correct label: on Arc it must say Arc, never Solana.
    return activeDiceSource === 'onchain'
        ? '[' + (window.gfgChain ? window.gfgChain.label() : 'On-Chain') + ']'
        : '[Off-Chain Local Randomness]';
}

// === On-chain outage handling (no offline fallback) ===
// If the roll cannot be resolved on-chain we retry a few times, then PAUSE the
// match with a visible banner instead of ever rolling locally. An 8s monitor
// pings the stack; when the network returns we alert and auto-resume the
// paused turn (computer seats re-trigger, the human's turn gets re-armed).
const MAX_ROLL_ATTEMPTS = 3;
const ONCHAIN_RETRY_DELAY_MS = 1500;
const CHAIN_MONITOR_INTERVAL_MS = 20000;

let isChainDown = false;
let chainMonitorTimer = null;

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Renders a clickable "verify on-chain" link under the dice row. Cleared by
// each new turn (passTurnSequence) via hideVerifyLink().
function showVerifyLink(linkHtml) {
    if (!linkHtml) return;
    const el = document.getElementById('verify-tx-link');
    if (!el) return;
    el.innerHTML = linkHtml;
    el.style.display = 'block';
}

function hideVerifyLink() {
    const el = document.getElementById('verify-tx-link');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
}

function showChainDownBanner(message, persistent = false) {
    try {
        if (typeof window.showAuthBanner === 'function') window.showAuthBanner(message, true);
        ensureChainBannerElement();
        const el = document.getElementById('chain-down-banner');
        if (!el) return;
        el.textContent = '';
        el.classList.toggle('persistent', persistent);

        const msg = document.createElement('span');
        msg.textContent = message;
        el.appendChild(msg);

        // Manual escape hatch: even if the 8s auto-monitor keeps failing, the
        // player can force a fresh connectivity check at any moment. If the
        // stack is still unreachable the button refreshes the page so the
        // persisted paused match re-establishes fresh RPC connections.
        if (!document.getElementById('chain-retry-btn')) {
            const retryBtn = document.createElement('button');
            retryBtn.id = 'chain-retry-btn';
            retryBtn.textContent = 'Refresh';
            retryBtn.addEventListener('click', () => {
                if (typeof retryChainNow === 'function') retryChainNow();
            });
            el.appendChild(retryBtn);
        }
        el.style.display = 'block';
    } catch (e) { /* banner is cosmetic - never break the game */ }
}

function ensureChainBannerElement() {
    try {
        if (document.getElementById('chain-down-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'chain-down-banner';
        banner.className = 'chain-down-banner';
        document.body.appendChild(banner);
    } catch (e) { /* DOM not ready / stubbed */ }
}

function hideChainDownBanner() {
    const el = document.getElementById('chain-down-banner');
    if (el) el.style.display = 'none';
}

async function pingOnchainStack() {
    try {
        if (window.gfgChain && typeof window.gfgChain.ping === 'function') {
            return await window.gfgChain.ping();
        }
    } catch (e) {
        console.warn('[chain] ping failed:', e);
    }
    // Fallback: if the VRF ping helper is not ready yet, probe the relay's
    // passive health route (never triggers a roll).
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('/api/endpoints', { signal: ctrl.signal });
        clearTimeout(timer);
        return res.ok;
    } catch (e) {
        return false;
    }
}

// Exposed for diagnostics / boot-time verification of the pause state.
window.getChainDownState = function () { return isChainDown; };
window.setChainDownState = function (v) { isChainDown = !!v; };

// Pause the ongoing turn (do NOT consume it) until the on-chain stack returns.
function enterChainDownState() {
    if (isChainDown) return;
    isChainDown = true;

    // Give back the turn so a roll can re-trigger when the network returns.
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    currentTurnMoves = [];
    if (typeof hideVerifyLink === 'function') hideVerifyLink();
    console.warn(`[GFG LUDO] On-chain dice unreachable - match PAUSED (no fake local roll). Attempts exhausted for seat ${currentTurn}.`);

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Awaiting network';
    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = true;

    ensureChainBannerElement();
    showChainDownBanner('On-chain dice are unreachable. Your match is paused so nothing is falsely recorded. It resumes automatically, or press Refresh once your internet is back.', true);
    displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice unreachable. Match paused - will auto-resume when the network is back.`);

    // Persist the paused (pre-roll) state so a REFRESH during the outage
    // resumes into this same paused state instead of a broken or fresh match.
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    if (!chainMonitorTimer) {
        chainMonitorTimer = setInterval(async () => {
            const ok = await pingOnchainStack();
            if (!ok || !isChainDown) return;
            resumeFromChainDown();
        }, CHAIN_MONITOR_INTERVAL_MS);
    }
    return;
}

// Shared recovery path used by the auto-monitor, the banner's Retry button and
// the boot-time probe once the on-chain stack answers again.
function resumeFromChainDown() {
    if (!isChainDown) return;
    if (chainMonitorTimer) {
        clearInterval(chainMonitorTimer);
        chainMonitorTimer = null;
    }
    isChainDown = false;
    hideChainDownBanner();
    console.log(`[GFG LUDO] On-chain stack recovered - resuming the paused turn (seat ${currentTurn}).`);
    if (typeof window.showAuthBanner === 'function') {
        window.showAuthBanner('On-chain dice are back. Resuming your match.');
    }
    displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice are back. Resuming...`);
    const btn2 = document.getElementById('diceBtn');
    if (btn2) btn2.disabled = false;

    // Retry anything that could not be pushed on-chain while we were offline.
    if (typeof window.flushPendingPushes === 'function') {
        try { window.flushPendingPushes(); } catch (e) { console.warn('[persistence] pending-push flush failed:', e); }
    }

    setTimeout(() => {
        if (isGamePaused || isChainDown || matchOver) return;
        if (playerProfiles[currentTurn] && playerProfiles[currentTurn].mode === 'computer') {
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        } else {
            if (typeof rollDiceEngine === 'function') rollDiceEngine();
        }
    }, 1200);
}

// Banner Refresh button: force a connectivity check right now. When the stack
// is back this resumes immediately; when it is still unreachable the page is
// reloaded so the persisted paused match re-establishes fresh RPC connections
// (the restored chain-down state re-arms the banner + monitor, see
// rearmChainDownState).
async function retryChainNow() {
    const ok = await pingOnchainStack();
    if (ok && isChainDown) {
        resumeFromChainDown();
    } else if (!ok) {
        displayEducationalLog(`${currentTurn.toUpperCase()}: Still offline - refreshing to re-connect.`);
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Still offline. Refreshing to re-connect...');
        }
        setTimeout(() => window.location.reload(), 600);
    }
}

// Re-arm the on-chain outage pause after a refresh that happened during an
// outage. persistence restore calls this when the saved payload was chain-down
// so the banner + monitor come back and the match stays paused until recovery.
window.rearmChainDownState = function () {
    isChainDown = false; // clear so enterChainDownState() can re-enter fresh
    enterChainDownState();
};

// The banner + pause ONLY ever appears when a real on-chain roll attempt has
// actually failed (see rollDiceEngine / enterChainDownState). There is NO
// boot-time probe: a ping check right after a reload gave false "outage"
// pauses even when internet was fine (a slow/blocked RPC from the player's
// network read as "down"), and the banner stuck around forever. Recovery is
// still fully covered: the monitor, the banner's Retry button and the saved
// pre-roll state all share resumeFromChainDown().
window.retryChainNow = retryChainNow;
window.resumeFromChainDown = resumeFromChainDown;

async function rollDiceEngine(source) {
    if (!setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match inactive. Click 'Start Arena Match' button first.");
        return;
    }

    if (typeof matchOver !== 'undefined' && matchOver) return;

    // MULTIPLAYER GUARD (additive; solo unaffected): when a multiplayer match is
    // active and it is the REMOTE seat's turn (not our seat), do not roll here -
    // the remote player rolls + commits that roll; this device waits for the
    // commit and applies it. Prevents two devices from rolling divergent dice.
    // The warning mirrors the single-player computer anti-cheat: interference is
    // ignored. gfgRemoteTurn() is false when the rail is idle, so solo is safe.
    try {
        if (typeof window.gfgRemoteTurn === 'function' && window.gfgRemoteTurn()) {
            displayEducationalLog("ANTI-CHEAT: It is the other player's turn - you cannot roll. Waiting for their move...");
            return;
        }
    } catch (e) { /* soft */ }

    if (isGamePaused) {
        displayEducationalLog("PAUSED: Match is suspended. Click 'Resume' to continue.");
        return;
    }

    if (playerProfiles[currentTurn].mode === 'computer' && source !== 'AI_CONFIRMED') {
        displayEducationalLog(`ANTI-CHEAT: Automated computer turn loop active. Manual bypass blocked.`);
        return;
    }

    // 2P fix: AI_CONFIRMED is only ever legitimate on a computer seat. A stale
    // automated timer firing on a human seat must be rejected, not honoured.
    if (source === 'AI_CONFIRMED' && playerProfiles[currentTurn].mode !== 'computer') {
        displayEducationalLog(`ANTI-CHEAT: Automated roll requested for a human seat. Blocked.`);
        return;
    }

    if (isDiceRolled && hasRolledThisTurn) return;

    // On-chain outage pause: never consume the turn nor roll locally.
    if (isChainDown) {
        displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice are down. Waiting for the network to recover...`);
        return;
    }

    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = true;
    activeDiceSource = 'offchain'; // reset until the VRF path confirms otherwise
    console.log(`[GFG LUDO] Roll requested | seat=${currentTurn} | mode=${playerProfiles[currentTurn].mode} | source=${source || 'manual'} | userSeat=${playerProfiles[currentTurn].isUser}`);

    // Persist immediately so a page reload during the (up to ~1.3s) on-chain
    // round trip resumes with "rolled, awaiting result" instead of re-rolling.
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Rolling...';
    displayEducationalLog(`${currentTurn.toUpperCase()}: Rolling dice...`);

    // === PROVABLY-FAIR DICE (every roll, every seat — NO offline fallback) ===
    // Scope A: ALL dice now resolve on the MagicBlock ER VRF (fast, gasless
    // queue):
    //   - "You" (signed-in user): every roll via the player's own delegated
    //     dice PDA (session key signs silently).
    //   - Every other seat (computers + any extra local human): the server's
    //     house key rolls via POST /api/roll (sponsored+delegated once; the
    //     key never leaves the server). Result carries roll1/roll2/seed/sig.
    // If VRF / the relay is unreachable the roll is retried a few times; if it
    // is STILL down the match pauses (banner + monitor) and auto-resumes when
    // the on-chain network returns. Play NEVER falls back to local randomness.
    const isUserSeat = playerProfiles[currentTurn] && playerProfiles[currentTurn].isUser === true;
    let rollValues = null;
    for (let attempt = 1; attempt <= MAX_ROLL_ATTEMPTS && !rollValues; attempt++) {
        if (attempt > 1) await sleepMs(ONCHAIN_RETRY_DELAY_MS);
        // On Arc EVERY seat (user AND computer) rolls through the gasless
        // committed-seed derivation (gfgChain.roll -> relayer rollDice). The
        // old `isUserSeat && gfgChain.available()` guard sent the user seat
        // down the Solana SDK path on Arc too (available() returns true there),
        // which was the last Solana write in the game. Route the user seat to
        // the Arc branch as the COMPUTER branch already does.
        const onArc = !!(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc());
        if (isUserSeat && window.gfgChain && window.gfgChain.available() && !onArc) {
            try {
                if (totalDisplay) totalDisplay.innerText = 'VRF roll...';
                displayEducationalLog(`${currentTurn.toUpperCase()}: Requesting provably-fair roll [${window.gfgChain.label()}]...`);
                const v = await window.gfgChain.roll();
                if (Array.isArray(v) && v.length === 2) {
                    rollValues = v;
                    activeDiceSource = 'onchain';
                    onchainProofRollUsedThisMatch = true;
                    lastProofRollSignature = (window.gfgChain && window.gfgChain.getLastProofRollSignature)
                        ? window.gfgChain.getLastProofRollSignature() : null;
                    console.log(`[${window.gfgChain.label()}] Your roll resolved on-chain: ${rollValues[0]} + ${rollValues[1]}`);
                    console.log(`[Proof roll TX] ${lastProofRollSignature}`);
                    displayEducationalLog(`${currentTurn.toUpperCase()}: VRF roll ${rollValues[0]} + ${rollValues[1]} ${currentDiceSourceTag()}`);
                    // ER rollup tx signatures are NOT indexed by any public
                    // explorer (SolanaFM / Solana explorer only see the base
                    // chain + settlement), so a per-roll explorer link would
                    // always 404. We verify honestly instead: the roll happened
                    // on-chain via the ER VRF, and the base-layer tx that
                    // created+delegated this player's dice account IS
                    // devnet-visible, so we link that as the real proof.
                    let userVerifyLine = `${currentTurn.toUpperCase()}: roll resolved on-chain (${window.gfgChain ? window.gfgChain.shortLabel() : 'on-chain'})`;
                    const diceDelegateSig = (window.gfgChain && typeof window.gfgChain.getLastDiceDelegationSignature === 'function')
                        ? window.gfgChain.getLastDiceDelegationSignature() : null;
                    if (diceDelegateSig && !(window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) && window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                        userVerifyLine += ` - dice account delegated on devnet: ${window.gfgExplorer.txLink(diceDelegateSig, 'view tx')}`;
                    }
                    showVerifyLink(userVerifyLine);
                    // M12 live dice broadcast: tell the multiplayer adapter the
                    // dice just resolved so the opponent sees them + the board in
                    // real time (advance=false; the turn does not flip yet).
                    try {
                        if (window.gfgLudoAdapter && typeof window.gfgLudoAdapter.onDiceRoll === 'function' && window.gfgLudoAdapter.isActive && window.gfgLudoAdapter.isActive()) {
                            window.gfgLudoAdapter.onDiceRoll(rollValues[0], rollValues[1]);
                        }
                    } catch (e) { /* soft */ }
                }
            } catch (err) {
                console.error(`[ER VRF] roll attempt ${attempt}/${MAX_ROLL_ATTEMPTS} failed (retrying):`, err);
                rollValues = null;
            }
        } else {
            // Non-user seat (computer, or an extra local human): house roll.
            try {
                if (window.gfgChain && window.gfgChain.isArc && window.gfgChain.isArc()) {
                    // Arc rail: the house/AI roll derives from the SAME committed
                    // window seed as the player's roll, through the self-hosted
                    // relayer (never the Solana /api/roll). Distinct counter, so
                    // every seat's roll is a distinct gasless derivation.
                    if (totalDisplay) totalDisplay.innerText = 'on-chain roll...';
                    const hv = await window.gfgChain.roll();
                    if (hv && hv.length === 2 && Number.isInteger(hv[0]) && Number.isInteger(hv[1])) {
                        rollValues = [hv[0], hv[1]];
                        activeDiceSource = 'onchain';
                        console.log(`[${window.gfgChain.label()}] Computer roll resolved on-chain: ${hv[0]} + ${hv[1]}`);
                        displayEducationalLog(`${currentTurn.toUpperCase()}: VRF computer roll ${hv[0]} + ${hv[1]} [${window.gfgChain.label()}]`);
                        showVerifyLink(`${currentTurn.toUpperCase()}: house roll resolved on-chain (${window.gfgChain.shortLabel()})`);
                    }
                } else {
                if (totalDisplay) totalDisplay.innerText = 'VRF roll...';
                const res = await fetch('/api/roll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && Number.isInteger(data.roll1) && Number.isInteger(data.roll2)) {
                        rollValues = [data.roll1, data.roll2];
                        activeDiceSource = 'onchain';
                        console.log(`[${window.gfgChain ? window.gfgChain.label() : 'On-Chain'}] Computer roll resolved on-chain: ${data.roll1} + ${data.roll2} (seed ${data.seed})`);
                        console.log(`[Computer roll TX] ${data.signature}`);
                        displayEducationalLog(`${currentTurn.toUpperCase()}: VRF computer roll ${data.roll1} + ${data.roll2} [${window.gfgChain ? window.gfgChain.label() : 'On-Chain'}]`);
                        // Same honest verification as the user seat: the ER
                        // rollup's tx sigs 404 on every public explorer, so no
                        // fake per-roll link. The house dice account is
                        // sponsored + delegated server-side (key never leaves
                        // the relay), and its rolls run on the same ER queue.
                        showVerifyLink(`${currentTurn.toUpperCase()}: house roll resolved on-chain (MagicBlock ER VRF)`);
                    }
                }
                } // end Arc house-roll branch
            } catch (err) {
                console.error(`[ER VRF] computer roll attempt ${attempt}/${MAX_ROLL_ATTEMPTS} failed (retrying):`, err);
                rollValues = null;
            }
        }
    }

    // NO local fallback: if every on-chain attempt failed, pause and wait.
    if (!rollValues || rollValues.length !== 2) {
        enterChainDownState();
        return;
    }

    // GFG-BS: record the roll in the OFF-CHAIN match log (zero chain cost). The
    // roll is part of the move digest, so the settlement commits to the dice too.
    try {
        if (window.gfgMatchEngine && window.gfgMatchEngine.isOpen && window.gfgMatchEngine.isOpen()) {
            var _seats = (typeof window.getActiveSeats === 'function') ? window.getActiveSeats() : [];
            var _idx = _seats.indexOf(currentTurn);
            window.gfgMatchEngine.move(_idx >= 0 ? _idx : 0, { roll: [rollValues[0], rollValues[1]], seat: currentTurn });
        }
    } catch (e) { /* soft: never block a roll */ }

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);

    // Dice are locked to the on-chain result (physics snaps to finalValue at rest).
    // Each die starts with a little random 3D tilt (quaternion) so they look
    // thrown, and a natural rattle plays as they fly across the board.
    physicalDice = [
        { x: 200, y: 260, vx: (Math.random() * 14) - 7, vy: (Math.random() * 14) - 7, value: rollValues[0], finalValue: rollValues[0], q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) },
        { x: 310, y: 300, vx: (Math.random() * 14) - 7, vy: (Math.random() * 14) - 7, value: rollValues[1], finalValue: rollValues[1], q: axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, (Math.random() - 0.5) * 0.6) }
    ];
    if (typeof playDiceRattle === 'function') playDiceRattle();

    runDicePhysicsCalculations();
}

function finalizeDiceScores() {
    lastDiceRoll1 = physicalDice[0].value;
    lastDiceRoll2 = physicalDice[1].value;
    let totalSum = lastDiceRoll1 + lastDiceRoll2;

    const d1Box = document.getElementById('val-d1');
    const d2Box = document.getElementById('val-d2');
    const totalBox = document.getElementById('val-total');

    if (d1Box) d1Box.innerText = lastDiceRoll1;
    if (d2Box) d2Box.innerText = lastDiceRoll2;
    if (totalBox) totalBox.innerText = `= Total: ${totalSum}`;

    currentTurnMoves = [lastDiceRoll1, lastDiceRoll2];
    const upperColor = currentTurn.toUpperCase();
    const diceSourceTag = currentDiceSourceTag();

    if (lastDiceRoll1 === 6 && lastDiceRoll2 === 6) {
        consecutiveDoubleSixes++;
        displayEducationalLog(`${upperColor}: Rolled a double 6! Bonus turn loaded. ${diceSourceTag}`);
    } else {
        consecutiveDoubleSixes = 0;
        displayEducationalLog(`${upperColor}: Rolled ${lastDiceRoll1} and ${lastDiceRoll2}. Select a blinking token. ${diceSourceTag}`);
    }

    // Save state once dice scores are finalized
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    setTimeout(() => {
        if (isGamePaused) return; 
        displayDiceOnBoard = false;

        if (!hasAnyValidMoveForCurrentTurn()) {
            displayEducationalLog(`${upperColor}: No valid options available. Resolving turn.`);
            resolveTurnEndAfterMoves();
        } else {
            if (playerProfiles[currentTurn].mode === 'computer') {
                setTimeout(() => {
                    if (isGamePaused) return;
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }, 1500);
            }
            // Dice cleared: redraw now so the settled dice vanish and, for a
            // human seat with valid moves, the movable tokens resume blinking
            // (the idle blink loop otherwise stands down with no redraw).
            if (typeof drawLudoLayout === 'function') drawLudoLayout();
        }
    }, 3500);
}

function hasAnyValidMoveForCurrentTurn() {
    if (!tokens || !tokens[currentTurn]) return false;
    return tokens[currentTurn].some((token, index) => isTokenMovable(currentTurn, token, index));
}