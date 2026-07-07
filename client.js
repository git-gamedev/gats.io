// client.js
// Main game client: connects to the in-page server worker, fetches and
// bakes static world data (boxes, dimensions, arena size) once at load,
// tracks this client's own player (predicted position + server corrections),
// and runs the per-frame client loop that drives the camera, background
// drawing, and (once a game has started) input sending, prediction, and
// player/UI drawing.

// renderBoxes — the flat, render-ready box array baked once at load (see
// bakeRenderBoxes below).
let renderBoxes = null;

// renderBoxesByMinX — the spatial index over renderBoxes, built via
// spatialIndex.js's buildIndexByMinX — same shared logic the server uses for
// its own box index, see spatialIndex.js's header comment.
let renderBoxesByMinX = [];

// arenaSize — the arena's play-field dimensions as fetched from the server,
// or null until that fetch resolves.
let arenaSize = null;

// canvas — the main game canvas element.
const canvas = document.getElementById('game-canvas');

// ctx — the main game canvas's 2D rendering context.
const ctx = canvas.getContext('2d');

// minimap — the minimap canvas element.
const minimap = document.getElementById('mini-map');

// minictx — the minimap canvas's 2D rendering context.
const minictx = minimap.getContext('2d');

// MINIMAP_DOT_RADIUS — radius, in pixels, of the player dot drawn on the
// minimap.
const MINIMAP_DOT_RADIUS = 4;

// MINIMAP_DOT_COLOR — fill color of the minimap player dot; matches the main
// player's fill color.
const MINIMAP_DOT_COLOR = '#3399ff';

// MINIMAP_BORDER_THICKNESS_PX — thickness, in pixels, of the minimap's own
// border.
const MINIMAP_BORDER_THICKNESS_PX = 5;

// PLAYER_RADIUS — this client's player radius, in world units.
const PLAYER_RADIUS = 1;

// PLAYER_BORDER_PX — thickness, in pixels, of the player circle's border.
const PLAYER_BORDER_PX = 2;

// CORRECTION_DECAY_MS — how long, in milliseconds, a position correction
// takes to fully absorb/decay to zero.
const CORRECTION_DECAY_MS = 150;

// MAX_CORRECTION_MAGNITUDE — safety clamp, in world units, on how large a
// single position correction is allowed to be (see the POSITION_PLAYER
// handler below for why).
const MAX_CORRECTION_MAGNITUDE = 50;

// myPlayer — tracks this client's own player as last reported by the server
// via POSITION_PLAYER, plus locally-predicted renderPos and a decaying
// correction absorbing the gap between predicted and authoritative position
// (see predictPlayerPosition in rendering.js). Camera stays static for now
// (setTruePos isn't called here) — see the camera comment further below for
// when/how that gets wired up later.
const myPlayer = {
  position:  { x: 0, y: 0 },
  velocity:  { x: 0, y: 0 },
  renderPos: { x: 0, y: 0 },
  correction: { x: 0, y: 0 },
  timeSinceUpdate: 0
};

// BOX_FILL_COLOR_SQUARE — fill color for square boxes.
const BOX_FILL_COLOR_SQUARE = '#8a6d3b';

// BOX_FILL_COLOR_SKINNY — fill color for non-square ("long") boxes.
const BOX_FILL_COLOR_SKINNY = '#5c6b7a';

// BOX_BORDER_THICKNESS_UNITS — box border thickness, in game units; inset
// rather than centered (see drawBoxes in rendering.js for why).
const BOX_BORDER_THICKNESS_UNITS = 0.3;

// VIEW_CULL_MARGIN — extra margin, in world units, added to the view rect
// used for box culling; comfortably more than half the widest box (2.5).
const VIEW_CULL_MARGIN = 5;

// ARENA_BORDER_THICKNESS_UNITS — arena border thickness, in game units; must
// match server.js's ARENA_BORDER_THICKNESS.
const ARENA_BORDER_THICKNESS_UNITS = 0.5;

// EMPTY_GAMELOOP — no-op per-frame gameloop, active before a game has
// started.
const EMPTY_GAMELOOP = (dt) => { return; };

// TRUE_GAMELOOP — the real per-frame gameloop, active once a game has
// started: sends inputs, predicts this client's player position, and draws
// the player, arena border, and minimap.
const TRUE_GAMELOOP = (dt) => {
  sendInputs(dt);
  predictPlayerPosition(dt);
  drawPlayer();
  drawArenaBorder();
  drawMinimap();
};

// gameloop — the currently active per-frame gameloop function, swapped from
// EMPTY_GAMELOOP to TRUE_GAMELOOP by startGame.
let gameloop = EMPTY_GAMELOOP;

// boxAABB — returns a world box's AABB extent, computed from its center
// position and width/height.
function boxAABB(box) {
  return {
    minX: box.x - box.width / 2,
    maxX: box.x + box.width / 2,
    minY: box.y - box.height / 2,
    maxY: box.y + box.height / 2,
  };
}

// buildRenderBoxIndex — (re)builds renderBoxesByMinX from the current
// renderBoxes array, using spatialIndex.js's shared buildIndexByMinX.
function buildRenderBoxIndex() {
  renderBoxesByMinX = buildIndexByMinX(renderBoxes, boxAABB);
}

// bakeRenderBoxes — converts the server's plain box array (type/position/
// rotated only) into the flat, render-ready array drawBoxes expects, by
// looking up each box's actual { width, height } from the BOX_DIMENSIONS
// lookup table fetched separately from the server.
async function bakeRenderBoxes(boxes, dimensions) {
  return boxes.map(box => {
    const entry = dimensions[box.type];
    const { width, height } = ('width' in entry) ? entry : (box.rotated ? entry.rotated : entry.unrotated);
    return { x: box.position.x, y: box.position.y, width, height };
  });
}

// startGame — swaps in the real gameloop and hides all menus. Called once
// the server confirms this client has joined.
function startGame(playerInfo) {
  gameloop = TRUE_GAMELOOP;
  hideAllMenus();
}

// clientloop — the main per-frame loop, driven by requestAnimationFrame.
// Settles the camera first (before anything reads camera.renderpos this
// frame), draws the background grid and world boxes (always, menu or not),
// then runs whichever gameloop is currently active, and schedules its own
// next frame.
function clientloop(currentTime, lastTime) {
  const dt = (currentTime - lastTime) / 1000;

  updateCameraFollow(dt, myPlayer); // camera settled BEFORE anything reads renderpos this frame

  drawGrid();
  drawBoxes();
  gameloop(dt);

  requestAnimationFrame((t) => clientloop(t, currentTime));
}

// register this client's playerID (currently hardcoded to 0) into save.data
save.data.writePublic('playerID', 0, 'client.js');

// once the client<->server data channel is open, load world data (boxes,
// dimensions, arena size) in parallel, bake the render box array and its
// spatial index, and register handlers for JOIN_RESPONSE (which starts the
// game) and POSITION_PLAYER (which applies a clamped correction toward the
// server's authoritative position)
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

// canvas setup: size the main canvas to the window (resizing on window
// resize) and give the minimap its fixed 200x200 backing resolution
(canvas_setup = function() {
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  //Resize Minimap:
  minimap.width = 200;
  minimap.height = 200;
})();

// kick off the main per-frame client loop
requestAnimationFrame((t) => clientloop(t, 0));