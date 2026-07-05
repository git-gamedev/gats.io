// client.js

// =============================================================================
// ⚠️  TEMP / HACKEYSACK — will need to be reworked, not part of the real design
// =============================================================================
//
// joinUntilConfirmed() retries JOIN_REQUEST on a blind interval because
// connection.js doesn't expose a "channel is open" hook. This works, but it's
// spamming attempts instead of reacting to a real event. Once connection.js
// exposes something like onClientReady(callback), replace this whole function
// with a single send triggered by that callback instead of a retry loop.

save.data.writePublic('playerID', 0, 'client.js');

async function joinUntilConfirmed() {
  let joined = false;

  pickupMessages(false, (msg) => {
    console.log('[client] received:', JSON.stringify(msg));

    if (msg.type === 'JOIN_RESPONSE' && msg.success) {
      joined = true;
      clearInterval(retryHandle);

      console.log('[debug] raw JOIN_RESPONSE:', JSON.stringify(msg));
      myPlayer.position = msg.position;
      myPlayer.velocity = msg.velocity;
      console.log('[client] initialized player:', myPlayer);
      startGame(myPlayer);
    }

    if (msg.type === 'POSITION_PLAYER' && msg.playerID === save.public.playerID) {
      console.log('[debug] raw POSITION_PLAYER:', JSON.stringify(msg));
      let correctionX = myPlayer.renderPos.x - msg.position.x;
      let correctionY = myPlayer.renderPos.y - msg.position.y;

      // safety clamp: if the gap between predicted and authoritative position
      // is absurdly large (bad prediction, huge lag spike, etc.), don't carry
      // that whole gap into a smoothed correction — clamp it and log so a
      // real bug shows up instead of silently flinging the player off-screen.
      const magnitude = Math.hypot(correctionX, correctionY);
      if (magnitude > MAX_CORRECTION_MAGNITUDE) {
        console.warn(`[client] position correction magnitude ${magnitude.toFixed(1)} exceeded MAX_CORRECTION_MAGNITUDE, clamping`);
        const scale = MAX_CORRECTION_MAGNITUDE / magnitude;
        correctionX *= scale;
        correctionY *= scale;
      }

      myPlayer.correction.x = correctionX;
      myPlayer.correction.y = correctionY;

      myPlayer.position = msg.position;
      myPlayer.velocity = msg.velocity;
      myPlayer.timeSinceUpdate = 0;
    }
  });

  const retryHandle = setInterval(() => {
    if (joined) return;
    sendMessage(false, 'JOIN_REQUEST', save.public.playerID);
  }, 300);
}

await joinUntilConfirmed();

// =============================================================================
// 🍽️  MEAT AND POTATOES — the real, keep-building-on-this stuff
// =============================================================================

// --- menu / UI ---

