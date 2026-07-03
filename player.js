// players.js
// client-side representation of players. holds a "target" state (the latest
// truth received from the server) and a separately-lerped "rendered" state
// per player, so incoming network updates (which arrive in discrete jumps)
// produce smooth on-screen motion instead of snapping.
//
// nothing in here reads the network directly - applyPlayerUpdate() is the
// single entry point a websocket/webrtc handler should call whenever a
// snapshot for a player comes in. drawing and lerping are driven every
// frame from client.js's game loop via updatePlayers() / drawPlayers().

const PLAYER_RADIUS = 1;       // world units - the fixed outer radius of the whole player glyph
const HEALTH_MAX = 100;
const SHIELD_MAX = 90;
const SHIELD_MAX_THICKNESS = 0.9; // world units, at SHIELD_MAX shield

const POSITION_LERP_RATE = 12;  // higher = snappier tracking of target position, per second
const STAT_LERP_RATE = 8;       // same idea, for health/shield ring animation

const PLAYER_BODY_COLOR = '#ff80ff';   // light-magenta placeholder
const PLAYER_HEALTH_COLOR = '#ff00ff'; // magenta placeholder
const PLAYER_SHIELD_COLOR = '#66ccff'; // placeholder shield ring color

// id -> { target: {x,y,health,shield}, rendered: {x,y,health,shield} }
const players = {};

function ensurePlayer(id) {
  if (!players[id]) {
    players[id] = {
      target:   { x: 0, y: 0, health: HEALTH_MAX, shield: SHIELD_MAX },
      rendered: { x: 0, y: 0, health: HEALTH_MAX, shield: SHIELD_MAX }
    };
  }
  return players[id];
}

// call this whenever a network message with player state comes in.
// `data` may be a partial update - only provided fields are applied, so a
// message that only carries position doesn't reset health/shield to 0.
function applyPlayerUpdate(id, data) {
  const player = ensurePlayer(id);
  if (data.x !== undefined) player.target.x = data.x;
  if (data.y !== undefined) player.target.y = data.y;
  if (data.health !== undefined) player.target.health = clamp(data.health, 0, HEALTH_MAX);
  if (data.shield !== undefined) player.target.shield = clamp(data.shield, 0, SHIELD_MAX);
}

function removePlayer(id) {
  delete players[id];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// exponential smoothing toward target, framerate-independent given dt in
// seconds. rate is "how many times per second we close the gap".
function lerpTowards(current, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return current + (target - current) * t;
}

// advances every player's rendered state toward its target state.
// call once per frame, before drawPlayers(), with dt in seconds.
function updatePlayers(dt) {
  for (const id in players) {
    const { target, rendered } = players[id];
    rendered.x = lerpTowards(rendered.x, target.x, POSITION_LERP_RATE, dt);
    rendered.y = lerpTowards(rendered.y, target.y, POSITION_LERP_RATE, dt);
    rendered.health = lerpTowards(rendered.health, target.health, STAT_LERP_RATE, dt);
    rendered.shield = lerpTowards(rendered.shield, target.shield, STAT_LERP_RATE, dt);
  }
}

// draws every player using their current rendered (lerped) state.
// assumes ctx/camera/scale from client.js are already set up for this frame.
function drawPlayers() {
  for (const id in players) {
    drawPlayer(players[id].rendered);
  }
}

function drawPlayer(state) {
  const screenX = (state.x - camera.x) * scale + canvas.width / 2;
  const screenY = (state.y - camera.y) * scale + canvas.height / 2;
  const px = (units) => units * scale; // world units -> screen pixels, for radii/thicknesses

  // base body circle, full fixed radius
  ctx.fillStyle = PLAYER_BODY_COLOR;
  ctx.beginPath();
  ctx.arc(screenX, screenY, px(PLAYER_RADIUS), 0, Math.PI * 2);
  ctx.fill();

  // health circle on top - radius scales 0 -> PLAYER_RADIUS as health goes 0 -> HEALTH_MAX
  const healthRadius = (state.health / HEALTH_MAX) * PLAYER_RADIUS;
  if (healthRadius > 0) {
    ctx.fillStyle = PLAYER_HEALTH_COLOR;
    ctx.beginPath();
    ctx.arc(screenX, screenY, px(healthRadius), 0, Math.PI * 2);
    ctx.fill();
  }

  // shield ring - outer edge always sits exactly at PLAYER_RADIUS, thickness
  // scales 0 -> SHIELD_MAX_THICKNESS as shield goes 0 -> SHIELD_MAX. a stroked
  // arc is centered on its path, so the centerline radius has to be pulled
  // in by half the thickness to keep the outer edge pinned at PLAYER_RADIUS.
  const shieldThickness = (state.shield / SHIELD_MAX) * SHIELD_MAX_THICKNESS;
  if (shieldThickness > 0) {
    const shieldCenterRadius = PLAYER_RADIUS - shieldThickness / 2;
    ctx.strokeStyle = PLAYER_SHIELD_COLOR;
    ctx.lineWidth = px(shieldThickness);
    ctx.beginPath();
    ctx.arc(screenX, screenY, px(shieldCenterRadius), 0, Math.PI * 2);
    ctx.stroke();
  }
}