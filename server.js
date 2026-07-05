// server.js — Worker

let pickupCounter = 0;
const pendingPickups = new Map();

const player_speed = 15;
const ground_friction = 1;
const tickms = 1000 / 60;


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
  }
};


const players = {};

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

    const isMoving = player.velocity.x !== 0 || player.velocity.y !== 0;

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
  playerCollisions() {/*leave empty for now*/},
  bulletCollisions() {/*leave empty for now*/},
  playerFiring() {/*leave empty for now*/},
  playerReloading() {/*leave empty for now*/},
};

// --- tick loop ---
async function tick() {
  for (const key in methods) {
    await methods[key]();
  }
}

setInterval(tick, tickms);