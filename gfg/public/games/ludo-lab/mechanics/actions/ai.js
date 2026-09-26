/**
 * GlobalFolkGames Ludo AI Automation Processing Core Module
 * Fully decoupled script managing non-custodial automated turns.
 */

function triggerAutomatedComputerDiceRoll() {
    if (isGamePaused) return;
    if (typeof matchOver !== 'undefined' && matchOver) return;
    // 2P fix: a stale timer must never auto-roll on a seat that is now human.
    if (playerProfiles[currentTurn] && playerProfiles[currentTurn].mode !== 'computer') return;
    if (currentTurnMoves.length > 0 || isDiceRolled) return;
    console.log(`[GFG LUDO] AI turn armed - computer seat ${currentTurn} triggering its on-chain roll.`);
    rollDiceEngine('AI_CONFIRMED');
}

function executeAutomatedComputerMove() {
    if (isGamePaused) return;
    if (typeof matchOver !== 'undefined' && matchOver) return;
    // 2P fix: a stale timer must never auto-move on a seat that is now human.
    if (playerProfiles[currentTurn] && playerProfiles[currentTurn].mode !== 'computer') return;
    if (currentTurnMoves.length === 0) return;

    let activeTokens = tokens[currentTurn];
    let movableTokenIndices = [];

    activeTokens.forEach((token, index) => {
        if (isTokenMovable(currentTurn, token, index)) {
            movableTokenIndices.push(index);
        }
    });

    if (movableTokenIndices.length === 0) {
        displayEducationalLog(`${currentTurn.toUpperCase()}: No valid options available for computer. Passing.`);
        setTimeout(() => {
            if (isGamePaused) return;
            passTurnSequence();
        }, 1500);
        return;
    }

    let targetTokenIndex = selectBestStrategicAIToken(movableTokenIndices, activeTokens);
    console.log(`[GFG LUDO] AI decided a move | seat=${currentTurn} | dice=${currentTurnMoves.join(',')} | movableTokens=[${movableTokenIndices.join(',')}] | choseToken=${targetTokenIndex}`);
    
    if (targetTokenIndex !== -1) {
        processTokenMovementExecution(targetTokenIndex);
    }
}

/**
 * Evaluates candidate move variations using structured traditional rules
 */
function selectBestStrategicAIToken(indices, activeTokens) {
    let currentDiceValue = currentTurnMoves.includes(6) ? 6 : currentTurnMoves[0];

    // STRATEGY 1: Scan for Yoruba "Pè" instant-win capture moves
    for (let index of indices) {
    let token = activeTokens[index];
    if (isTokenInHomeYard(currentTurn, token)) continue;

    // Safety: only project when the token is on the common path
    if (typeof token.pathIndex !== 'number' || token.pathIndex < 0) continue;

    let projectedPathIndex = (token.pathIndex + currentDiceValue) % 52;
    let projectedCell = COMMON_PATH[projectedPathIndex];

    // Extra safety – never read .c from undefined
    if (!projectedCell) continue;

    for (let enemyColor in tokens) {
            if (enemyColor === currentTurn) continue;
            
            let isDestinationSafeBox = false;
            for (let startKey in START_INDEX) {
                if (COMMON_PATH[START_INDEX[startKey]].c === projectedCell.c && COMMON_PATH[START_INDEX[startKey]].r === projectedCell.r) {
                    isDestinationSafeBox = true;
                }
            }

            if (!isDestinationSafeBox) {
                let matchFound = tokens[enemyColor].some(enemyToken => enemyToken.c === projectedCell.c && enemyToken.r === projectedCell.r && enemyToken.stepsWalked < 52);
                if (matchFound) return index; 
            }
        }
    }

    // STRATEGY 2: Prioritise releasing pieces from the yard when a 6 is rolled
    if (currentDiceValue === 6) {
        for (let index of indices) {
            if (isTokenInHomeYard(currentTurn, activeTokens[index])) return index;
        }
    }

    // STRATEGY 3: Prioritise scoring a piece into the center goal
    for (let index of indices) {
        let token = activeTokens[index];
        if (token.stepsWalked + currentDiceValue === 57) return index;
    }

    // STRATEGY 4: Default to advancing the piece furthest along the board
    let bestIndex = indices[0];
    let maxSteps = -1;
    for (let index of indices) {
        if (activeTokens[index].stepsWalked > maxSteps) {
            maxSteps = activeTokens[index].stepsWalked;
            bestIndex = index;
        }
    }

    return bestIndex;
}
