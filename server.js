// server.js — Worker

let pickupCounter = 0;
const pendingPickups = new Map();

const player_speed = 15;
const ground_friction = 1;
const tickms = 1000 / 60;

// velocities at or below this are treated as "at rest" for the purposes of
// deciding whether to report the player as moving (see isMoving in
// playerMovement). Needed because a wall collision that zeroes velocity
// gets re-nudged back toward desiredVelocity by ground_friction on the very
// next tick — against a wall that re-nudge immediately collides again and
// gets zeroed again, but the single-tick nonzero value in between is a real
// velocity, not float noise. Without this epsilon, holding a movement key
// into a wall reads as "moving" on every tick forever, so the
// isMoving/wasMoving stop-signal never fires and the client never learns to
// stop dead-reckoning forward off the last velocity it heard about.
const MOVING_EPSILON = 0.01;


(function init() {
  const isWorker = typeof importScripts === 'function' || typeof WorkerGlobalScope !== 'undefined';
  if (!isWorker) return;
  postMessage({ type: 'server-alive' });
})();



function sendMessage(type, ...args) {
  postMessage({ type: 'send', message: { type, args } });
}

function pickupMessages() {
  return new Promise((resolve) => {
    const requestId = pickupCounter++;
    pendingPickups.set(requestId, resolve);
    postMessage({ type: 'pickup-request', requestId });
  });
}

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'pickup-response') {
    pendingPickups.get(msg.requestId)?.(msg.batch ?? []);
    pendingPickups.delete(msg.requestId);
  } else if (msg.type === 'data-request') {
    handleDataRequest(msg.requestId, msg.dataType, msg.mode);
  } else if (msg.type === 'client-disconnected') {
    handleClientDisconnected();
  }
};

// =============================================================================
// data request protocol — server side
// =============================================================================
//
// dataProviders is the whitelist of things a client is allowed to request.
// Adding a new requestable data type means adding one entry here; nothing
// else in the plumbing needs to change. Each provider is a zero-arg function
// returning the CURRENT value (not a snapshot) — dataSubscriptions below is
// what turns "current value" into "value at last check" for change detection.
const dataProviders = {
  // Plain box array — { type, position, rotated } only, no baked-in
  // width/height. Dimensions are requested separately via BOX_DIMENSIONS
  // (see below), a lookup table by type/rotation. This keeps per-box
  // payloads smaller (no repeated width/height floats across every box —
  // matters more once BOX_COUNT is in the hundreds) at the cost of the
  // client needing a small bit of lookup logic (type + rotated -> which
  // entry) to interpret it. The size VALUES still live in exactly one
  // place either way; this only changes where the type->dimensions
  // mapping step happens.
  BOXES: () => boxes,

  // Static reference data: every box shape the client will ever encounter,
  // keyed so the client can look up { width, height } for a given box via
  // box.type (+ box.rotated for 'long'). Never changes after this module
  // loads, so as a continuous subscription it fires once and goes silent —
  // fine either way, but 'once' is the natural fit since there's nothing to
  // watch for changes on.
  BOX_DIMENSIONS: () => ({
    [BOX_TYPE.SQUARE]: {
      width: SQUARE_SIZE,
      height: SQUARE_SIZE,
    },
    [BOX_TYPE.LONG]: {
      unrotated: { width: LONG_LENGTH, height: LONG_THICKNESS },
      rotated: { width: LONG_THICKNESS, height: LONG_LENGTH },
    },
  }),

  // Arena play-field dimensions, centered on the origin. Static for the
  // lifetime of the server (no mid-session resize), so 'once' is the
  // natural fit — same reasoning as BOX_DIMENSIONS above.
  ARENA_SIZE: () => ({
    width: ARENA_WIDTH,
    height: ARENA_HEIGHT,
    borderThickness: ARENA_BORDER_THICKNESS,
  }),
};

