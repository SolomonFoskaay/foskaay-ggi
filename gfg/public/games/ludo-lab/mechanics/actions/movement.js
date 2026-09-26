/**
 * GlobalFolkGames Ludo Module - Token Transformation & Movement Vector Engine
 * Handles user touch inputs, coordinate transformations, and AI move exceptions.
 */

/**
 * Resolve how a turn ends AFTER the rolled moves are spent (or none were usable).
 * "Shoki" double-six rule: the player counts the move as usual, then keeps the
 * turn for a bonus roll — up to THREE double-sixes per turn cycle (1st -> bonus,
 * 2nd -> bonus, 3rd -> pass to the next player). The bonus is granted even if a
 * double-six produced NO usable move, so the rare streak is never silently lost.
 * Non-double-six or a 3rd double-six passes the turn on.
 *
 * HARDENING: the bonus is granted ONLY when the CURRENT roll is literally a
 * double six (lastDiceRoll1===6 && lastDiceRoll2===6). The counter is a
 * secondary streak record; a stale/leaked counter on a random roll (2+6, 3+5,
 * ...) can NEVER grant an extra turn this way. The else branch also force-resets
 * the counter so no stale value survives a pass.
 */
function resolveTurnEndAfterMoves() {
    const upperColor = currentTurn.toUpperCase();
    const isDoubleSixRoll = lastDiceRoll1 === 6 && lastDiceRoll2 === 6;
    console.log(`[GFG LUDO] Turn end | seat=${currentTurn} | isDoubleSix=${isDoubleSixRoll} | consecutiveDoubleSixes=${consecutiveDoubleSixes} | diceUsed=${lastDiceRoll1}+${lastDiceRoll2} | movesLeft=${currentTurnMoves.length}`);
    if (isDoubleSixRoll && consecutiveDoubleSixes > 0 && consecutiveDoubleSixes < 3) {
        displayEducationalLog(`${upperColor}: "Shoki" double six bonus turn! Roll again.`);
        isDiceRolled = false;
        hasRolledThisTurn = false;
        if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

        if (playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (isGamePaused) return;
                if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
            }, 1500);
        }
    } else {
        consecutiveDoubleSixes = 0;
        // M12: a turn that ends with NO move must still be shared on-chain, so
        // the other device learns it is now its turn (byte19 = next seat). If a
        // real move committed this turn, onMove already shared the next turn, so
        // a redundant pass commit is avoided by only firing when no move ran.
        try {
            if (window.gfgLudoAdapter && typeof window.gfgLudoAdapter.isActive === 'function' && window.gfgLudoAdapter.isActive()) {
                if (typeof window.gfgLudoAdapter.onPassTurn === 'function') {
                    window.gfgLudoAdapter.onPassTurn();
                }
            }
        } catch (e) { /* soft */ }
        setTimeout(() => {
            if (isGamePaused) return;
            passTurnSequence();
        }, 500);
    }
}

function handleInputInteraction(clientX, clientY) {
    if (isGamePaused) return;
    if (typeof matchOver !== 'undefined' && matchOver) return;
    if (playerProfiles[currentTurn].mode === 'computer') return;
    // M12 multiplayer: a REMOTE player's turn shows their moveable tokens
    // blinking (core isTokenMovable) but is NOT clickable here - same rule as a
    // single-player computer turn. Tapping the remote player's blinking tokens
    // (or rolling for them) shows the anti-cheat warning and is ignored.
    // gfgRemoteTurn() is false in single-player, so this never affects it.
    try {
        if (typeof window.gfgRemoteTurn === 'function' && window.gfgRemoteTurn()) {
            displayEducationalLog('ANTI-CHEAT: It is the other player\u2019s turn - you cannot move their tokens.');
            return;
        }
    } catch (e) { /* soft */ }

    if (!isDiceRolled || currentTurnMoves.length === 0) return;
    // Anti-race guard (owner 2026-08-31): no token taps while the dice are
    // still on the board. This is the same gate isTokenMovable now enforces,
    // kept here so the click path can never bypass it (defense in depth).
    if (typeof displayDiceOnBoard !== 'boolean' || displayDiceOnBoard) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = ((clientX - rect.left) / rect.width) * canvas.width;
    const mouseY = ((clientY - rect.top) / rect.height) * canvas.height;

    const clickedCol = Math.floor(mouseX / CELL_SIZE);
    const clickedRow = Math.floor(mouseY / CELL_SIZE);

    let activeTokens = tokens[currentTurn];
    
    let selectedTokenIndex = activeTokens.findIndex((token, idx) => {
        if (token.stepsWalked >= 57) return false; 
        return token.c === clickedCol && token.r === clickedRow && isTokenMovable(currentTurn, token, idx);
    });

    if (selectedTokenIndex !== -1) {
        processTokenMovementExecution(selectedTokenIndex);
    }
}

