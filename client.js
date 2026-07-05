// client.js

save.data.writePublic('playerID', 0, 'client.js');

// --- connection lifecycle ---
// onClientReady fires once, the moment the WebRTC data channel actually
// opens (see connection.js) — this replaces the old joinUntilConfirmed
// retry-on-a-timer workaround entirely. Connecting to the server and
// joining the game are now two separate, explicit steps:
//   1. onClientReady  -> register the message handler, fetch data needed
//                        for rendering/menus (box layout) via a one-shot
//                        REQUEST_DATA, but do NOT send JOIN_REQUEST yet.
//   2. btn-play click -> send JOIN_REQUEST exactly once, on demand.
// JOIN_RESPONSE/POSITION_PLAYER handling is registered in step 1 so it's
// ready and listening well before the player ever clicks Play.

// renderBoxes is the ONLY thing drawBoxes() ever reads. It's built once, via
// bakeRenderBoxes() below, by combining the raw box instances (BOXES) with
// the shape lookup table (BOX_DIMENSIONS) — width/height per box is resolved
// exactly once here, not recomputed every frame. drawBoxes() becomes a flat
// loop over pre-resolved { x, y, width, height } entries: zero lookup cost
// per frame, forever, since neither source ever changes after initial load.
let renderBoxes = null;

// renderBoxesByMinX mirrors the server's boxesByMinX spatial index (see
// server.js) — same reasoning applies here: boxes are static after load, so
// this is built once, and only the X axis needs sorting since a binary
// search on X narrows hundreds of boxes down to a small handful near the
// camera, then a linear scan filters that handful by Y. Used by
// getVisibleBoxes() below to skip boxes outside the current view instead of
// looping over every box every frame.
let renderBoxesByMinX = [];

function buildRenderBoxIndex() {
  renderBoxesByMinX = renderBoxes
    .map((box, i) => ({
      i,
      minX: box.x - box.width / 2,
      maxX: box.x + box.width / 2,
      minY: box.y - box.height / 2,
      maxY: box.y + box.height / 2,
    }))
    .sort((a, b) => a.minX - b.minX);
}