// requestId -> { dataType, lastSentJSON }, one entry per ACTIVE CONTINUOUS
// subscription only. 'once' requests never get an entry here — they're
// answered immediately and forgotten. lastSentJSON is a JSON string, not the
// raw value, so change-detection is a simple string comparison instead of a
// deep-equal implementation; fine for now given dataProviders' values
// (arrays/objects of primitives), revisit if a provider needs to return
// something JSON can't represent (e.g. a Map or a function).
const dataSubscriptions = new Map();

function handleDataRequest(requestId, dataType, mode) {
  const provider = dataProviders[dataType];
  if (!provider) {
    console.warn(`[server] REQUEST_DATA for unknown dataType: ${dataType}`);
    return;
  }

  if (mode === 'once') {
    sendMessage('RESPONSE_DATA', requestId, dataType, provider());
    return;
  }

  if (mode === 'continuous') {
    const value = provider();
    dataSubscriptions.set(requestId, { dataType, lastSentJSON: JSON.stringify(value) });
    sendMessage('RESPONSE_DATA', requestId, dataType, value); // send the first value immediately
    return;
  }

  console.warn(`[server] REQUEST_DATA with unknown mode: ${mode}`);
}

// called once per tick (see checkDataSubscriptions in the methods list
// below): re-fetches every active continuous subscription's current value
// and pushes only if it differs from what was last sent.
function checkDataSubscriptions() {
  for (const [requestId, sub] of dataSubscriptions) {
    const provider = dataProviders[sub.dataType];
    if (!provider) continue; // shouldn't happen, but don't crash the tick loop over it

    const value = provider();
    const json = JSON.stringify(value);
    if (json === sub.lastSentJSON) continue;

    sub.lastSentJSON = json;
    sendMessage('RESPONSE_DATA', requestId, sub.dataType, value);
  }
}

// This worker currently serves exactly one client (see the single-channel
// architecture in connection.js), so "the client disconnected" means "every
// subscription is now stale" — clear all of them rather than tracking which
// requestId belonged to which client.
function handleClientDisconnected() {
  console.log(`[server] client disconnected, clearing ${dataSubscriptions.size} data subscription(s)`);
  dataSubscriptions.clear();
}


const players = {};

// --- world boxes ---
// Two types, rotation locked to 0°/90° so every box is always axis-aligned —
// this keeps collision plain AABB-vs-circle, no rotated-rect math needed.
//   square: 5x5, rotation is irrelevant (identical either way)
//   long:   5x1.5, 'rotated' swaps which axis is the long one

const BOX_TYPE = { SQUARE: 'square', LONG: 'long' };
const SQUARE_SIZE = 5;
const LONG_LENGTH = 5;
const LONG_THICKNESS = 1.5;

const BOX_COUNT = 1500;

// arena play field, centered on the origin. Not a box in the `boxes` array —
// it's the hard boundary every player and box lives inside, enforced
// separately in resolveArenaBoundary() below (see that function for why it
// reuses the same collision math as resolvePlayerCollisions rather than a
// position clamp).
const ARENA_WIDTH = 500;
const ARENA_HEIGHT = 500;
const ARENA_BORDER_THICKNESS = 0.5; // must match client.js's ARENA_BORDER_THICKNESS_UNITS

// how many attempts spawnBoxes will make to place a single box before
// giving up on it. Bounded rather than infinite so a pathological
// combination of BOX_COUNT/arena size/box sizes (i.e. genuinely not enough
// room to fit another box without overlap) can't hang the tick it runs on —
// it just spawns fewer boxes than BOX_COUNT and logs how many it dropped.
const BOX_SPAWN_MAX_ATTEMPTS = 200;

const boxes = [];

// returns this box's actual footprint given its type/rotation — the only
// place collision code should ever need to know box dimensions from.
function getBoxDimensions(box) {
  if (box.type === BOX_TYPE.SQUARE) {
    return { width: SQUARE_SIZE, height: SQUARE_SIZE };
  }
  // long box: unrotated is wide-and-thin, rotated swaps width/height
  return box.rotated
    ? { width: LONG_THICKNESS, height: LONG_LENGTH }
    : { width: LONG_LENGTH, height: LONG_THICKNESS };
}

