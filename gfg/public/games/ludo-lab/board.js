let canvas;
let ctx;

const GRID_SIZE = 15;
let CELL_SIZE; 

const COLORS = {
    green: '#2ecc71',
    yellow: '#f1c40f',
    blue: '#3498db',
    red: '#e74c3c',
    white: '#ffffff',
    gray: '#c3c3cf',   // light board grid line (native Ludo = white board, not black)
    dark: '#1a1a1a'
};

// COSMETICS (owner 2026-09, off-chain only: rendering, never mechanics).
// (a) Box separators: darker + DOUBLE thickness so each box reads clearly.
const GRID_LINE_COLOR = '#2f2f3a';
const GRID_LINE_WIDTH = 2;
// (b) FLEXIBLE token size (owner follow-up 2026-09): big in the home yard,
// fitted to the small track boxes once a token is out, and automatically big
// again the moment it is sent back home. The size is derived from pathIndex on
// every frame, so nothing is stored and mechanics are untouched.
const TOKEN_RADIUS_FACTOR = 0.70;        // home yard (homebox): the big size
const TOKEN_PATH_RADIUS_FACTOR = 0.42;   // on the track: fits inside the box
const TOKEN_STACK_RADIUS_FACTOR = 0.20;  // several tokens stacked on one box
const TOKEN_YARD_SPREAD = 0.75;          // yard 2x2 offset, keeps big tokens apart

// Darken a hex colour toward black by `factor` (0 = unchanged, 1 = black).
// Used for the centre-die blink so the pulse stays the SAME hue as the player's
// colour (never a different colour, so the board colour is never confusing).
function shadeHex(hex, factor) {
    try {
        const h = String(hex).replace('#', '');
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const k = Math.max(0, Math.min(1, 1 - factor));
        return 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')';
    } catch (e) { return hex; }
}

// Top-left cell of each colour's 6x6 home yard (for the spread home layout).
const YARD_START = {
    green:  { c: 0, r: 0 },
    yellow: { c: 9, r: 0 },
    blue:   { c: 9, r: 9 },
    red:    { c: 0, r: 9 }
};

// Purely cosmetic arrow overlays (native Ludo look). NEVER affect mechanics:
// they only tell the player which way pieces travel (clockwise track) and
// which way the home column leads into the center.
const ARROW_COLOR = 'rgba(60,72,88,0.72)';

let globalBlinkAlpha = 1.0;
let blinkGrowing = false;

function drawLudoLayout() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Native Ludo board: white surface, not black. Fill before the grid so
    // every uncoloured cell reads as clean white instead of dark boxes.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            ctx.strokeStyle = GRID_LINE_COLOR; ctx.lineWidth = GRID_LINE_WIDTH;
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    // drawBigYard(0, 0, COLORS.green);      
    // drawBigYard(0, 9, COLORS.red);        
    // drawBigYard(9, 0, COLORS.yellow);     
    // drawBigYard(9, 9, COLORS.blue);
    drawBigYard(0, 0, 'green');      
    drawBigYard(0, 9, 'red');        
    drawBigYard(9, 0, 'yellow');     
    drawBigYard(9, 9, 'blue');       

    for (let c = 1; c < 6; c++) drawCell(c, 7, COLORS.green);
    drawCell(1, 6, COLORS.green); 

    for (let r = 1; r < 6; r++) drawCell(7, r, COLORS.yellow);
    drawCell(8, 1, COLORS.yellow); 

    for (let c = 9; c < 14; c++) drawCell(c, 7, COLORS.blue);
    drawCell(13, 8, COLORS.blue); 

    for (let r = 9; r < 14; r++) drawCell(7, r, COLORS.red);
    drawCell(6, 13, COLORS.red); 

    drawCenterTriangles();
    drawCenterDiceAffordance();
    drawPathArrows();
    drawAllTokens();
}

// Small straight arrow centred in a cell, pointing in the given direction.
// angleDeg: 0 = east (→), 90 = south (↓), 180 = west (←), -90/270 = north (↑).
function drawArrowInCell(col, row, angleDeg, color) {
    const cx = (col + 0.5) * CELL_SIZE;
    const cy = (row + 0.5) * CELL_SIZE;
    const s = CELL_SIZE * 0.3; // arrow half-length

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleDeg * Math.PI / 180);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.8, CELL_SIZE * 0.06);
    ctx.lineCap = 'round';

    // Shaft
    ctx.beginPath();
    ctx.moveTo(-s, 0);
    ctx.lineTo(s * 0.7, 0);
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.moveTo(s * 0.7, 0);
    ctx.lineTo(s * 0.28, -s * 0.42);
    ctx.lineTo(s * 0.28, s * 0.42);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}