// index of the first entry in renderBoxesByMinX whose minX is >= x
function findBoxInsertionIndex(x) {
  let lo = 0, hi = renderBoxesByMinX.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (renderBoxesByMinX[mid].minX < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// returns the renderBoxes entries whose AABB overlaps the given world-space
// view rect — same broad-phase shape as the server's getCandidateBoxes:
// binary search to the insertion point on X, walk outward until minX falls
// outside the view, then linear-scan that small window for real overlap
// (X range already guaranteed close, so this scan only needs to check Y —
// plus a final X-max check for boxes whose minX qualified but that are wide
// enough to still stick out past viewMaxX on their own).
function getVisibleBoxes(viewMinX, viewMaxX, viewMinY, viewMaxY) {
  const insertAt = findBoxInsertionIndex(viewMinX);
  const candidates = [];

  // entries at/after the insertion point: walk right while minX still fits
  // inside the view's right edge
  for (let k = insertAt; k < renderBoxesByMinX.length; k++) {
    const c = renderBoxesByMinX[k];
    if (c.minX > viewMaxX) break;
    candidates.push(c);
  }
  // entries before the insertion point can still overlap the view on the
  // left edge (their minX is less than viewMinX but their maxX might still
  // be inside, or past, it) — walk left while maxX still reaches the view
  for (let k = insertAt - 1; k >= 0; k--) {
    const c = renderBoxesByMinX[k];
    if (c.maxX < viewMinX) break;
    candidates.push(c);
  }

  return candidates
    .filter(c => c.minY <= viewMaxY && c.maxY >= viewMinY)
    .map(c => renderBoxes[c.i]);
}

// arena play-field size as reported by the server, resolved once at load and
// read every frame by drawArenaBorder/the clip step in drawGrid. Same
// resolved-once-at-load pattern as renderBoxes above — null until the
// ARENA_SIZE fetch below resolves.
let arenaSize = null;

// combines box instances with the dimensions table into a flat, render-ready
// array. Kept as its own function (rather than inlined into onClientReady)
// so it's easy to re-run later if box data ever becomes something that CAN
// change post-load (e.g. destructible boxes) — right now it only ever runs
// once, but the seam is there if that assumption changes.
async function bakeRenderBoxes(boxes, dimensions) {
  return boxes.map(box => {
    const entry = dimensions[box.type];
    const { width, height } = ('width' in entry) ? entry : (box.rotated ? entry.rotated : entry.unrotated);
    return { x: box.position.x, y: box.position.y, width, height };
  });
}

onClientReady(async () => {
  console.log('[client] connection open, loading world data');

  pickupMessages(false, (msg) => {
    console.log('[client] received:', JSON.stringify(msg));

    if (msg.type === 'JOIN_RESPONSE' && msg.success) {
      console.log('[debug] raw JOIN_RESPONSE:', JSON.stringify(msg));
      myPlayer.position = msg.position;
      myPlayer.velocity = msg.velocity;
      console.log('[client] initialized player:', myPlayer);
      startGame(myPlayer);
    }

    if (msg.type === 'POSITION_PLAYER' && msg.playerID === save.public.playerID) {
      console.log('[debug] raw POSITION_PLAYER:', JSON.stringify(msg));
      let correctionX = Math.min(Math.max(myPlayer.renderPos.x - msg.position.x, -0.05), 0.05);
      let correctionY = Math.min(Math.max(myPlayer.renderPos.y - msg.position.y, -0.05), 0.05);

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

  // fetched in parallel — neither depends on the other, no reason to
  // serialize independent round-trips
  const [boxes, dimensions, fetchedArenaSize] = await Promise.all([
    requestData('BOXES', 'once'),
    requestData('BOX_DIMENSIONS', 'once'),
    requestData('ARENA_SIZE', 'once'),
  ]);
  renderBoxes = await bakeRenderBoxes(boxes, dimensions);
  buildRenderBoxIndex();
  arenaSize = fetchedArenaSize;
  console.log('[client] baked render boxes:', renderBoxes);
  console.log('[client] arena size:', arenaSize);
});

// btn-play sends JOIN_REQUEST exactly once, whenever the player actually
// wants to start — no longer tied to connection open, and no longer a
// retry loop. If the player clicks before the channel is open, sendMessage
// will just log a DROPPED message (see connection.js's _sendReal), which is
// an acceptable edge case for now since Play is only ever shown post-connect
// in the current menu flow.
document.getElementById('btn-play').addEventListener('click', () => {
  sendMessage(false, 'JOIN_REQUEST', save.public.playerID);
});

// =============================================================================
// 🍽️  MEAT AND POTATOES — the real, keep-building-on-this stuff
// =============================================================================

// --- menu / UI ---

function hideAllMenus() {
  document.getElementById('menu-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('host-config-overlay').classList.add('hidden');
  document.getElementById('mini-map').classList.remove('hidden');
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

const minimap = document.getElementById('mini-map');
const minictx = minimap.getContext('2d');

(function resizeMinimap() {
  minimap.width = 200;
  minimap.height = 200;
})();

const MINIMAP_DOT_RADIUS = 4; // px
const MINIMAP_DOT_COLOR = '#3399ff'; // matches player fill

const MINIMAP_BORDER_THICKNESS_PX = 5;

function drawMinimap() {
  minictx.clearRect(0, 0, minimap.width, minimap.height);
  minictx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  minictx.fillRect(0, 0, minimap.width, minimap.height);

  minictx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  minictx.lineWidth = MINIMAP_BORDER_THICKNESS_PX;
  minictx.strokeRect(
    MINIMAP_BORDER_THICKNESS_PX / 2,
    MINIMAP_BORDER_THICKNESS_PX / 2,
    minimap.width - MINIMAP_BORDER_THICKNESS_PX,
    minimap.height - MINIMAP_BORDER_THICKNESS_PX
  );

  if (arenaSize) {
    const relX = (myPlayer.renderPos.x + arenaSize.width / 2) / arenaSize.width;
    const relY = (myPlayer.renderPos.y + arenaSize.height / 2) / arenaSize.height;

    minictx.beginPath();
    minictx.arc(relX * minimap.width, relY * minimap.height, MINIMAP_DOT_RADIUS, 0, Math.PI * 2);
    minictx.fillStyle = MINIMAP_DOT_COLOR;
    minictx.fill();
  }
}

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
const PLAYER_BORDER_PX = 2;
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

// world-space corners of the arena's playable interior (i.e. inside the
// border, matching where drawArenaBorder's inset stroke sits) — returns null
// if arenaSize hasn't resolved yet, same not-ready convention as renderBoxes
function getArenaInteriorWorldRect() {
  if (!arenaSize) return null;
  return {
    minX: -arenaSize.width / 2,
    maxX: arenaSize.width / 2,
    minY: -arenaSize.height / 2,
    maxY: arenaSize.height / 2,
  };
}

// clips all subsequent drawing to the arena's screen-space rectangle, for
// the duration of fn. Used to give grid lines and boxes a hard "picture
// frame" cutoff at the arena edge — this clip is defined in WORLD space and
// converted through worldToScreen, so it stays correct under camera motion,
// unlike a canvas-space clip which would have to be recomputed by hand every
// time the camera moved.
function withArenaClip(fn) {
  const rect = getArenaInteriorWorldRect();
  if (!rect) {
    fn(); // arena size not loaded yet — draw unclipped rather than draw nothing
    return;
  }

  const topLeft = worldToScreen(rect.minX, rect.minY);
  const bottomRight = worldToScreen(rect.maxX, rect.maxY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Math.min(topLeft.x, bottomRight.x),
    Math.min(topLeft.y, bottomRight.y),
    Math.abs(bottomRight.x - topLeft.x),
    Math.abs(bottomRight.y - topLeft.y)
  );
  ctx.clip();
  fn();
  ctx.restore();
}

function drawGrid() {
  const unitSize = getUnitPixelSize();

  // full-canvas background fill happens OUTSIDE the arena clip — this is
  // the "typical background color" visible past the frame edge, and it must
  // stay full-canvas regardless of arena size/position so there's never an
  // unpainted gap between the frame and the screen edge
  ctx.fillStyle = getBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  withArenaClip(() => {
    ctx.strokeStyle = getGridlineColor();
    ctx.lineWidth = 1;

    // rounded for the same reason worldToScreen rounds its output — see that
    // function's comment. Gridlines don't go through worldToScreen (they're
    // built directly from a repeating offset, not per-point world
    // coordinates), so they need the same snap applied here explicitly or
    // they'd "flex" independently of, and inconsistently with, everything
    // that does go through worldToScreen.
    const centerX = Math.round(canvas.width / 2);
    const centerY = Math.round(canvas.height / 2);
    const offsetX = centerX - Math.round(camera.renderpos.x * unitSize) % unitSize;
    const offsetY = centerY - Math.round(camera.renderpos.y * unitSize) % unitSize;

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
  });
}

function screenToWorld(screenX, screenY) {
  const unitSize = getUnitPixelSize();
  return {
    x: camera.renderpos.x + (screenX - canvas.width / 2) / unitSize,
    y: camera.renderpos.y + (screenY - canvas.height / 2) / unitSize,
  };
}

// Rounded to whole device pixels before returning. worldToScreen is used
// ONLY for drawing (grid clip rect, boxes, arena border, player) — never for
// input math, which goes through screenToWorld instead and stays
// unsnapped/exact. Without this rounding, a continuously-moving camera
// means every one of those draw positions lands on a different fractional
// pixel offset every frame; canvas antialiases thin strokes (the arena
// border, box borders, gridlines) differently depending on exactly where
// that fraction falls, which is what reads as the border "flexing" while
// panning — it's not actually moving, it's re-antialiasing to a slightly
// different sub-pixel position every frame. Rounding once, here, means
// every caller that draws the same world point in the same frame (e.g. a
// box's border relative to its own fill) still agrees with itself, since
// they all go through this same rounding rather than each accumulating
// their own independent fractional drift.
function worldToScreen(worldX, worldY) {
  const unitSize = getUnitPixelSize();
  return {
    x: canvas.width / 2 + (worldX - camera.renderpos.x) * unitSize,
    y: canvas.height / 2 + (worldY - camera.renderpos.y) * unitSize,
  };
}

// --- box rendering ---
// renderBoxes (built once by bakeRenderBoxes, see above) already has
// width/height resolved per entry — nothing here does a lookup or touches
// boxDimensions/BOXES directly. This loop is the entire per-frame cost:
// no branch, no table lookup, just reading pre-resolved numbers.

const BOX_FILL_COLOR_SQUARE = '#8a6d3b';
const BOX_FILL_COLOR_SKINNY = '#5c6b7a'; // grey-blue for non-square boxes
const BOX_BORDER_THICKNESS_UNITS = 0.3; // game units, see drawBoxes for why this is inset rather than centered

// contrast border color, same greyscale-then-flip logic as
// getPlayerBorderColor() in the player-rendering section above — kept as a
// separate function since it has no player-specific dependency, but if this
// pattern is needed a third time it should probably be pulled into one
// shared helper both call
function getBoxBorderColor() {
  const { r, g, b } = hexToRgb(save.public.backgroundColor);
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  const contrast = (grey + 128) % 256;
  return `rgb(${contrast}, ${contrast}, ${contrast})`;
}

// Boxes are axis-aligned (rotation locked to 0°/90° server-side), so this is
// plain rect drawing in screen space — no canvas rotation transform needed,
// same reasoning the server used to justify plain AABB collision math.
//
// Wrapped in withArenaClip (same helper drawGrid uses) so a box straddling
// or sitting outside the arena boundary gets cut off at the frame edge
// rather than drawing into the outside-background area. As of server.js's
// spawnBoxes rework, boxes are guaranteed to spawn fully inside the arena
// interior already, so in practice this clip mostly guards against future
// changes (e.g. destructible/movable boxes) rather than papering over
// today's spawn logic.
//
// Boxes are also culled to the current view rect before this loop even
// runs (see getViewWorldRect/getVisibleBoxes above) — the clip below still
// matters for boxes that are IN view but straddle the arena edge.
// world-space view rect currently visible on screen, expanded by margin so
// a box just outside the frustum doesn't visibly pop in/out right at the
// edge (its far corner can still be up to half a box-width past what's
// nominally "visible" before it's actually fully offscreen). Recomputed
// fresh each call rather than cached — cheap arithmetic, and it has to
// track the camera every frame anyway.
const VIEW_CULL_MARGIN = 5; // world units, comfortably more than half the widest box (2.5)

function getViewWorldRect() {
  const unitSize = getUnitPixelSize();
  const halfWidthWorld = (canvas.width / 2) / unitSize;
  const halfHeightWorld = (canvas.height / 2) / unitSize;

  return {
    minX: camera.renderpos.x - halfWidthWorld - VIEW_CULL_MARGIN,
    maxX: camera.renderpos.x + halfWidthWorld + VIEW_CULL_MARGIN,
    minY: camera.renderpos.y - halfHeightWorld - VIEW_CULL_MARGIN,
    maxY: camera.renderpos.y + halfHeightWorld + VIEW_CULL_MARGIN,
  };
}

function drawBoxes() {
  if (!renderBoxes) return; // not baked yet (fetch + bakeRenderBoxes hasn't resolved)

  withArenaClip(() => {
    const unitSize = getUnitPixelSize();
    const borderPx = BOX_BORDER_THICKNESS_UNITS * unitSize;
    const borderColor = getBoxBorderColor();

    const view = getViewWorldRect();
    const visibleBoxes = getVisibleBoxes(view.minX, view.maxX, view.minY, view.maxY);

    for (const box of visibleBoxes) {
      const isSquare = box.width === box.height;
      const topLeft = worldToScreen(box.x - box.width / 2, box.y - box.height / 2);
      const wPx = box.width * unitSize;
      const hPx = box.height * unitSize;

      // fill first, full box size — this is the hitbox, unaffected by border
      ctx.fillStyle = isSquare ? BOX_FILL_COLOR_SQUARE : BOX_FILL_COLOR_SKINNY;
      ctx.fillRect(topLeft.x, topLeft.y, wPx, hPx);

      // border second, drawn INSET by half its own width so the stroke's
      // outer edge lands exactly on the hitbox boundary. ctx.strokeRect
      // centers the stroke on the path it's given — half the lineWidth draws
      // outside that path, half inside — so stroking the box's own edges at
      // full lineWidth would push borderPx/2 outside the hitbox on every
      // side. Shrinking the stroked rect inward by borderPx/2 on each edge
      // cancels that outward half, keeping the whole border within bounds.
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderPx;
      ctx.strokeRect(
        topLeft.x + borderPx / 2,
        topLeft.y + borderPx / 2,
        wPx - borderPx,
        hPx - borderPx
      );
    }
  });
}

// --- arena border ---
// Drawn as a TOP-LEVEL render step (see clientloop) — always on top of grid,
// boxes, and player, since it's the physical edge of the playable world and
// nothing should visually read as being in front of it. Reuses
// getBoxBorderColor's contrast logic (arena border and box borders share the
// same "always readable against whatever background color is set" goal) and
// the same inset-stroke technique from drawBoxes, for the same reason: a
// centered strokeRect would draw half its width outside the arena's actual
// boundary, which here would mean drawing believable-looking wall INTO the
// area that's supposed to read as "outside the world, plain background".
const ARENA_BORDER_THICKNESS_UNITS = 0.5; // game units, must match server.js's ARENA_BORDER_THICKNESS

function drawArenaBorder() {
  if (!arenaSize) return; // not fetched yet

  const unitSize = getUnitPixelSize();
  const borderPx = ARENA_BORDER_THICKNESS_UNITS * unitSize;

  const topLeft = worldToScreen(-arenaSize.width / 2, -arenaSize.height / 2);
  const bottomRight = worldToScreen(arenaSize.width / 2, arenaSize.height / 2);
  const wPx = bottomRight.x - topLeft.x;
  const hPx = bottomRight.y - topLeft.y;

  // inset by half the border width on every side, same reasoning as
  // drawBoxes' strokeRect call — keeps the border fully within the arena's
  // actual boundary line rather than straddling it
  ctx.strokeStyle = getBoxBorderColor();
  ctx.lineWidth = borderPx;
  ctx.strokeRect(
    topLeft.x - borderPx / 2,
    topLeft.y - borderPx / 2,
    wPx + borderPx,
    hPx + borderPx
  );
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
let lastInputState = INPUT_ORDER.map(() => false);

function returnInputs() {
  const currentState = INPUT_ORDER.map(isActionPressed);

  let code = 0b10000000; // always a set packet

  currentState.forEach((pressed, i) => {
    if (pressed) code |= (1 << (6 - i));
  });

  lastInputState = currentState;
  return code;
}

function sendInputs() {
  const inputs = returnInputs();

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
  drawPlayer();
  drawArenaBorder();
  drawMinimap();
};

let gameloop = EMPTY_GAMELOOP;

function clientloop(currentTime, lastTime) {
  const dt = (currentTime - lastTime) / 1000;

  updateCameraFollow(dt); // camera settled BEFORE anything reads renderpos this frame

  drawGrid();
  drawBoxes();
  gameloop(dt);

  requestAnimationFrame((t) => clientloop(t, currentTime));
}

requestAnimationFrame((t) => clientloop(t, 0));