// AABB-vs-AABB overlap test for two candidate extents — plain rect
// intersection, no penetration depth needed here since a spawn candidate
// that overlaps at all just gets thrown away and re-rolled rather than
// depenetrated.
function aabbOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX &&
         a.minY < b.maxY && a.maxY > b.minY;
}

// picks a random position + extent for a box of the given width/height,
// fully inside the arena's playable interior (i.e. inset by the arena
// border thickness, same interior the player boundary uses) so a box can
// never spawn straddling or outside the wall — this is the "spawn within
// bounds of whatever sized arena is chosen" half of the fix, since it reads
// ARENA_WIDTH/ARENA_HEIGHT directly instead of a separate, disconnected
// world-extent constant.
function randomBoxExtent(width, height) {
  const halfW = ARENA_WIDTH / 2 - ARENA_BORDER_THICKNESS;
  const halfH = ARENA_HEIGHT / 2 - ARENA_BORDER_THICKNESS;

  // the box's CENTER has to stay far enough from the interior edge that the
  // box's own half-width/half-height doesn't poke through the wall. Clamped
  // to >= 0 so a box that's actually wider/taller than the interior doesn't
  // get a negative range (which would flip min/max on the random roll).
  const rangeX = Math.max(halfW - width / 2, 0);
  const rangeY = Math.max(halfH - height / 2, 0);

  const x = (Math.random() * 2 - 1) * rangeX;
  const y = (Math.random() * 2 - 1) * rangeY;

  return {
    position: { x, y },
    extent: {
      minX: x - width / 2,
      maxX: x + width / 2,
      minY: y - height / 2,
      maxY: y + height / 2,
    },
  };
}

// spawns BOX_COUNT boxes, each retried against every box already placed so
// far until it lands somewhere non-overlapping (or BOX_SPAWN_MAX_ATTEMPTS
// runs out, in which case that box is skipped rather than spawned into
// something else — see BOX_SPAWN_MAX_ATTEMPTS comment above). Checked
// against the growing `placedExtents` array directly (plain O(n) scan per
// attempt) rather than the boxesByMinX spatial index below, since that
// index isn't built until AFTER spawnBoxes finishes (buildSpatialIndex()
// runs once, on static post-spawn data) and n stays small (BOX_COUNT-sized)
// here regardless.

const MEADOW_SIZE = 35;

function spawnBoxes() {
  const placedExtents = [];

  for (let i = 0; i < BOX_COUNT; i++) {
    const type = Math.random() < 0.5 ? BOX_TYPE.SQUARE : BOX_TYPE.LONG;
    const rotated = type === BOX_TYPE.LONG ? Math.random() < 0.5 : false;
    const { width, height } = getBoxDimensions({ type, rotated });

    let placed = false;
    for (let attempt = 0; attempt < BOX_SPAWN_MAX_ATTEMPTS; attempt++) {
      const { position, extent } = randomBoxExtent(width, height);
      if (placedExtents.some(other => aabbOverlap(extent, other))) continue;
      if (Math.abs(position.x) < MEADOW_SIZE && Math.abs(position.y) < MEADOW_SIZE) continue;

      boxes.push({ type, position, rotated });
      placedExtents.push(extent);
      placed = true;
      break;
    }

    if (!placed) {
      console.warn(`[server] gave up placing box ${i} after ${BOX_SPAWN_MAX_ATTEMPTS} attempts (no non-overlapping spot found)`);
    }
  }
  console.log(`[server] spawned ${boxes.length}/${BOX_COUNT} boxes`);
}

spawnBoxes();

