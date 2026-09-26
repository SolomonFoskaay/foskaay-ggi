// Global Vector Objects shared with the controller engine
let physicalDice = [];
let physicsAnimationLoop;

// Die body size in board pixels (25% smaller than the earlier 92px so the dice
// stay readable without crowding the board on small phones). Physics positions
// are the die's TOP-LEFT corner in the 600x600 board space.
const DICE_SIZE = 69;

// ============================ Natural dice sounds ============================
// Synthesised with the Web Audio API (no binary assets to ship or license).
// Every sound is a soft-fail: a browser without audio support or a blocked
// autoplay policy must NEVER block a dice roll.

let _diceAudioCtx = null;

function _getDiceAudioCtx() {
    try {
        if (!_diceAudioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            _diceAudioCtx = new AC();
        }
        if (_diceAudioCtx.state === 'suspended') _diceAudioCtx.resume();
        return _diceAudioCtx;
    } catch (e) {
        return null;
    }
}

// Rattle when the dice are thrown: a burst of filtered-noise clicks (the dice
// knocking together in the hand) ending with two high ticks (hitting the table).
function playDiceRattle() {
    try {
        const ctx = _getDiceAudioCtx();
        if (!ctx) return;
        const master = ctx.createGain();
        master.gain.value = 0.16;
        master.connect(ctx.destination);
        const t0 = ctx.currentTime;

        // ~7 short filtered-noise bursts = dice shaking together.
        for (let i = 0; i < 7; i++) {
            const t = t0 + i * 0.085 + Math.random() * 0.02;
            const dur = 0.045;
            const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / len);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 900 + Math.random() * 1800;
            bp.Q.value = 1.1;
            const g = ctx.createGain();
            g.gain.setValueAtTime(1, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            src.connect(bp); bp.connect(g); g.connect(master);
            src.start(t); src.stop(t + dur);
        }

        // Two short high ticks when the dice land on the table.
        for (let i = 0; i < 2; i++) {
            const t = t0 + 0.62 + i * 0.055;
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = 1700 + i * 250;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.5, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
            osc.connect(g); g.connect(master);
            osc.start(t); osc.stop(t + 0.05);
        }
    } catch (e) { /* Audio is cosmetic — never block a roll. */ }
}

// Short click when a die hits a board edge or another die. Throttled so a
// chain of bounces sounds like a rattle, not machine-gun fire.
let _lastDiceTick = 0;

function playDiceTick() {
    try {
        const ctx = _getDiceAudioCtx();
        if (!ctx) return;
        const now = performance.now();
        if (now - _lastDiceTick < 70) return;
        _lastDiceTick = now;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 2400;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.04);
    } catch (e) { /* cosmetic */ }
}

// ======================= 3D orientation math (quaternions) ======================
// The dice are REAL CSS-3D cubes, so each carries a unit quaternion [w,x,y,z].
// All helpers here are pure math (no DOM), so the endgame harness can run the
// physics loop headless. Face->normal map: opposite faces sum to 7.

const DICE_FACE_NORMALS = {
    1: [0, 0, 1],   // front
    6: [0, 0, -1],  // back
    3: [1, 0, 0],   // right
    4: [-1, 0, 0],  // left
    5: [0, -1, 0],  // CSS 'top' lives at -Y (rotateX(-90) maps +Z -> -Y)
    2: [0, 1, 0],   // CSS 'bottom' lives at +Y (rotateX(+90) maps +Z -> +Y)
};

function DICE_Q_IDENTITY() { return [1, 0, 0, 0]; }

function DICE_Q_NORMALIZE(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!n || n === 0) return DICE_Q_IDENTITY();
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// Hamilton product: a applied after b (result rotates by b, then by a).
function DICE_Q_MUL(a, b) {
    return DICE_Q_NORMALIZE([
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ]);
}

function axisAngleToQuat(x, y, z, angle) {
    const l = Math.hypot(x, y, z) || 1;
    const s = Math.sin(angle / 2);
    return [Math.cos(angle / 2), (x / l) * s, (y / l) * s, (z / l) * s];
}