function hideAllMenus() {
  document.getElementById('menu-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('host-config-overlay').classList.add('hidden');
  document.getElementById('ui-area').style.display = 'none';
  document.getElementById('btn-settings').style.display = 'none';
}

// --- canvas setup ---

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- camera ---
// Three tracked positions, all in world units:
//   truepos     — always mirrors the player's actual position. Nothing drives
//                 this yet; call setTruePos(x, y) once server-driven player
//                 position exists.
//   lookaround  — offset toward wherever the mouse points, max magnitude
//                 LOOKAROUND_RANGE in either axis. Recomputed on mousemove.
//   renderpos   — truepos + lookaround. This is the ONLY one worldToScreen /
//                 screenToWorld / drawGrid should ever read.

const camera = {
  truepos: { x: 0, y: 0 },
  lookaround: { x: 0, y: 0 },
  renderpos: { x: 0, y: 0 },
};

const LOOKAROUND_RANGE = 1; // world units

function updateRenderPos() {
  camera.renderpos.x = camera.truepos.x + camera.lookaround.x;
  camera.renderpos.y = camera.truepos.y + camera.lookaround.y;
}

function updateLookaround() {
  const normX = (mouse.x / canvas.width) * 2 - 1;
  const normY = -((mouse.y / canvas.height) * 2 - 1); // screen-bottom = -1

  camera.lookaround.x = LOOKAROUND_RANGE * normX;
  camera.lookaround.y = -LOOKAROUND_RANGE * normY;

  updateRenderPos();
}

function setTruePos(x, y) {
  camera.truepos.x = x;
  camera.truepos.y = y;
  updateRenderPos();
}

const CAMERA_EASE_RATE = 3;

function updateCameraFollow(dt) {
  const factor = 1 - Math.exp(-CAMERA_EASE_RATE * dt);
  camera.truepos.x += (myPlayer.renderPos.x - camera.truepos.x) * factor;
  camera.truepos.y += (myPlayer.renderPos.y - camera.truepos.y) * factor;
  updateRenderPos();
}

// --- player state + rendering ---
// myPlayer tracks this client's own player as last reported by the server via
// POSITION_PLAYER. Camera stays static for now (setTruePos isn't called here)
// — see the camera comment above for when/how that gets wired up later.
//
// correction absorbs the gap between where renderPos had drifted to and
// where the server says the player actually is, then decays to zero over
// CORRECTION_DECAY_MS — this is what turns each update into a smooth catch-up
// instead of a visible snap. See predictPlayerPosition() below.

const PLAYER_RADIUS = 1; // world units
const PLAYER_BORDER_PX = 1;
const CORRECTION_DECAY_MS = 150; // how long a position correction takes to fully absorb
const MAX_CORRECTION_MAGNITUDE = 50; // world units — safety clamp, see correction comment below

const myPlayer = {
  position:  { x: 0, y: 0 },
  velocity:  { x: 0, y: 0 },
  renderPos: { x: 0, y: 0 },
  correction: { x: 0, y: 0 },
  timeSinceUpdate: 0
};

// greyscale the background color, then shift it to the opposite end of the
// brightness range — this keeps the border visibly contrasting against
// getBackgroundColor() no matter what color that's set to.
function getPlayerBorderColor() {
  const { r, g, b } = hexToRgb(save.public.backgroundColor);
  const grey = 0.299 * r + 0.587 * g + 0.114 * b; // perceptual luminance
  const contrast = (grey + 128) % 256;
  return `rgb(${contrast}, ${contrast}, ${contrast})`;
}

function drawPlayer() {
  const screenPos = worldToScreen(myPlayer.renderPos.x, myPlayer.renderPos.y);
  const radiusPx = PLAYER_RADIUS * getUnitPixelSize();

  ctx.beginPath();
  ctx.arc(screenPos.x, screenPos.y, radiusPx, 0, Math.PI * 2);
  ctx.fillStyle = '#3399ff';
  ctx.fill();
  ctx.lineWidth = PLAYER_BORDER_PX;
  ctx.strokeStyle = getPlayerBorderColor();
  ctx.stroke();
}

// --- grid rendering ---
// Rule: 60 units always visible across the screen width, UNLESS that would
// shrink each unit below 15px, in which case units are locked to 15px and
// however many fit is however many you see. Grid is square, so vertical
// unit count just falls out of whatever unitPixelSize ends up being.

function getUnitPixelSize() {
  return Math.max(canvas.width / 60, 15);
}

function drawGrid() {
  const unitSize = getUnitPixelSize();

  ctx.fillStyle = getBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = getGridlineColor();
  ctx.lineWidth = 1;

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const offsetX = centerX - (camera.renderpos.x * unitSize) % unitSize;
  const offsetY = centerY - (camera.renderpos.y * unitSize) % unitSize;

  ctx.beginPath();
  for (let x = offsetX % unitSize; x < canvas.width; x += unitSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  for (let y = offsetY % unitSize; y < canvas.height; y += unitSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();
}

function screenToWorld(screenX, screenY) {
  const unitSize = getUnitPixelSize();
  return {
    x: camera.renderpos.x + (screenX - canvas.width / 2) / unitSize,
    y: camera.renderpos.y + (screenY - canvas.height / 2) / unitSize,
  };
}

function worldToScreen(worldX, worldY) {
  const unitSize = getUnitPixelSize();
  return {
    x: canvas.width / 2 + (worldX - camera.renderpos.x) * unitSize,
    y: canvas.height / 2 + (worldY - camera.renderpos.y) * unitSize,
  };
}

// --- raw key/mouse state tracking ---
// tracks exactly what's currently physically held down, independent of
// which action(s) that key maps to — resolved against keybinds below.

const heldKeys = new Set();

window.addEventListener('keydown', (e) => heldKeys.add(keyEventToBindString(e)));
window.addEventListener('keyup', (e) => heldKeys.delete(keyEventToBindString(e)));
window.addEventListener('mousedown', (e) => {
  const bind = mouseButtonToBindString(e.button);
  if (bind) heldKeys.add(bind);
});
window.addEventListener('mouseup', (e) => {
  const bind = mouseButtonToBindString(e.button);
  if (bind) heldKeys.delete(bind);
});

function isActionPressed(action) {
  return save.public.keybinds[action].some(bind => heldKeys.has(bind));
}

const mouse = { x: 0, y: 0, moved: false }; // screen-space pixels, canvas-relative

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  mouse.moved = true;
  updateLookaround();
});

// --- TEMP DEBUG: dump everything that could affect player rendering ---
// drop-in diagnostic, remove once the render bug is found
window.addEventListener('click', () => {
  const screenPos = worldToScreen(myPlayer.renderPos.x, myPlayer.renderPos.y);
  console.log('[debug] player render dump', {
    myPlayer: {
      position: { ...myPlayer.position },
      velocity: { ...myPlayer.velocity },
      renderPos: { ...myPlayer.renderPos },
      correction: { ...myPlayer.correction },
      timeSinceUpdate: myPlayer.timeSinceUpdate,
    },
    camera: {
      truepos: { ...camera.truepos },
      lookaround: { ...camera.lookaround },
      renderpos: { ...camera.renderpos },
    },
    canvas: { width: canvas.width, height: canvas.height },
    unitPixelSize: getUnitPixelSize(),
    computedScreenPos: screenPos,
    onCanvas: screenPos.x >= 0 && screenPos.x <= canvas.width && screenPos.y >= 0 && screenPos.y <= canvas.height,
    radiusPx: PLAYER_RADIUS * getUnitPixelSize(),
    fillStyle: '#3399ff',
    borderColor: getPlayerBorderColor(),
    backgroundColor: save.public.backgroundColor,
    gameloopIsTrueGameloop: gameloop === TRUE_GAMELOOP,
    playerID: save.public.playerID,
  });
});

// --- returnInputs: set/toggle encoding ---

const INPUT_ORDER = ['left', 'right', 'up', 'down', 'fire', 'reload', 'ability'];
const SET_INTERVAL_MS = 500;

let setAccumulator = 0;
let lastInputState = INPUT_ORDER.map(() => false);

function returnInputs(dt) {
  const currentState = INPUT_ORDER.map(isActionPressed);
  setAccumulator += dt * 1000;

  let code;

  if (setAccumulator >= SET_INTERVAL_MS) {
    setAccumulator %= SET_INTERVAL_MS;

    code = 0b10000000; // leading 1 = set code
    currentState.forEach((pressed, i) => {
      if (pressed) code |= (1 << (6 - i));
    });
  } else {
    code = 0b00000000; // leading 0 = toggle code
    currentState.forEach((pressed, i) => {
      if (pressed !== lastInputState[i]) code |= (1 << (6 - i));
    });
  }

  lastInputState = currentState;
  return code;
}

function sendInputs(dt) {
  const inputs = returnInputs(dt);

  if (inputs !== 0) {
    sendMessage(false, 'PLAYER_INPUTS', save.public.playerID, inputs);
  }

  if (mouse.moved) {
    console.log(`[client] mouse moved.  sending PLAYER_AIM: ${screenToWorld(mouse.x, mouse.y)}`);
    sendMessage(false, 'PLAYER_AIM', save.public.playerID, screenToWorld(mouse.x, mouse.y));
    mouse.moved = false;
  }
}

// --- game loop ---

function startGame(playerInfo) {
  gameloop = TRUE_GAMELOOP;
  hideAllMenus();
}

function predictPlayerPosition(dt) {
    myPlayer.timeSinceUpdate += dt;

    const predictedX = myPlayer.position.x + myPlayer.velocity.x * myPlayer.timeSinceUpdate;
    const predictedY = myPlayer.position.y + myPlayer.velocity.y * myPlayer.timeSinceUpdate;

    let nextX = predictedX + myPlayer.correction.x;
    let nextY = predictedY + myPlayer.correction.y;

    // guard: if anything upstream produced NaN/Infinity, fall back to the
    // last known-good authoritative position rather than drawing garbage
    // (or nothing at all, since canvas silently no-ops on NaN coordinates).
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
      console.warn('[client] renderPos went non-finite, resetting to authoritative position', { predictedX, predictedY, correction: { ...myPlayer.correction } });
      nextX = myPlayer.position.x;
      nextY = myPlayer.position.y;
      myPlayer.correction.x = 0;
      myPlayer.correction.y = 0;
    }

    myPlayer.renderPos.x = nextX;
    myPlayer.renderPos.y = nextY;

    // decay the leftover correction back to zero over CORRECTION_DECAY_MS
    const decay = Math.max(1 - dt * 1000 / CORRECTION_DECAY_MS, 0);
    myPlayer.correction.x *= decay;
    myPlayer.correction.y *= decay;
}

const EMPTY_GAMELOOP = (dt) => { return; };
const TRUE_GAMELOOP = (dt) => {
  sendInputs(dt);
  predictPlayerPosition(dt);
  updateCameraFollow(dt);
  drawPlayer();
};

let gameloop = EMPTY_GAMELOOP;

function clientloop(currentTime, lastTime) {
  const dt = (currentTime - lastTime) / 1000;

  drawGrid();
  gameloop(dt);

  requestAnimationFrame((t) => clientloop(t, currentTime));
}

requestAnimationFrame((t) => clientloop(t, 0));