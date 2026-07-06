// client.js

save.data.writePublic('playerID', 0, 'client.js');

// renderBoxes is the flat, render-ready box array baked once at load (see
// bakeRenderBoxes below). renderBoxesByMinX is the spatial index over it,
// built via spatialIndex.js's buildIndexByMinX — same shared logic the
// server uses for its own box index, see spatialIndex.js's header comment.
let renderBoxes = null;
let renderBoxesByMinX = [];

function boxAABB(box) {
  return {
    minX: box.x - box.width / 2,
    maxX: box.x + box.width / 2,
    minY: box.y - box.height / 2,
    maxY: box.y + box.height / 2,
  };
}

function buildRenderBoxIndex() {
  renderBoxesByMinX = buildIndexByMinX(renderBoxes, boxAABB);
}

let arenaSize = null;

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


// --- canvas setup ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const minimap = document.getElementById('mini-map');
const minictx = minimap.getContext('2d');

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

const MINIMAP_DOT_RADIUS = 4; // px
const MINIMAP_DOT_COLOR = '#3399ff'; // matches player fill
const MINIMAP_BORDER_THICKNESS_PX = 5;

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

const BOX_FILL_COLOR_SQUARE = '#8a6d3b';
const BOX_FILL_COLOR_SKINNY = '#5c6b7a'; // grey-blue for non-square boxes
const BOX_BORDER_THICKNESS_UNITS = 0.3; // game units, see drawBoxes for why this is inset rather than centered
const VIEW_CULL_MARGIN = 5; // world units, comfortably more than half the widest box (2.5)

const ARENA_BORDER_THICKNESS_UNITS = 0.5; // game units, must match server.js's ARENA_BORDER_THICKNESS


// --- game loop ---

function startGame(playerInfo) {
  gameloop = TRUE_GAMELOOP;
  hideAllMenus();
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

  updateCameraFollow(dt, myPlayer); // camera settled BEFORE anything reads renderpos this frame

  drawGrid();
  drawBoxes();
  gameloop(dt);

  requestAnimationFrame((t) => clientloop(t, currentTime));
}

requestAnimationFrame((t) => clientloop(t, 0));