// Spherical interpolation (shortest arc), then normalized.
function slerpQuat(a, b, t) {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (dot < 0) { dot = -dot; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    if (dot > 0.9995) {
        return DICE_Q_NORMALIZE([
            a[0] + t * (bb[0] - a[0]),
            a[1] + t * (bb[1] - a[1]),
            a[2] + t * (bb[2] - a[2]),
            a[3] + t * (bb[3] - a[3])
        ]);
    }
    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);
    const sA = Math.cos(theta) - dot * sinTheta / sinTheta0;
    const sB = sinTheta / sinTheta0;
    return DICE_Q_NORMALIZE([
        sA * a[0] + sB * bb[0],
        sA * a[1] + sB * bb[1],
        sA * a[2] + sB * bb[2],
        sA * a[3] + sB * bb[3]
    ]);
}

// Angular distance (radians, 0..PI) between two orientations.
function quatAngleBetween(a, b) {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    const c = Math.min(1, Math.max(-1, 2 * d * d - 1));
    return Math.acos(c);
}

// Quaternion that rotates the given face normal onto a target axis (unit).
function _quatAlignToAxis(n, axis) {
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
    const dot = Math.max(-1, Math.min(1, nx * axis[0] + ny * axis[1] + nz * axis[2]));
    if (dot > 0.9999) return DICE_Q_IDENTITY();
    if (dot < -0.9999) {
        // Direct opposite: half-turn about any axis perpendicular to `axis`.
        const perp = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        return axisAngleToQuat(perp[0], perp[1], perp[2], Math.PI);
    }
    // axis = cross(n, target)
    const ax = ny * axis[2] - nz * axis[1];
    const ay = nz * axis[0] - nx * axis[2];
    const az = nx * axis[1] - ny * axis[0];
    return axisAngleToQuat(ax, ay, az, Math.acos(dot));
}

// Settle orientation: the rolled VALUE face becomes the TOP of a real die lying
// flat on the board (its normal -> +Y, the board's up axis), then a little spin
// about that up axis varies the pips so dice don't land identically every roll.
// The spin is cached on the die so the slerp target stays fixed while landing.
function DICE_Q_COMPUTE_TARGET(value, die) {
    const n = DICE_FACE_NORMALS[value];
    if (!n) return DICE_Q_IDENTITY();
    let spin = (die && typeof die._spinAngle === 'number') ? die._spinAngle : (Math.random() - 0.5) * 0.9;
    if (die) die._spinAngle = spin;
    return DICE_Q_NORMALIZE(DICE_Q_MUL(axisAngleToQuat(0, 1, 0, spin), _quatAlignToAxis(n, [0, 1, 0])));
}

// ============================== Dice physics loop ==============================