// --- spatial index for collision broad-phase ---
// Boxes are static after spawnBoxes(), so this is built once and never
// rebuilt. Only the X axis needs to be sorted: binary search narrows
// hundreds of boxes down to a small handful near the player on X, then a
// plain linear scan filters that small handful by Y overlap. There's no
// benefit to also maintaining a Y-sorted array — binary search only works
// on a sorted axis, and "was near the player on X" isn't a property that's
// monotonic in Y-order, so a second sorted array can't be binary searched
// using the X pass's result. Scanning the already-small X result for Y is
// strictly cheaper than maintaining/searching a second sorted structure.

let boxesByMinX = [];

// returns this box's world-space AABB extent
function getBoxExtent(box) {
  const { width, height } = getBoxDimensions(box);
  return {
    minX: box.position.x - width / 2,
    maxX: box.position.x + width / 2,
    minY: box.position.y - height / 2,
    maxY: box.position.y + height / 2,
  };
}

function buildSpatialIndex() {
  boxesByMinX = boxes
    .map((box, i) => ({ i, ...getBoxExtent(box) }))
    .sort((a, b) => a.minX - b.minX);
  console.log(`[server] spatial index built for ${boxesByMinX.length} boxes`);
}

buildSpatialIndex();

const PLAYER_RADIUS = 1; // must match client.js's PLAYER_RADIUS
const RESTITUTION = 0.5; // 1 = perfectly elastic bounce, 0 = velocity fully absorbed along normal

// must exceed PLAYER_RADIUS + half the widest possible box dimension, or
// the early-out below can skip a box that's still actually in range.
// Widest box dimension today is SQUARE_SIZE/LONG_LENGTH = 5, so half-width
// 2.5 + PLAYER_RADIUS 1 = 3.5 -- 7 leaves comfortable margin. Revisit this
// constant if a wider box type is ever added.
const BOX_SEARCH_MARGIN = 7;

// index of the first entry in boxesByMinX whose minX is >= px
function findInsertionIndex(px) {
  let lo = 0, hi = boxesByMinX.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boxesByMinX[mid].minX < px) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// broad-phase: binary search X, walk outward from the insertion point until
// minX exceeds the search margin, then linear-scan that small result for
// actual X/Y AABB overlap against the player's circle.
function getCandidateBoxes(px, py) {
  const insertAt = findInsertionIndex(px);
  const xCandidates = [];

  for (let k = insertAt; k < boxesByMinX.length; k++) {
    const c = boxesByMinX[k];
    if (c.minX - px > BOX_SEARCH_MARGIN) break;
    xCandidates.push(c);
  }
  for (let k = insertAt - 1; k >= 0; k--) {
    const c = boxesByMinX[k];
    if (px - c.minX > BOX_SEARCH_MARGIN) break;
    xCandidates.push(c);
  }

  // linear scan (not a second binary search — see comment above) for real
  // AABB overlap against the player's circle bounds
  return xCandidates.filter(c =>
    c.minX <= px + PLAYER_RADIUS && c.maxX >= px - PLAYER_RADIUS &&
    c.minY <= py + PLAYER_RADIUS && c.maxY >= py - PLAYER_RADIUS
  );
}

// narrow-phase: closest point on the AABB to the circle center. Returns the
// collision normal (pointing from box surface toward player center) and
// penetration depth, or null if there's no overlap.
function circleAABBCollision(px, py, radius, extent) {
  const closestX = Math.max(extent.minX, Math.min(px, extent.maxX));
  const closestY = Math.max(extent.minY, Math.min(py, extent.maxY));
  const dx = px - closestX;
  const dy = py - closestY;
  const distSq = dx * dx + dy * dy;

  if (distSq >= radius * radius) return null;

  const dist = Math.sqrt(distSq);

  if (dist === 0) {
    // center exactly on/inside an edge — push out along whichever side is
    // closest, since dx/dy give no usable direction at zero distance
    const pushLeft = px - extent.minX;
    const pushRight = extent.maxX - px;
    const pushDown = py - extent.minY;
    const pushUp = extent.maxY - py;
    const min = Math.min(pushLeft, pushRight, pushDown, pushUp);
    if (min === pushLeft) return { nx: -1, ny: 0, depth: radius };
    if (min === pushRight) return { nx: 1, ny: 0, depth: radius };
    if (min === pushDown) return { nx: 0, ny: -1, depth: radius };
    return { nx: 0, ny: 1, depth: radius };
  }

  return { nx: dx / dist, ny: dy / dist, depth: radius - dist };
}