// Clockwise-direction + home-column arrows (native Ludo board look).
// Purely decorative: drawn under the tokens, never read by the game logic.
function drawPathArrows() {
    const whiteArrow = '#ffffff';

    // HOME COLUMNS: each coloured cell carries a white arrow pointing toward
    // the centre (that is the way that colour's pieces finish).
    for (let c = 1; c <= 6; c++) drawArrowInCell(c, 7, 0, whiteArrow);        // green  -> east
    for (let r = 1; r <= 6; r++) drawArrowInCell(7, r, 90, whiteArrow);       // yellow -> south
    for (let c = 9; c <= 14; c++) drawArrowInCell(c, 7, 180, whiteArrow);     // blue   -> west
    for (let r = 9; r <= 14; r++) drawArrowInCell(7, r, -90, whiteArrow);     // red    -> north

    // MAIN TRACK: straight arrows on white path cells showing the clockwise
    // direction of travel around the board.
    drawArrowInCell(3, 6, 0, ARROW_COLOR);
    drawArrowInCell(4, 6, 0, ARROW_COLOR);
    drawArrowInCell(8, 3, 90, ARROW_COLOR);
    drawArrowInCell(8, 4, 90, ARROW_COLOR);
    drawArrowInCell(11, 8, 180, ARROW_COLOR);
    drawArrowInCell(12, 8, 180, ARROW_COLOR);
    drawArrowInCell(6, 11, -90, ARROW_COLOR);
    drawArrowInCell(6, 12, -90, ARROW_COLOR);
}

function drawCell(col, row, color) {
    ctx.fillStyle = color; ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    ctx.strokeStyle = GRID_LINE_COLOR; ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.strokeRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
}

// function drawBigYard(startCol, startRow, color) {
//     ctx.fillStyle = color; ctx.fillRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);
//     ctx.strokeStyle = COLORS.white; ctx.lineWidth = 2;
//     ctx.strokeRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);
//     ctx.fillStyle = COLORS.white; ctx.beginPath();
//     ctx.arc((startCol + 3) * CELL_SIZE, (startRow + 3) * CELL_SIZE, CELL_SIZE * 2, 0, Math.PI * 2); ctx.fill();
// }

// Active-seat model (2P: only the two chosen seats play). Used to grey out
// inactive yards and skip their tokens entirely.
function isSeatActive(colorName) {
    if (typeof window.getActiveSeats === 'function') {
        return window.getActiveSeats().indexOf(colorName) !== -1;
    }
    return true; // No active-seat model loaded — behave like a classic 4-seat board.
}

function drawBigYard(startCol, startRow, colorName) {
    const color = COLORS[colorName];
    const inactive = !isSeatActive(colorName);

    ctx.fillStyle = inactive ? 'rgba(118,118,128,0.5)' : color;
    ctx.fillRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);

    // Same dark bold edge as the small track boxes (owner 2026-09): the yard
    // square now reads with the identical line colour + thickness. The yard
    // FILL (its colour) is untouched.
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.strokeRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);

    // White circle in the middle of the yard
    ctx.fillStyle = COLORS.white;
    ctx.beginPath();
    ctx.arc((startCol + 3) * CELL_SIZE, (startRow + 3) * CELL_SIZE, CELL_SIZE * 2, 0, Math.PI * 2);
    ctx.fill();

    const centerX = (startCol + 3) * CELL_SIZE;
    const centerY = (startRow + 3) * CELL_SIZE;

    // ===== INACTIVE seat (2P mode): greyed yard, bold label, NO crown =====
    if (inactive) {
        ctx.font = `bold ${CELL_SIZE * 0.78}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(20,20,28,0.7)';
        ctx.fillText('INACTIVE', centerX, centerY);
        return;
    }

    // ===== CROWN for finished players =====
    if (typeof window.getPlayerRank === 'function') {
        const rank = window.getPlayerRank(colorName);
        if (rank > 0) {
            // Crown emoji
            ctx.font = `${CELL_SIZE * 1.8}px serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('👑', centerX, centerY - CELL_SIZE * 0.3);

            // Position number under the crown
            ctx.font = `bold ${CELL_SIZE * 0.9}px system-ui`;
            ctx.fillStyle = rank === 1 ? '#f87818' : '#333';
            ctx.fillText(rank + (rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'), centerX, centerY + CELL_SIZE * 1.1);
        }
    }
}