function runDicePhysicsCalculations() {
    let piecesStillMoving = false;
    const size = DICE_SIZE;
    const halfSize = size / 2;

    physicalDice.forEach(die => {
        die.x += die.vx;
        die.y += die.vy;
        die.vx *= 0.94; // Natural velocity decay friction
        die.vy *= 0.94;

        // TRUE-3D tumble: dies are real CSS cubes carrying a quaternion
        // orientation. While moving they roll end-over-end along the direction
        // of travel (plus a wobble), so they spin naturally on the board.
        if (!die.q) die.q = DICE_Q_IDENTITY();
        const speed = Math.abs(die.vx) + Math.abs(die.vy);
        if (speed > 0.3) {
            if (die.finalValue == null) die.value = Math.floor(Math.random() * 6) + 1;
            // Re-kicked by a collision (e.g. the dice-vs-dice min impulse or a
            // wall bounce) while already settled: drop the settled flag so the
            // die re-snaps onto its VRF face once it calms again.
            if (die._settledExact) die._settledExact = false;
            const ax = (-die.vy) * 0.9 + (Math.random() - 0.5);
            const ay = (die.vx) * 0.9 + (Math.random() - 0.5);
            const az = 0.5;
            const mag = Math.hypot(ax, ay, az) || 1;
            const ang = Math.min(0.22, speed / 130 + 0.05);
            die.q = DICE_Q_NORMALIZE(DICE_Q_MUL(axisAngleToQuat(ax / mag, ay / mag, az / mag, ang), die.q));
            piecesStillMoving = true;
        } else if (die.finalValue != null) {
            // Velocity stopped -> IMMEDIATELY snap to the VRF face. No easing,
            // no slerp, no frame budget. The moment the die slows down it
            // locks onto the exact ER VRF orientation so the player always
            // sees the correct result the instant the dice rest.
            die.value = die.finalValue;
            const target = DICE_Q_COMPUTE_TARGET(die.finalValue, die);
            die.q = target;
            die._settledExact = true;
            die._settleTarget = target;
        }

        // Boundary Collisions: Bounce off 600x600 canvas parameters like a
        // real die hitting the wooden rim — reverse with ~20% energy loss so
        // it visibly rebounds instead of just stopping. The hit also imparts a
        // 3D tumble kick so the cube tumbles off the rim like a real die.
        let bounced = false;
        if (die.x < 0 || die.x > 600 - size) { die.vx = -die.vx * 0.8; die.x = Math.max(0, Math.min(die.x, 600 - size)); bounced = true; }
        if (die.y < 0 || die.y > 600 - size) { die.vy = -die.vy * 0.8; die.y = Math.max(0, Math.min(die.y, 600 - size)); bounced = true; }
        if (bounced) {
            // A SETTLED die keeps its VRF-locked face: never re-spin the cube
            // off its exact target orientation, even if a wall bounces it.
            if (!die._settledExact) {
                die.q = DICE_Q_NORMALIZE(DICE_Q_MUL(axisAngleToQuat(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, 0.14), die.q));
            }
            if (Math.abs(die.vx) > 1.5 || Math.abs(die.vy) > 1.5) playDiceTick();
        }
    });

    // Dice-vs-dice collision: the two dice bounce apart instead of overlapping.
    if (physicalDice.length === 2) {
        const a = physicalDice[0];
        const b = physicalDice[1];
        const dx = (b.x + halfSize) - (a.x + halfSize);
        const dy = (b.y + halfSize) - (a.y + halfSize);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = 2 * halfSize;
        if (dist < minDist && dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = (minDist - dist) / 2;
            // Positional push-apart FIRST (at least 1.5px per frame) so two
            // dice can never sit glued together, even at virtual rest.
            const push = Math.max(overlap, 1.5);
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;

            // Equal-mass elastic exchange along the collision normal (0.92
            // restitution), with a minimum outward kick so the dice visibly
            // BOUNCE apart the moment they touch instead of sticking.
            const relV = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
            let impulse = relV < 0 ? -relV * 0.92 : 0;
            if (impulse < 1.2) impulse = 1.2;
            a.vx += impulse * nx; a.vy += impulse * ny;
            b.vx -= impulse * nx; b.vy -= impulse * ny;
            // Re-clamp after the push-apart so dice stay on the board.
            a.x = Math.max(halfSize, Math.min(a.x, 600 - size));
            a.y = Math.max(halfSize, Math.min(a.y, 600 - size));
            b.x = Math.max(halfSize, Math.min(b.x, 600 - size));
            b.y = Math.max(halfSize, Math.min(b.y, 600 - size));
            playDiceTick();
        }
    }

    if (piecesStillMoving) {
        physicsAnimationLoop = requestAnimationFrame(runDicePhysicsCalculations);
        // Render every physics tick directly so the tumble animates even when
        // the blink loop is idle (it no longer redraws at 60fps forever).
        // drawLudoLayout also re-paints the dice via the capture.js wrapper.
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
    } else {
        // Velocity stopped -> lock stable final calculation parameters
        finalizeDiceScores();
        // Draw one settled frame so the VRF-locked faces show immediately and
        // stay on the canvas (the idle blink loop no longer wipes them).
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
    }
}

