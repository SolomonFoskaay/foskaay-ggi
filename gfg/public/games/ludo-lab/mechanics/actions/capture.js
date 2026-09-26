function checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens) {
    // 1. Exception Check: Block captures if token is in home yard (-1) OR safe in the inner center lane (-2)
    if (currentPiece.pathIndex < 0) return;

    const upperColor = currentTurn.toUpperCase();
    
    // 2. Exception Check: Stays side-by-side with zero capture if landing on any of the 4 home-release safe boxes
    const isTargetOnStartingSafeBox = Object.values(START_INDEX).includes(currentPiece.pathIndex);
    if (isTargetOnStartingSafeBox) {
        return;
    }
    
    // 3. Scan path coordinate markers for active opponent capture evaluation
    turnSequence.forEach(oppColor => {
        // Exception Check: Only target opposing colors! Tokens belonging to the same player stack side-by-side safely
        if (oppColor !== currentTurn) {
            tokens[oppColor].forEach((oppToken, oppIdx) => {
                
                // Match tracking steps positions on common pathway layout cells.
                // PÈ IS UNCONDITIONAL: landing on an opponent token anywhere on
                // the common path (outside the two safe zones: the 4 colored
                // start boxes and the home lane) MUST capture. No gate on
                // "another movable token" or remaining die values - the previous
                // gate made capture fail randomly whenever the mover had no other
                // movable token, leaving tokens side-by-side on a capturable cell.
                if (oppToken.pathIndex === currentPiece.pathIndex && oppToken.stepsWalked < 52) {
                    // Core "pe" logic action: kick enemy piece back to their starting yard slot coordinates
                    oppToken.pathIndex = -1;
                    oppToken.stepsWalked = 0;
                    oppToken.c = HOME_YARDS[oppColor][oppIdx].c;
                    oppToken.r = HOME_YARDS[oppColor][oppIdx].r;

                    // Localized linguistic broadcast overlay alert
                    displayEducationalLog(`${upperColor} "${"pe"}" ${oppColor.toUpperCase()}! Token returned to base yard.`);

                    // Fast-track win bonus: the capturing token that "pe" opponent also completes its circuit and exits the board.
                    if (currentPiece.stepsWalked < 57) {
                        currentPiece.stepsWalked = 57;
                        currentPiece.pathIndex = -2;
                        currentPiece.c = 7;
                        currentPiece.r = 7;
                        displayEducationalLog(`${upperColor}: Capture completed the circuit and the token exited the board.`);

                        // Check if this player has now finished all 4 tokens
                        if (typeof window.checkForMatchWinner === 'function') {
                            window.checkForMatchWinner(currentTurn);
                        }
                    }
                }
            });
        }
    });
}

if (typeof drawLudoLayout === 'function') {
    const originalDrawLudo = drawLudoLayout;
    window.drawLudoLayout = function() {
        originalDrawLudo();
        if (typeof renderPhysicalDiceCubes === 'function') {
            renderPhysicalDiceCubes();
        }
        // Any state change that redraws the board may need the blink loop again
        // (movable tokens / dice tumble). Restart it if it stopped, so the
        // canvas is never left stale when something is animating.
        if (typeof window.ensureBoardAnimationLoop === 'function') {
            window.ensureBoardAnimationLoop();
        }
    };
}