function processTokenMovementExecution(selectedTokenIndex) {
    const upperColor = currentTurn.toUpperCase();
    let activeTokens = tokens[currentTurn];
    let currentPiece = activeTokens[selectedTokenIndex];
    let isInsideYard = isTokenInHomeYard(currentTurn, currentPiece);
    let appliedMoveValue = isInsideYard ? 6 : (currentTurnMoves.includes(6) ? 6 : currentTurnMoves[0]);
    console.log(`[GFG LUDO] Move executed | seat=${currentTurn} | tokenIndex=${selectedTokenIndex} | inYard=${isInsideYard} | value=${appliedMoveValue} | diceLeft=[${currentTurnMoves.join(',')}] | stepsWalked=${currentPiece.stepsWalked}`);

    if (isInsideYard) {
        currentPiece.pathIndex = START_INDEX[currentTurn];
        currentPiece.stepsWalked = 0;
        currentPiece.c = COMMON_PATH[currentPiece.pathIndex].c;
        currentPiece.r = COMMON_PATH[currentPiece.pathIndex].r;
        displayEducationalLog(`${upperColor}: Released token out onto safe tracking tile.`);
    } else {
        // EXCEPTION HANDLER: Handle dice overflow requirements smoothly
        // if (currentPiece.stepsWalked + appliedMoveValue > 57) {
        //     displayEducationalLog(`${upperColor}: Dice value overflows home center requirements.`);
            
        //     // If the current slot is a computer player, automate recovery to prevent freezes
        //     if (playerProfiles[currentTurn].mode === 'computer') {
        //         let spentIndex = currentTurnMoves.indexOf(appliedMoveValue);
        //         if (spentIndex !== -1) currentTurnMoves.splice(spentIndex, 1);
                
        //         if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

        //         if (currentTurnMoves.length > 0) {
        //             let hasValidRemainingMove = activeTokens.some((t, idx) => isTokenMovable(currentTurn, t, idx));
        //             if (!hasValidRemainingMove) {
        //                 displayEducationalLog(`${upperColor}: No valid options left for remaining values. Passing turn.`);
        //                 setTimeout(() => {
        //                     if (isGamePaused) return;
        //                     passTurnSequence();
        //                 }, 1500);
        //                 return;
        //             }
        //             // Retry automated loop execution with the remaining valid die value
        //             setTimeout(() => {
        //                 if (isGamePaused) return;
        //                 if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
        //             }, 1500);
        //         } else {
        //             // Wiped out all moves via overflow, cycle turn smoothly
        //             setTimeout(() => {
        //                 if (isGamePaused) return;
        //                 passTurnSequence();
        //             }, 1500);
        //         }
        //     }
        //     return; 
        // }
        if (currentPiece.stepsWalked + appliedMoveValue > 57) {
    displayEducationalLog(`${upperColor}: Dice value overflows home center requirements.`);

    // Remove the unusable die
    let spentIndex = currentTurnMoves.indexOf(appliedMoveValue);
    if (spentIndex !== -1) {
        currentTurnMoves.splice(spentIndex, 1);
    }

    if (typeof saveGameStateToStorage === 'function') {
        saveGameStateToStorage();
    }

    // ===== PRAGMATIC RULE =====
    // If there are still usable moves left, try them.
    // Otherwise just pass the turn so the game never freezes.
    let hasValidRemainingMove = currentTurnMoves.length > 0 &&
        activeTokens.some((t, idx) => isTokenMovable(currentTurn, t, idx));

    if (hasValidRemainingMove && playerProfiles[currentTurn].mode === 'computer') {
        // Computer can still try the remaining die
        setTimeout(() => {
            if (isGamePaused) return;
            if (typeof executeAutomatedComputerMove === 'function') {
                executeAutomatedComputerMove();
            }
        }, 1000);
    } else {
        // No clean move left → resolve turn end (double-six bonus or pass)
        displayEducationalLog(`${upperColor}: No valid remaining moves. Resolving turn.`);
        resolveTurnEndAfterMoves();
    }

    return;
}

        currentPiece.stepsWalked += appliedMoveValue;
        
        if (currentPiece.stepsWalked >= 52) {
            currentPiece.pathIndex = -2; 
            let laneOffset = currentPiece.stepsWalked - 51;

            if (currentTurn === 'green') { currentPiece.c = laneOffset; currentPiece.r = 7; }
            if (currentTurn === 'yellow') { currentPiece.c = 7; currentPiece.r = laneOffset; }
            if (currentTurn === 'blue') { currentPiece.c = 14 - laneOffset; currentPiece.r = 7; }
            if (currentTurn === 'red') { currentPiece.c = 7; currentPiece.r = 14 - laneOffset; }

            if (currentPiece.stepsWalked === 57) {
                displayEducationalLog(`${upperColor}: Token reached absolute home center goal!`);
                // Check if this player has now finished all 4 tokens
                if (typeof window.checkForMatchWinner === 'function') {
                    window.checkForMatchWinner(currentTurn);
                }
            } else {
                displayEducationalLog(`${upperColor}: Token advanced inside safe home lane.`);
            }
        } else {
            currentPiece.pathIndex = (currentPiece.pathIndex + appliedMoveValue) % 52;
            currentPiece.c = COMMON_PATH[currentPiece.pathIndex].c;
            currentPiece.r = COMMON_PATH[currentPiece.pathIndex].r;
            displayEducationalLog(`${upperColor}: Token advanced clockwise along track.`);
        }
    }

    if (typeof checkCaptureMechanic === 'function') {
        checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens);
    }

    let spentIndex = currentTurnMoves.indexOf(appliedMoveValue);
    if (spentIndex !== -1) currentTurnMoves.splice(spentIndex, 1);

    if (typeof drawLudoLayout === 'function') drawLudoLayout();

    // Commit token placement transformations directly to LocalStorage
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    // M12 arc2m12b: after a real move, broadcast it gasless via the multiplayer
    // rail (soft-fail; no-op when multiplayer is not active).
    if (typeof window.gfgLudoAdapter === 'object' && window.gfgLudoAdapter && window.gfgLudoAdapter.isActive && window.gfgLudoAdapter.isActive()) {
        try {
            window.gfgLudoAdapter.onMove(
                lastDiceRoll1 || appliedMoveValue,
                lastDiceRoll2 || 0,
                selectedTokenIndex,
                (currentPiece._prevPath === undefined ? 0 : currentPiece._prevPath),
                currentPiece.pathIndex,
                currentPiece.stepsWalked
            );
        } catch (e) { /* soft */ }
    }

    // GFG-BS SIGNED MOVE LOG (arcv2m17): record EVERY real move - human AND
    // computer seat - into the match's signed off-chain log, which becomes the
    // co-signed settlement digest and is sealed in the batch window. This is
    // what makes the whole single-player match reconstructable and provable on
    // Arc, with ZERO per-move transactions. Soft-fail; never blocks the move.
    try {
        if (window.gfgSettlement && typeof window.gfgSettlement.recordMove === 'function') {
            window.gfgSettlement.recordMove(currentTurn, {
                token: selectedTokenIndex,
                from: (currentPiece._prevPath === undefined ? 0 : currentPiece._prevPath),
                to: currentPiece.pathIndex,
                steps: currentPiece.stepsWalked,
                d1: lastDiceRoll1 || appliedMoveValue,
                d2: lastDiceRoll2 || 0,
                captured: false,
            });
        }
    } catch (e) { /* soft */ }
    try { if (currentPiece) currentPiece._prevPath = currentPiece.pathIndex; } catch (e) {}

    if (currentTurnMoves.length > 0) {
        displayEducationalLog(`${upperColor}: One move remaining. Select another blinking token.`);
        let hasValidRemainingMove = activeTokens.some((t, idx) => isTokenMovable(currentTurn, t, idx));
        if (!hasValidRemainingMove) {
            displayEducationalLog(`${upperColor}: No valid options left for remaining values. Resolving turn.`);
            resolveTurnEndAfterMoves();
            return;
        }

        if (playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (isGamePaused) return;
                if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
            }, 1500);
        }
        return;
    }

    resolveTurnEndAfterMoves();
}

document.addEventListener('DOMContentLoaded', () => {
    const ludoCanvasElement = document.getElementById('ludoCanvas');
    if (ludoCanvasElement) {
        ludoCanvasElement.addEventListener('click', (event) => {
            handleInputInteraction(event.clientX, event.clientY);
        });
    }
});