// ============================== 3D dice rendering ==============================
// The dice are REAL CSS-3D cubes: a transparent overlay stage sits exactly over
// the 600x600 board canvas and holds two six-faced cubes oriented by each die's
// quaternion every physics tick. The canvas itself never paints the dice any
// more — the cubes rotate in actual 3D (perspective + preserve-3d) so they
// tumble and bounce like physical objects on the board, and dice-vs-dice
// separation lives in the physics loop above. All DOM access is guarded so the
// headless endgame harness can run the physics loop without a renderer.

const DICE_FACE_PIPS = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
    4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
    5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
    6: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.5], [0.72, 0.5], [0.28, 0.72], [0.72, 0.72]]
};

// Face order keeps opposites summing to 7 (front=1/back=6, right=3/left=4,
// top=5/bottom=2) and matches the CSS face transform classes in style.css.
const DICE_FACE_ORDER = [1, 6, 3, 4, 5, 2];

let _dice3dStage = null;

function canRenderDice3d() {
    if (typeof document === 'undefined') return false;
    return typeof document.createElement === 'function';
}

// Lazily build the overlay stage (two cubes, six faces each). Returns null in
// DOM-less environments so the physics loop still runs headless.
function buildDice3dStage() {
    if (_dice3dStage) return _dice3dStage;
    if (!canRenderDice3d()) return null;
    const canvasEl = document.getElementById('ludoCanvas');
    if (!canvasEl || !canvasEl.parentNode) return null;

    const parent = canvasEl.parentNode;
    const stage = document.createElement('div');
    stage.className = 'gfg-dice-3d-stage';
    stage.style.display = 'none';
    stage.id = 'gfg-dice-3d-stage';

    const faceClass = { 1: 'front', 6: 'back', 3: 'right', 4: 'left', 5: 'top', 2: 'bottom' };
    // One REAL cube per die (two dice), EACH with all six faces. Building six
    // single-face cubes (a regression) made die #2 invisible: its lone back face
    // is backface-hidden, so only its shadow ever showed.
    for (let i = 0; i < physicalDice.length; i++) {
        const die = document.createElement('div');
        die.className = 'gfg-die';

        const shadow = document.createElement('div');
        shadow.className = 'gfg-die-shadow';
        die.appendChild(shadow);

        const cube = document.createElement('div');
        cube.className = 'gfg-die-cube';

        DICE_FACE_ORDER.forEach((value) => {
            const face = document.createElement('div');
            face.className = 'gfg-die-face gfg-die-face-' + faceClass[value];
            (DICE_FACE_PIPS[value] || DICE_FACE_PIPS[1]).forEach(([fx, fy]) => {
                const pip = document.createElement('span');
                pip.className = 'gfg-pip';
                pip.style.left = (fx * 100).toFixed(1) + '%';
                pip.style.top = (fy * 100).toFixed(1) + '%';
                face.appendChild(pip);
            });
            cube.appendChild(face);
        });

        // Flat settle face: a plain 2D die that draws pips DIRECTLY from the ER
        // VRF value. Shown only once the die locks onto the on-chain result, so
        // the number the player sees is ALWAYS the number the game counts —
        // no 3D orientation reading to get confused by.
        const flat = document.createElement('div');
        flat.className = 'gfg-die-flat';
        flat.style.display = 'none';
        die.appendChild(flat);

        die.appendChild(cube);
        stage.appendChild(die);
    }

    parent.appendChild(stage);
    _dice3dStage = stage;
    return stage;
}

// Convert a unit quaternion to a CSS rotate3d string for the cube element.
function quaternionToRotate3d(q) {
    const w = Math.min(1, Math.max(-1, q[0]));
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    let ax = 1, ay = 0, az = 0;
    if (s > 1e-4) { ax = q[1] / s; ay = q[2] / s; az = q[3] / s; }
    return 'rotate3d(' + ax.toFixed(4) + ',' + ay.toFixed(4) + ',' + az.toFixed(4) + ',' + (angle * 180 / Math.PI).toFixed(2) + 'deg)';
}