// CENTRE AS THE DICE BUTTON (owner 2026-09, COSMETIC + input only; mechanics
// untouched). This is now the SINGLE dice source of truth: the old #diceBtn is
// removed from the page, so this centre die is the only roll control. It shows
// the text ROLL / DICE, and while it is a human seat's turn it BLINKS in that
// player's colour (green / yellow / blue / red). The text keeps a dark outline
// so it stays readable on every one of those backgrounds.
const CENTER_HIT_CELLS = [6, 9]; // cols/rows 6..8 = the centre 3x3 block
let centerTurnColor = null;      // set each draw to the blinking player colour

// Can a manual roll happen right now? Mirrors rollDiceEngine's own guards, which
// remain the authority; this is only for the visual state (blink / dim).
function canRollNow() {
    try {
        if (typeof setupConfigurationLocked !== 'undefined' && !setupConfigurationLocked) return false;
        if (typeof matchOver !== 'undefined' && matchOver) return false;
        if (typeof isGamePaused !== 'undefined' && isGamePaused) return false;
        if (typeof isChainDown !== 'undefined' && isChainDown) return false;
        if (typeof displayDiceOnBoard === 'boolean' && displayDiceOnBoard) return false;
        if (typeof isDiceRolled !== 'undefined' && isDiceRolled) return false;
        if (typeof currentTurn === 'undefined' || typeof playerProfiles === 'undefined' || !playerProfiles[currentTurn]) return false;
        if (playerProfiles[currentTurn].mode !== 'human') return false; // computer seats roll themselves
        if (typeof window.gfgRemoteTurn === 'function' && window.gfgRemoteTurn()) return false;
        return true;
    } catch (e) { return false; }
}

function drawCenterDiceAffordance() {
    const mid = 7.5 * CELL_SIZE;
    const active = canRollNow();
    centerTurnColor = active ? currentTurn : null;
    const size = CELL_SIZE * 1.5;
    const half = size / 2;

    // Blink driver: globalBlinkAlpha pulses 0.3..1.0. The WHOLE die (background,
    // border and text) blinks together, and the background blinks by shading the
    // player's OWN colour deeper (same hue) instead of fading to transparent, so
    // it stays solid, deep and attention-grabbing.
    const pulse = (typeof globalBlinkAlpha === 'number') ? globalBlinkAlpha : 1;

    ctx.save();
    if (active) {
        const base = COLORS[currentTurn] || '#ffffff';
        // pulse 1 -> the pure player colour; pulse 0.3 -> a deeper shade of it.
        ctx.fillStyle = shadeHex(base, 0.45 * (1 - pulse));
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, CELL_SIZE * 0.08);
    } else {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(60,72,88,0.5)';
        ctx.lineWidth = Math.max(1.5, CELL_SIZE * 0.05);
    }
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(mid - half, mid - half, size, size, size * 0.22);
    } else {
        ctx.rect(mid - half, mid - half, size, size);
    }
    ctx.fill();
    ctx.stroke();

    // A halo ring in the same player colour so the die pops out of the board
    // centre while it blinks (same hue, deeper shade).
    if (active) {
        ctx.globalAlpha = 0.35 + 0.45 * pulse;
        ctx.strokeStyle = shadeHex(COLORS[currentTurn] || '#ffffff', 0.25);
        ctx.lineWidth = Math.max(2, CELL_SIZE * 0.10);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(mid - half - CELL_SIZE * 0.10, mid - half - CELL_SIZE * 0.10, size + CELL_SIZE * 0.20, size + CELL_SIZE * 0.20, size * 0.24);
        } else {
            ctx.rect(mid - half - CELL_SIZE * 0.10, mid - half - CELL_SIZE * 0.10, size + CELL_SIZE * 0.20, size + CELL_SIZE * 0.20);
        }
        ctx.stroke();
    }

    // "ROLL" / "DICE", two bold lines, white with a dark outline so the text
    // reads on green, yellow, blue and red alike. The text blinks with the die
    // (its opacity follows the same pulse) but never drops below readable.
    ctx.globalAlpha = active ? (0.68 + 0.32 * pulse) : 0.55;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(CELL_SIZE * 0.42)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.lineWidth = Math.max(2, CELL_SIZE * 0.08);
    ctx.strokeStyle = 'rgba(20,20,28,0.85)';
    ctx.fillStyle = '#ffffff';
    const l1 = mid - CELL_SIZE * 0.26;
    const l2 = mid + CELL_SIZE * 0.26;
    ctx.strokeText('ROLL', mid, l1); ctx.fillText('ROLL', mid, l1);
    ctx.strokeText('DICE', mid, l2); ctx.fillText('DICE', mid, l2);
    ctx.restore();
}