// resolves box collisions for one player: each overlapping candidate is
// depenetrated and bounced individually, in sequence, against the player's
// position as corrected by the previous box in the same pass. No normal
// blending — each box's push/bounce is exact for that box, which is what
// stops a stale or tiny leftover overlap from one box being masked or
// distorted by another box's normal (the old summed-normal approach could
// produce a combined push/bounce direction that didn't match any single
// box's real surface, which is what let a corner overlap keep "bouncing"
// after the player had visually cleared it).
function resolvePlayerCollisions(player) {
  const candidates = getCandidateBoxes(player.position.x, player.position.y);

  for (const c of candidates) {
    const hit = circleAABBCollision(player.position.x, player.position.y, PLAYER_RADIUS, c);
    if (!hit) continue; // this box no longer actually overlaps, skip it

    // depenetrate: push straight out along this box's own normal
    player.position.x += hit.nx * hit.depth;
    player.position.y += hit.ny * hit.depth;

    // reflect: v' = v - (1 + restitution) * (v . n) * n, only if moving
    // INTO this box's surface (skip if already moving away/tangent)
    const vDotN = player.velocity.x * hit.nx + player.velocity.y * hit.ny;
    if (vDotN < 0) {
      const factor = (1 + RESTITUTION) * vDotN;
      player.velocity.x -= factor * hit.nx;
      player.velocity.y -= factor * hit.ny;
    }
  }
}

// --- arena boundary ---
// Treats the arena's four edges as collision surfaces, reusing the exact
// same depenetrate + velocity-reflect approach as resolvePlayerCollisions
// (see that function's comment for why per-surface resolution, not normal
// blending). This is deliberate, not a shortcut: a position clamp
// (`position.x = min(position.x, someLimit)`) can leave velocity pointed
// into the wall with nothing to zero it, which is the exact class of bug
// MOVING_EPSILON was added to fix for regular box collisions above — reusing
// the same normal-based reflect keeps arena walls and boxes behaving
// identically (including wall-running against either one), rather than
// introducing a second, differently-behaved boundary mechanism.
//
// Checked independently per axis (unlike circleAABBCollision, which finds
// one closest point): a player can only ever be pushed out through ONE
// arena wall on a given axis at a time (can't be past both minX and maxX
// simultaneously in a 500-unit arena), so there's no closest-point
// ambiguity to resolve here the way there is for an interior box corner.
function resolveArenaBoundary(player) {
  const halfW = ARENA_WIDTH / 2;
  const halfH = ARENA_HEIGHT / 2;

  const minX = -halfW + PLAYER_RADIUS;
  const maxX = halfW - PLAYER_RADIUS;
  const minY = -halfH + PLAYER_RADIUS;
  const maxY = halfH - PLAYER_RADIUS;

  if (player.position.x < minX) {
    applyArenaHit(player, minX - player.position.x, 1, 0);
  } else if (player.position.x > maxX) {
    applyArenaHit(player, player.position.x - maxX, -1, 0);
  }

  if (player.position.y < minY) {
    applyArenaHit(player, minY - player.position.y, 0, 1);
  } else if (player.position.y > maxY) {
    applyArenaHit(player, player.position.y - maxY, 0, -1);
  }
}

// depenetrate along (nx, ny) by depth, then reflect velocity the same way
// resolvePlayerCollisions does for boxes — nx/ny here point from the wall
// back toward the arena interior (i.e. the direction the player gets pushed)
function applyArenaHit(player, depth, nx, ny) {
  player.position.x += nx * depth;
  player.position.y += ny * depth;

  const vDotN = player.velocity.x * nx + player.velocity.y * ny;
  if (vDotN < 0) {
    const factor = (1 + RESTITUTION) * vDotN;
    player.velocity.x -= factor * nx;
    player.velocity.y -= factor * ny;
  }
}


