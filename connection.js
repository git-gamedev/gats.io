// connection.js — main thread only. Owns all real WebRTC objects + encode/decode.

const state = {
  serverChannel: null,   // real RTCDataChannel for the server (this tab hosting)
  clientChannel: null,   // real RTCDataChannel for the client (this tab playing)
  clientHandler: null,   // registered callback for push delivery to client, receives decoded messages
};

let serverWorker = null;

// --- called once at startup to wire the worker up ---
function attachServerWorker(worker) {
  serverWorker = worker;
  worker.onmessage = ({ data: msg }) => {
    if (msg.type === 'pickup-request') {
      const batch = flushServerInbox(); // drain + resolve the pending batch
      worker.postMessage({ type: 'pickup-response', requestId: msg.requestId, batch });
    } else if (msg.type === 'send') {
      // msg.message is { type: 'JOIN_RESPONSE', args: [playerID, success] } — see server.js proxy below
      _sendReal(true, msg.message.type, ...msg.message.args);
    }
  };
}

// --- the two public functions matching your desired API ---

function sendMessage(serverMessage, type, ...args) {
  _sendReal(serverMessage, type, ...args);
}

function pickupMessages(isServer, callback) {
  if (!isServer) {
    state.clientHandler = callback;
    return;
  }
  throw new Error('pickupMessages(true) must be called from the server (worker), not main thread');
}


function _sendReal(isServer, type, ...args) {
  const channel = isServer ? state.serverChannel : state.clientChannel;
  if (channel?.readyState !== 'open') {
    console.log('[connection] DROPPED', type, 'channel state:', channel?.readyState);
    return;
  }
  const buf = encode(type, ...args);
  channel.send(buf);
}

// --- wiring real channels once they exist ---

function setServerChannel(channel) {
  state.serverChannel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onmessage = (e) => queueServerMessage(decode(e.data));
}

function setClientChannel(channel) {
  state.clientChannel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onmessage = (e) => state.clientHandler?.(decode(e.data));
}

// =============================================================================
// message overrides — collapsing duplicate messages between pickups
// =============================================================================
//
// The worker only drains the inbox ~60x/sec, so several messages of the same
// type from the same player can pile up in a single tick. Instead of handing
// the worker the raw pile, every incoming message gets folded into a pending
// slot keyed by (type, playerID). Each type defines what "folding a new
// message onto an existing pending one" means:
//
//   - JOIN_REQUEST / LEAVE_REQUEST: no meaningful content beyond "it happened
//     for this playerID", so a duplicate just replaces the pending one.
//   - PLAYER_AIM: only the newest mouse position matters, so a duplicate
//     replaces the pending one.
//   - PLAYER_INPUTS: these are cumulative (client sends either an absolute
//     "set" or a relative "toggle" against its own last-sent state — see
//     client.js's returnInputs). Folding these naively by overwriting would
//     drop toggles that happened earlier in the same tick. Instead each new
//     PLAYER_INPUTS message is immediately applied on top of the player's
//     running resolved state, so by the time the batch is flushed the
//     pending message already reflects every input change applied *in
//     order*, expressed as a single resolved "set" code.
//
// POSITION_PLAYER is server -> client only (never arrives in the inbox), so
// it isn't part of this dedup layer at all.

const pendingByKey = new Map(); // `${type}:${playerID}` -> decoded message, this tick's batch
const playerInputState = new Map(); // playerID -> boolean[7], persists ACROSS pickups (needed to interpret toggle codes correctly even when only one message arrives per tick)

const INPUT_BIT_COUNT = 7; // must match client.js's INPUT_ORDER length
const INPUT_SET_FLAG = 0b10000000;

// Apply one raw PLAYER_INPUTS code (set or toggle) on top of playerID's
// tracked state, update that tracked state, and return the equivalent
// resolved "set" code.
function resolveInputsCode(playerID, rawCode) {
  let bits = playerInputState.get(playerID);
  if (!bits) {
    bits = new Array(INPUT_BIT_COUNT).fill(false); // fresh player starts all-released
    playerInputState.set(playerID, bits);
  }

  const isSet = (rawCode & INPUT_SET_FLAG) !== 0;
  for (let i = 0; i < INPUT_BIT_COUNT; i++) {
    const bit = (rawCode >> (6 - i)) & 1;
    if (isSet) {
      bits[i] = bit === 1;
    } else if (bit === 1) {
      bits[i] = !bits[i]; // toggle bit only flips, doesn't set a value directly
    }
  }

  let resolved = INPUT_SET_FLAG;
  for (let i = 0; i < INPUT_BIT_COUNT; i++) {
    if (bits[i]) resolved |= (1 << (6 - i));
  }
  return resolved;
}

function queueServerMessage(msg) {
  const key = `${msg.type}:${msg.playerID}`;

  if (msg.type === 'PLAYER_INPUTS') {
    const resolvedInputs = resolveInputsCode(msg.playerID, msg.inputs);
    pendingByKey.set(key, { ...msg, inputs: resolvedInputs });
    return;
  }

  // default rule for JOIN_REQUEST, LEAVE_REQUEST, PLAYER_AIM (and anything
  // else added later that doesn't need special folding): latest wins.
  pendingByKey.set(key, msg);

  if (msg.type === 'LEAVE_REQUEST') {
    playerInputState.delete(msg.playerID); // stop tracking a player who's gone
  }
}