function updateDice3dRender(dieEl, die, scale) {
    if (!dieEl) return;
    const px = die.x * scale;
    const py = die.y * scale;
    dieEl.style.left = px.toFixed(1) + 'px';
    dieEl.style.top = py.toFixed(1) + 'px';
    const side = (DICE_SIZE * scale).toFixed(1);
    dieEl.style.width = side + 'px';
    dieEl.style.height = side + 'px';
    dieEl.style.setProperty('--die-size', side + 'px');
    dieEl.style.setProperty('--pip-size', (Math.max(2.5, DICE_SIZE * scale * 0.16)).toFixed(1) + 'px');

    const cube = dieEl.querySelector('.gfg-die-cube');
    const flat = dieEl.querySelector('.gfg-die-flat');
    const settled = !!(die && die._settledExact && die.finalValue != null);
    if (settled) {
        // FLAT settle face (owner 2026-08-31): draw pips straight from the ER
        // VRF value so the shown number is ALWAYS the counted number. No 3D
        // rotation reading at all - the cube is hidden once the die locks.
        if (flat) {
            drawFlatDiceFace(flat, die.finalValue);
            flat.style.display = 'block';
        }
        if (cube) cube.style.display = 'none';
        return;
    }
    if (flat) flat.style.display = 'none';
    if (cube) {
        cube.style.display = '';
        // Presentation (camera tilt so dice rest flat with their TOP face up,
        // plus a slight yaw) is applied AFTER the die's own orientation:
        // rotateY+rotateX then rotate3d. The pitch stays SHALLOW: a steep one
        // made the settled cube look like it landed on an edge (two to three
        // faces on display) instead of the VRF value face clearly on top.
        cube.style.transform = 'rotateY(12deg) rotateX(18deg) ' + quaternionToRotate3d(die.q || DICE_Q_IDENTITY());
    }
}

// Render the flat settled die with pips for the given face value (1-6). The
// pip layout is the same table the cube uses, so a "3" shows exactly three
// pips, etc. Idempotent: rebuilds only when the value changes.
function drawFlatDiceFace(flatEl, value) {
    if (!flatEl) return;
    if (flatEl._flatValue === value) return;
    flatEl._flatValue = value;
    // Clear old pips but keep the shared background/border from CSS.
    const old = flatEl.querySelectorAll('.gfg-pip');
    for (let i = 0; i < old.length; i++) old[i].remove();
    const pips = DICE_FACE_PIPS[value] || DICE_FACE_PIPS[1];
    pips.forEach(([fx, fy]) => {
        const pip = document.createElement('span');
        pip.className = 'gfg-pip';
        pip.style.left = (fx * 100).toFixed(1) + '%';
        pip.style.top = (fy * 100).toFixed(1) + '%';
        flatEl.appendChild(pip);
    });
}

// Entry point called by the capture.js drawLudoLayout wrapper on every physics
// tick and every board redraw. Shows a DOM overlay of the two real 3D cubes
// while dice are on the board; hides it (and its stale cubes) otherwise.
function renderPhysicalDiceCubes() {
    if (!canRenderDice3d()) return; // harness / SSR: physics runs headless

    const canvasEl = document.getElementById('ludoCanvas');
    if (!canvasEl) return;

    const showing = !!displayDiceOnBoard && Array.isArray(physicalDice) && physicalDice.length === 2;
    if (!showing) {
        if (_dice3dStage) _dice3dStage.style.display = 'none';
        return;
    }

    const stage = buildDice3dStage();
    if (!stage) return;
    stage.style.display = 'block';

    // Scale board-space (600x600) to the canvas' on-screen size; the stage is
    // pinned to the top-left of the canvas content box (offsetParent board-frame).
    const scale = (canvasEl.clientWidth && canvasEl.width) ? canvasEl.clientWidth / canvasEl.width : 1;
    if (stage._scale == null || Math.abs(stage._scale - scale) > 0.02) {
        stage._scale = scale;
        stage.style.left = (canvasEl.offsetLeft || 0) + 'px';
        stage.style.top = (canvasEl.offsetTop || 0) + 'px';
        stage.style.width = canvasEl.clientWidth + 'px';
        stage.style.height = canvasEl.clientHeight + 'px';
    }

    const dies = stage.querySelectorAll('.gfg-die');
    for (let i = 0; i < dies.length && i < physicalDice.length; i++) {
        updateDice3dRender(dies[i], physicalDice[i], scale);
    }
}

