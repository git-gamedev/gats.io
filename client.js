// client.js
// owns the canvas: camera, the world-space grid, and (eventually) the game
// loop + player info rendering. exposes initClient() which script.js calls
// once the UI is ready.

let canvas;
let ctx;

// the camera is a position in world/map units (not pixels).
// it always shows exactly CAMERA_WIDTH_UNITS worth of horizontal space;
// vertical span is whatever that scale works out to for the canvas height,
// so a grid unit is always a square on screen.
const CAMERA_WIDTH_UNITS = 60;
const camera = { x: 0, y: 0 }; // world coords the canvas is centered on

// world -> screen pixel scale, recalculated whenever the canvas resizes
let scale = 1;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  scale = canvas.width / CAMERA_WIDTH_UNITS;
}

// moves the camera to a given world position. the game loop picks up the
// change on its next frame - this is the one thing client.js currently
// manages, later this will be driven by player movement instead of called
// directly.
function setCameraPosition(x, y) {
  camera.x = x;
  camera.y = y;
}

function drawGrid() {
  const halfWidthUnits = CAMERA_WIDTH_UNITS / 2;
  const halfHeightUnits = (canvas.height / scale) / 2;

  const worldLeft = camera.x - halfWidthUnits;
  const worldRight = camera.x + halfWidthUnits;
  const worldTop = camera.y - halfHeightUnits;
  const worldBottom = camera.y + halfHeightUnits;

  ctx.lineWidth = 1;
  ctx.strokeStyle = getGridlineColor(); // same color/opacity/thickness for every line, incl. 0,0

  // vertical lines: one per whole unit of x currently in view.
  // computed from world x directly (not accumulated per-frame), so the
  // line at x=0 is always exactly where the map origin is.
  const startX = Math.floor(worldLeft);
  const endX = Math.ceil(worldRight);
  for (let x = startX; x <= endX; x++) {
    const screenX = (x - camera.x) * scale + canvas.width / 2;
    ctx.beginPath();
    ctx.moveTo(screenX, 0);
    ctx.lineTo(screenX, canvas.height);
    ctx.stroke();
  }

  // horizontal lines: same idea for y.
  const startY = Math.floor(worldTop);
  const endY = Math.ceil(worldBottom);
  for (let y = startY; y <= endY; y++) {
    const screenY = (y - camera.y) * scale + canvas.height / 2;
    ctx.beginPath();
    ctx.moveTo(0, screenY);
    ctx.lineTo(canvas.width, screenY);
    ctx.stroke();
  }
}

function draw(now) {
  ctx.fillStyle = getBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  updateInputMessage(now);
}

// runs every frame: redraws the canvas based on current state (camera, etc).
// later this is also where player/entity updates will happen before drawing.
// `now` is the rAF-provided timestamp, threaded through to draw() so
// updateInputMessage can track its own 500ms "set message" interval.
function gameLoop(now) {
  draw(now);
  requestAnimationFrame(gameLoop);
}

function initClient() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  requestAnimationFrame(gameLoop);
}