// All-pairs check, no spatial index. Player counts are expected to stay in
// the dozens (unlike boxes, which head into the hundreds), so n*(n-1)/2
// comparisons per tick is trivial — e.g. 100 players is ~4,950 checks. If
// player counts ever grow into box-like territory, the same X-binary-search
// + Y-linear-scan approach used for boxes could be applied here too.

// narrow-phase for two circles of equal radius: same shape as
// circleAABBCollision (normal + penetration depth, or null), but measured
// center-to-center instead of center-to-closest-AABB-point.
function circleCircleCollision(ax, ay, bx, by, radius) {
  const dx = ax - bx;
  const dy = ay - by;
  const distSq = dx * dx + dy * dy;
  const minDist = radius * 2;

  if (distSq >= minDist * minDist) return null;

  const dist = Math.sqrt(distSq);

  if (dist === 0) {
    // exactly overlapping centers — no real direction to push along, so
    // pick an arbitrary consistent axis rather than leaving it undefined
    return { nx: 1, ny: 0, depth: minDist };
  }

  // normal points from B toward A (i.e. the direction A gets pushed)
  return { nx: dx / dist, ny: dy / dist, depth: minDist - dist };
}

// resolves collision between two players symmetrically: each gets half the
// positional correction (so neither visually "wins" the collision), and
// each has velocity reflected off the shared normal independently.
function resolvePlayerPairCollision(playerA, playerB) {
  const hit = circleCircleCollision(
    playerA.position.x, playerA.position.y,
    playerB.position.x, playerB.position.y,
    PLAYER_RADIUS
  );
  if (!hit) return;

  const { nx, ny, depth } = hit;
  const halfDepth = depth / 2;

  // push each player out along the normal, away from the other
  playerA.position.x += nx * halfDepth;
  playerA.position.y += ny * halfDepth;
  playerB.position.x -= nx * halfDepth;
  playerB.position.y -= ny * halfDepth;

  // reflect each player's velocity independently off the same normal —
  // same "only if moving into the surface" guard as the box case, but
  // note the normal points opposite ways for A vs B (nx/ny is "toward A"),
  // so B's dot product uses the negated normal
  const vDotN_A = playerA.velocity.x * nx + playerA.velocity.y * ny;
  if (vDotN_A < 0) {
    const factor = (1 + RESTITUTION) * vDotN_A;
    playerA.velocity.x -= factor * nx;
    playerA.velocity.y -= factor * ny;
  }

  const vDotN_B = playerB.velocity.x * -nx + playerB.velocity.y * -ny;
  if (vDotN_B < 0) {
    const factor = (1 + RESTITUTION) * vDotN_B;
    playerB.velocity.x -= factor * -nx;
    playerB.velocity.y -= factor * -ny;
  }
}

// resolves every unique player pair once per tick (all-pairs, see note above)
function resolveAllPlayerPairCollisions() {
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      resolvePlayerPairCollision(players[ids[i]], players[ids[j]]);
    }
  }
}

function formPlayerPrimitive() {
  return {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    aiming: { x: 0, y: 0 },
    desiredVelocity: { x: 0, y: 0 },
    firing: false,
    reloading: false,
    usingAbility: false,
    wasMoving: false, // tracks whether velocity was nonzero last tick, so we
                       // can detect the moving -> stopped transition below
  };
}

const INPUT_ORDER = ['left', 'right', 'up', 'down', 'fire', 'reload', 'ability'];

function decodeInputs(code) {
  const result = {};
  INPUT_ORDER.forEach((action, i) => {
    result[action] = ((code >> (6 - i)) & 1) === 1;
  });
  return result;
}