// M12 multiplayer: mirror a REMOTE player's committed dice onto THIS device's
// board (physical cubes + the val-d1/d2/total text). The remote device rolled
// on-chain and committed die1/die2; we show the same numbers here so both
// phones "see" the same dice. Soft-fail: only renders if the 3D path is up.
// remote-dice settle timeout handle (one per matching pair, so a move commit
// right after a dice commit doesn't re-arm the dice window each time).
let _remoteDiceClearTimer = null;

// Cancel a pending remote-dice blink window (used when the shared turn flips to
// OUR seat, so the remote's dice never leak into our own token blink).
window.cancelRemoteDiceWindow = function () {
    if (_remoteDiceClearTimer) { clearTimeout(_remoteDiceClearTimer); _remoteDiceClearTimer = null; }
};

window.showRemoteDice = function (die1, die2) {
    try {
        displayDiceOnBoard = true;
        isDiceRolled = true;
        // _settledExact=true means the dice are treated as ALREADY settled, so
        // updateDice3dRender draws the FLAT settle face with pips taken directly
        // from the committed ER VRF values. Without it the 3D cube renders at
        // identity orientation and the opponent sees a fake default face (e.g.
        // the committed 5+4 "looks like" 1+1). This matches what the roller's
        // own device shows after its roll locks onto the on-chain result.
        physicalDice = [
            { x: 200, y: 260, vx: 0, vy: 0, value: die1, finalValue: die1, _settledExact: true, q: [1, 0, 0, 0] },
            { x: 310, y: 300, vx: 0, vy: 0, value: die2, finalValue: die2, _settledExact: true, q: [1, 0, 0, 0] }
        ];
        var d1 = document.getElementById('val-d1');
        var d2 = document.getElementById('val-d2');
        var tt = document.getElementById('val-total');
        if (d1) d1.innerText = die1;
        if (d2) d2.innerText = die2;
        if (tt) tt.innerText = '= Total: ' + (die1 + die2);
        if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
        // Mirror the roller's timing: the dice show for the same ~3.5s window,
        // then clear so the CORE isTokenMovable starts blinking the remote
        // player's moveable tokens (exact core rules - yard only on a 6, track
        // only when steps+value<=57, never while the dice are on the board).
        if (_remoteDiceClearTimer) { clearTimeout(_remoteDiceClearTimer); _remoteDiceClearTimer = null; }
        _remoteDiceClearTimer = setTimeout(function () {
            _remoteDiceClearTimer = null;
            try {
                displayDiceOnBoard = false;
                // Feed the SAME core roll state the roller's own device uses:
                // isDiceRolled true + the committed values in currentTurnMoves.
                // isTokenMovable (core) then blinks exactly the moveable tokens,
                // on both boards, gated by color===currentTurn which the adapter
                // already synced to the remote player's colour.
                currentTurnMoves = (typeof die1 === 'number' && typeof die2 === 'number') ? [die1, die2] : [];
                if (typeof renderPhysicalDiceCubes === 'function') { try { renderPhysicalDiceCubes(); } catch (e) {} }
                if (typeof drawLudoLayout === 'function') { try { drawLudoLayout(); } catch (e) {} }
            } catch (e) { /* soft */ }
        }, 3500);
        if (typeof drawLudoLayout === 'function') { try { drawLudoLayout(); } catch (e) {} }
    } catch (e) { /* soft */ }
};