// called once per pickup: hand the worker the resolved batch, then reset
// for the next tick's pile-up. playerInputState is NOT cleared here — it
// has to persist across pickups so toggle codes keep resolving correctly.
function flushServerInbox() {
  const batch = [...pendingByKey.values()];
  pendingByKey.clear();
  return batch;
}

// --- encoding/decoding — connection.js's private concern now ---

const MessageType = {
  JOIN_REQUEST: 0x01,
  JOIN_RESPONSE: 0x02,
  LEAVE_REQUEST: 0x03,
  LEAVE_RESPONSE: 0x04,
  PLAYER_INPUTS: 0x05,
  PLAYER_AIM: 0x06,
  POSITION_PLAYER: 0x07,
};

const encoders = {
  JOIN_REQUEST: (playerID) => {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, MessageType.JOIN_REQUEST);
    view.setUint16(1, playerID);
    return buf;
  },
  JOIN_RESPONSE: (playerID, playerData) => {
    // playerData === false (or falsy) means failure — short packet
    if (!playerData) {
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      view.setUint8(0, MessageType.JOIN_RESPONSE);
      view.setUint16(1, playerID);
      view.setUint8(3, 0);
      return buf;
    }

    const buf = new ArrayBuffer(27);
    const view = new DataView(buf);
    view.setUint8(0, MessageType.JOIN_RESPONSE);
    view.setUint16(1, playerID);
    view.setFloat32(3, playerData.position.x);
    view.setFloat32(7, playerData.position.y);
    view.setFloat32(11, playerData.velocity.x);
    view.setFloat32(15, playerData.velocity.y);
    view.setFloat32(19, playerData.aiming.x);
    view.setFloat32(23, playerData.aiming.y);
    return buf;
  },
  LEAVE_REQUEST: (playerID) => {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, MessageType.LEAVE_REQUEST);
    view.setUint16(1, playerID);
    return buf;
  },
  LEAVE_RESPONSE: (playerID, success) => {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, MessageType.LEAVE_RESPONSE);
    view.setUint16(1, playerID);
    view.setUint8(3, success ? 1 : 0);
    return buf;
  },
  PLAYER_INPUTS: (playerID, inputs) => {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, MessageType.PLAYER_INPUTS);
    view.setUint16(1, playerID);
    view.setUint8(3, inputs);
    return buf;
  },
  PLAYER_AIM: (playerID, position) => {
    const buf = new ArrayBuffer(11); // type(1) + playerID(2) + x(4) + y(4)
    const view = new DataView(buf);
    view.setUint8(0, MessageType.PLAYER_AIM);
    view.setUint16(1, playerID);
    view.setFloat32(3, position.x);
    view.setFloat32(7, position.y);
    return buf;
  },
  POSITION_PLAYER: (playerID, position, velocity) => {
    const buf = new ArrayBuffer(19); // type(1) + playerID(2) + x(4) + y(4) + vx(4) + vy(4)
    const view = new DataView(buf);
    view.setUint8(0, MessageType.POSITION_PLAYER);
    view.setUint16(1, playerID);
    view.setFloat32(3, position.x);
    view.setFloat32(7, position.y);
    view.setFloat32(11, velocity.x);
    view.setFloat32(15, velocity.y);
    return buf;
  },
};

const decoders = {
  [MessageType.JOIN_REQUEST]: (view) => ({ type: 'JOIN_REQUEST', playerID: view.getUint16(1) }),
  [MessageType.JOIN_RESPONSE]: (view) => {
    if (view.byteLength === 4) {
      return { type: 'JOIN_RESPONSE', playerID: view.getUint16(1), success: false };
    }
    return {
      type: 'JOIN_RESPONSE',
      playerID: view.getUint16(1),
      success: true,
      position: { x: view.getFloat32(3), y: view.getFloat32(7) },
      velocity: { x: view.getFloat32(11), y: view.getFloat32(15) },
      aiming: { x: view.getFloat32(19), y: view.getFloat32(23) },
    };
  },
  [MessageType.LEAVE_REQUEST]: (view) => ({ type: 'LEAVE_REQUEST', playerID: view.getUint16(1) }),
  [MessageType.LEAVE_RESPONSE]: (view) => ({ type: 'LEAVE_RESPONSE', playerID: view.getUint16(1), success: view.getUint8(3) === 1 }),
  [MessageType.PLAYER_INPUTS]: (view) => ({
    type: 'PLAYER_INPUTS',
    playerID: view.getUint16(1),
    inputs: view.getUint8(3),
  }),
  [MessageType.PLAYER_AIM]: (view) => ({
    type: 'PLAYER_AIM',
    playerID: view.getUint16(1),
    position: { x: view.getFloat32(3), y: view.getFloat32(7) },
  }),
  [MessageType.POSITION_PLAYER]: (view) => ({
    type: 'POSITION_PLAYER',
    playerID: view.getUint16(1),
    position: { x: view.getFloat32(3), y: view.getFloat32(7) },
    velocity: { x: view.getFloat32(11), y: view.getFloat32(15) },
  }),
};

function encode(type, ...args) {
  const fn = encoders[type];
  if (!fn) throw new Error(`Unknown message type to encode: ${type}`);
  return fn(...args);
}

function decode(buf) {
  const view = new DataView(buf);
  const type = view.getUint8(0);
  const fn = decoders[type];
  if (!fn) throw new Error(`Unknown message type to decode: ${type}`);
  return fn(view);
}