const msgHandler = {
  JOIN_REQUEST: (msg) => {
    const playerPrimitive = formPlayerPrimitive();
    players[msg.playerID] = structuredClone(playerPrimitive);
    console.log(`[server] playerID ${msg.playerID} has joined!`);
    sendMessage('JOIN_RESPONSE', msg.playerID, players[msg.playerID]);
  },
  LEAVE_REQUEST: (msg) => {
    const existed = msg.playerID in players;
    delete players[msg.playerID];
    sendMessage('LEAVE_RESPONSE', msg.playerID, true);
  },
  PLAYER_INPUTS: (msg) => {
    const player = players[msg.playerID];
    if (!player) return; // inputs arrived before JOIN_REQUEST was processed, or after LEAVE

    const inputs = decodeInputs(msg.inputs);

    const dx = Number(inputs.right) - Number(inputs.left);
    const dy = Number(inputs.up) - Number(inputs.down);
    const scale = (dx !== 0 && dy !== 0) ? player_speed / Math.SQRT2 : player_speed;

    player.desiredVelocity = { x: dx * scale, y: dy * -scale };

    player.firing = inputs.fire;
    player.reloading = inputs.reload;
    player.usingAbility = inputs.ability;
  },
  PLAYER_AIM: (msg) => {
    const player = players[msg.playerID];
    if (!player) return;
    player.aiming = msg.position;
  },
};

function playerMovement() {
  const dt = tickms / 1000; // seconds per tick

  for (const playerID in players) {
    const player = players[playerID];

    // move velocity toward desiredVelocity by a flat step of ground_friction
    // per tick, clamped so it lands exactly on desiredVelocity instead of
    // overshooting past it
    const dx = player.desiredVelocity.x - player.velocity.x;
    const dy = player.desiredVelocity.y - player.velocity.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= ground_friction || dist === 0) {
      player.velocity.x = player.desiredVelocity.x;
      player.velocity.y = player.desiredVelocity.y;
    } else {
      player.velocity.x += (dx / dist) * ground_friction;
      player.velocity.y += (dy / dist) * ground_friction;
    }

    // resolve position from velocity
    player.position.x += player.velocity.x * dt;
    player.position.y += player.velocity.y * dt;

    // epsilon check, not a raw !== 0 check — see MOVING_EPSILON comment for
    // why a small nonzero velocity here doesn't mean the player is actually
    // making progress (most commonly: pinned against a wall)
    const isMoving = Math.hypot(player.velocity.x, player.velocity.y) > MOVING_EPSILON;

    // snap sub-epsilon velocity to exactly zero once it's been classified as
    // "at rest" — otherwise the final stop packet below would still carry a
    // tiny real (not float-error) velocity, and the client would extrapolate
    // off that leftover value for the rest of the tick interval instead of
    // holding still like the stop signal intends
    if (!isMoving) {
      player.velocity.x = 0;
      player.velocity.y = 0;
    }

    // report back to the client while moving, AND for exactly one extra tick
    // after coming to a stop — that final zero-velocity packet is what lets
    // the client's extrapolation know to stop dead-reckoning forward instead
    // of drifting off using the last nonzero velocity it heard about.
    if (isMoving || player.wasMoving) {
      sendMessage('POSITION_PLAYER', playerID, player.position, player.velocity);
    }

    player.wasMoving = isMoving;
  }
}

const methods = {
  async messages() {
    const messages = await pickupMessages();
    for (const msg of messages) {
      if (msg.type in msgHandler) msgHandler[msg.type](msg);
    }
  },
  playerMovement,
  bulletMovement() {/*leave empty for now*/},
  playerAbilities() {/*leave empty for now*/},
  playerCollisions() {
    resolveAllPlayerPairCollisions();
    for (const playerID in players) {
      resolvePlayerCollisions(players[playerID]);
      resolveArenaBoundary(players[playerID]);
    }
  },
  bulletCollisions() {/*leave empty for now*/},
  playerFiring() {/*leave empty for now*/},
  playerReloading() {/*leave empty for now*/},
  checkDataSubscriptions,
};

// --- tick loop ---
async function tick() {
  for (const key in methods) {
    await methods[key]();
  }
}

setInterval(tick, tickms);