function drawCenterTriangles() {
    const centerStart = 6 * CELL_SIZE; const centerEnd = 9 * CELL_SIZE; const mid = 7.5 * CELL_SIZE;
    ctx.fillStyle = COLORS.green; ctx.beginPath(); ctx.moveTo(centerStart, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerStart, centerEnd); ctx.fill();
    ctx.fillStyle = COLORS.yellow; ctx.beginPath(); ctx.moveTo(centerStart, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerStart); ctx.fill();
    ctx.fillStyle = COLORS.blue; ctx.beginPath(); ctx.moveTo(centerEnd, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerEnd); ctx.fill();
    ctx.fillStyle = COLORS.red; ctx.beginPath(); ctx.moveTo(centerStart, centerEnd); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerEnd); ctx.fill();
}

// Draw ONE token at an explicit centre + radius (shared by yard and track).
function drawOneToken(piece, cx, cy, radius) {
    let canThisPieceMove = false;
    if (typeof isTokenMovable === 'function') {
        canThisPieceMove = isTokenMovable(piece.color, piece.token, piece.index);
    }
    ctx.save();
    if (canThisPieceMove) {
        ctx.globalAlpha = globalBlinkAlpha;
        ctx.fillStyle = '#ffffff'; ctx.beginPath();
        ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(cx + 1, cy + 1, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS[piece.color]; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, radius * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}

function drawAllTokens() {
    // 1. Cluster the tokens that are OUT on the track by their grid cell. Tokens
    //    still in the home yard are handled separately so they can stay big.
    let gridOccupancyMap = {};
    const yardPieces = [];

    Object.keys(tokens).forEach(color => {
        if (!isSeatActive(color)) return; // 2P: inactive seats show NO tokens
        tokens[color].forEach((token, index) => {
            if (token.stepsWalked >= 57) return; // Hide completed tokens that reached the center
            const piece = { color: color, token: token, index: index };
            if (typeof isTokenInHomeYard === 'function' && isTokenInHomeYard(color, token)) {
                yardPieces.push(piece);
                return;
            }
            const coordKey = `${token.c}_${token.r}`;
            if (!gridOccupancyMap[coordKey]) gridOccupancyMap[coordKey] = [];
            gridOccupancyMap[coordKey].push(piece);
        });
    });

    // 2. HOME YARD tokens: keep the big size, spread in a fixed 2x2 around the
    //    home circle so the bigger pawns never overlap each other. The layout is
    //    purely positional, so a captured token that returns home (pathIndex -1)
    //    grows back to this size on the very next frame.
    yardPieces.forEach(piece => {
        const start = YARD_START[piece.color] || YARD_START.green;
        const cx = (start.c + 3) * CELL_SIZE;
        const cy = (start.r + 3) * CELL_SIZE;
        const d = CELL_SIZE * TOKEN_YARD_SPREAD;
        const slot = piece.index % 4;
        const dx = (slot === 0 || slot === 2) ? -d : d;
        const dy = (slot < 2) ? -d : d;
        drawOneToken(piece, cx + dx, cy + dy, CELL_SIZE * TOKEN_RADIUS_FACTOR);
    });

    // 3. TRACK tokens: fitted to the box, with the 2x2 shrink when several share
    //    one box, so a big home token never spills onto the next box out here.
    Object.keys(gridOccupancyMap).forEach(coordKey => {
        const occupants = gridOccupancyMap[coordKey];
        const totalOccupantsCount = occupants.length;

        occupants.forEach((piece, subIndex) => {
            let baseCenterX = (piece.token.c * CELL_SIZE) + (CELL_SIZE / 2);
            let baseCenterY = (piece.token.r * CELL_SIZE) + (CELL_SIZE / 2);
            let radius = CELL_SIZE * TOKEN_PATH_RADIUS_FACTOR;

            if (totalOccupantsCount > 1) {
                radius = CELL_SIZE * TOKEN_STACK_RADIUS_FACTOR;
                let offsetShift = CELL_SIZE * 0.22;
                if (subIndex === 0) { baseCenterX -= offsetShift; baseCenterY -= offsetShift; }
                if (subIndex === 1) { baseCenterX += offsetShift; baseCenterY -= offsetShift; }
                if (subIndex === 2) { baseCenterX -= offsetShift; baseCenterY += offsetShift; }
                if (subIndex === 3) { baseCenterX += offsetShift; baseCenterY += offsetShift; }
            }

            drawOneToken(piece, baseCenterX, baseCenterY, radius);
        });
    });
}

let blinkLoopActive = false;

// True while at least one movable token needs the blink halo (the ONLY reason
// the board needs to keep animating).
function anyTokenBlinkNeeded() {
    if (typeof tokens !== 'object' || !tokens) return false;
    if (typeof isTokenMovable !== 'function') return false;
    return Object.keys(tokens).some(color => {
        if (!isSeatActive(color)) return false;
        return tokens[color].some((token, index) => isTokenMovable(color, token, index));
    });
}

// (Re)starts the board animation loop when it isn't already running. Called by
// the drawLudoLayout wrapper (capture.js) on every game-state redraw, so the
// loop lives only while something actually animates and dies when idle.
window.ensureBoardAnimationLoop = function () {
    if (blinkLoopActive) return;
    blinkLoopActive = true;
    requestAnimationFrame(runBlinkAnimationEngine);
};

// Renders ONLY while a token is blinking. When nothing is blinking the loop
// stops scheduling frames entirely: the canvas keeps its last painted frame
// (dice stay exactly where they landed, highlights persist) and the CPU is not
// thrashed by a 60fps clear+redraw that wiped any transient painting between
// frames.
function runBlinkAnimationEngine() {
    if (blinkGrowing) {
        globalBlinkAlpha += 0.05; if (globalBlinkAlpha >= 1.0) blinkGrowing = false;
    } else {
        globalBlinkAlpha -= 0.05; if (globalBlinkAlpha <= 0.3) blinkGrowing = true;
    }
    // The loop also runs while the centre die should blink (a human seat's turn),
    // so the pulse is alive exactly when a roll is possible.
    const needsBlink = anyTokenBlinkNeeded() || canRollNow();
    // While dice are on the board the physics loop owns rendering (it self
    // renders every tick), so the blink loop stands down to avoid double
    // drawing the whole canvas. It is restarted by the drawLudoLayout wrapper
    // once the dice are cleared and a token becomes movable.
    const diceBusy = typeof displayDiceOnBoard === 'boolean' && displayDiceOnBoard &&
        Array.isArray(physicalDice) && physicalDice.length === 2;
    if (needsBlink && !diceBusy && canvas && ctx) drawLudoLayout();
    if (needsBlink && !diceBusy) {
        blinkLoopActive = true;
        requestAnimationFrame(runBlinkAnimationEngine);
    } else {
        blinkLoopActive = false;
    }
}

// Centre tap -> the ONLY roll control now (the old #diceBtn is removed). The
// guard mirrors the engine's own rules (your turn, dice not rolled yet, match
// running, online); after a roll this returns false, so a centre tap falls
// through to the normal token-movement click. rollDiceEngine keeps its own
// isDiceRolled / hasRolledThisTurn guard, so no double roll is possible.
function handleCenterRollTap(event) {
    if (!canvas || !CELL_SIZE) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const col = Math.floor(x / CELL_SIZE);
    const row = Math.floor(y / CELL_SIZE);
    if (col < CENTER_HIT_CELLS[0] || col >= CENTER_HIT_CELLS[1]) return;
    if (row < CENTER_HIT_CELLS[0] || row >= CENTER_HIT_CELLS[1]) return;
    if (!canRollNow()) return; // not your roll (or already rolled)
    if (typeof rollDiceEngine === 'function') rollDiceEngine('CENTER_TAP');
}

function initBoard() {
    canvas = document.getElementById('ludoCanvas'); if (!canvas) return;
    ctx = canvas.getContext('2d'); CELL_SIZE = canvas.width / GRID_SIZE;
    // Registered before movement.js's own canvas click (script order), and
    // movement.js returns early while the dice are unrolled, so a centre tap
    // can never be treated as a token tap.
    canvas.addEventListener('click', handleCenterRollTap);
    drawLudoLayout();
}

document.addEventListener('DOMContentLoaded', () => { initBoard(); });
