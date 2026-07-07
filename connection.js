// connection.js
// Main thread only. Owns all real WebRTC objects (server/client data
// channels) and the binary encode/decode layer for every message type. Also
// implements the data-request protocol (REQUEST_DATA/RESPONSE_DATA, 'once'
// or 'continuous') and the per-tick inbox dedup/fold layer that collapses
// duplicate messages from the same player into one resolved message before
// handing a batch to the server worker.

// state — holds the real RTCDataChannel objects for the server side (this
// tab hosting) and client side (this tab playing), plus the registered
// callback for push delivery of decoded messages to the client.
const state = {
  serverChannel: null,
  clientChannel: null,
  clientHandler: null,
};

// serverWorker — the Worker instance for server.js, set once by
// attachServerWorker.
let serverWorker = null;

// clientReadyCallback — the callback registered via onClientReady, fired
// once the client channel opens.
//
// Replaces the old retry-on-a-timer workaround (see client.js's now-removed
// joinUntilConfirmed HACKEYSACK comment). RTCDataChannel already fires a
// real 'open' event; this just exposes it under the name the old comment
// asked for. If the channel is ALREADY open by the time a caller registers
// (e.g. registered late, after a fast handshake), the callback fires
// immediately instead of being silently missed — checking readyState
// defensively rather than assuming registration always wins the race.
let clientReadyCallback = null;

// requestIdCounter — monotonically increasing counter used to mint unique
// requestIds for requestData calls.
let requestIdCounter = 0;

// pendingDataRequests — requestId -> { mode, callback }, tracking every
// outstanding data request (both 'once', until answered, and 'continuous',
// for as long as it's subscribed).
const pendingDataRequests = new Map();

// pendingByKey — `${type}:${playerID}` -> decoded message, this tick's
// pile-up of incoming messages after folding (see queueServerMessage/
// flushServerInbox and the protocol comment further below).
const pendingByKey = new Map();

// playerInputState — playerID -> boolean[7], persists ACROSS pickups (needed
// to interpret toggle codes correctly even when only one message arrives per
// tick). See resolveInputsCode.
const playerInputState = new Map();

// INPUT_BIT_COUNT — number of tracked input bits; must match client.js's
// INPUT_ORDER length.
const INPUT_BIT_COUNT = 7;

// INPUT_SET_FLAG — high bit marking a PLAYER_INPUTS code as an absolute
// "set" rather than a relative "toggle".
const INPUT_SET_FLAG = 0b10000000;

// MessageType — numeric wire-format tag for every message type this protocol
// knows how to encode/decode.
const MessageType = {
  JOIN_REQUEST: 0x01,
  JOIN_RESPONSE: 0x02,
  LEAVE_REQUEST: 0x03,
  LEAVE_RESPONSE: 0x04,
  PLAYER_INPUTS: 0x05,
  PLAYER_AIM: 0x06,
  POSITION_PLAYER: 0x07,
  REQUEST_DATA: 0x08,   // client -> server: "give me dataType", once or continuous
  RESPONSE_DATA: 0x09,  // server -> client: payload for a previously requested dataType
  CLIENT_DISCONNECTED: 0x0A, // main-thread -> worker only, never sent over the wire (see attachServerWorker)
};

// encoders — MessageType name -> function that packs that message's
// arguments into an ArrayBuffer per its fixed binary layout. REQUEST_DATA
// and RESPONSE_DATA are the deliberate exception: since they carry arbitrary,
// variable-shape payloads (e.g. the full box array), they're JSON-in-buffer
// rather than fixed DataView fields — trying to force arbitrary/nested data
// into a fixed layout would fight the format rather than extend it. Every
// other message type keeps its fixed binary encoding.
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
  REQUEST_DATA: (requestId, dataType, mode) => {
    const json = JSON.stringify({ requestId, dataType, mode });
    const jsonBytes = new TextEncoder().encode(json);
    const buf = new ArrayBuffer(1 + jsonBytes.byteLength);
    new Uint8Array(buf, 0, 1)[0] = MessageType.REQUEST_DATA;
    new Uint8Array(buf, 1).set(jsonBytes);
    return buf;
  },
  RESPONSE_DATA: (requestId, dataType, payload) => {
    const json = JSON.stringify({ requestId, dataType, payload });
    const jsonBytes = new TextEncoder().encode(json);
    const buf = new ArrayBuffer(1 + jsonBytes.byteLength);
    new Uint8Array(buf, 0, 1)[0] = MessageType.RESPONSE_DATA;
    new Uint8Array(buf, 1).set(jsonBytes);
    return buf;
  },
};

// decoders — numeric MessageType value -> function that unpacks a DataView
// into a decoded { type, ...fields } message object, the inverse of
// `encoders`.
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
  [MessageType.REQUEST_DATA]: (view) => {
    const jsonBytes = new Uint8Array(view.buffer, view.byteOffset + 1, view.byteLength - 1);
    const { requestId, dataType, mode } = JSON.parse(new TextDecoder().decode(jsonBytes));
    return { type: 'REQUEST_DATA', requestId, dataType, mode };
  },
  [MessageType.RESPONSE_DATA]: (view) => {
    const jsonBytes = new Uint8Array(view.buffer, view.byteOffset + 1, view.byteLength - 1);
    const { requestId, dataType, payload } = JSON.parse(new TextDecoder().decode(jsonBytes));
    return { type: 'RESPONSE_DATA', requestId, dataType, payload };
  },
};

// attachServerWorker — called once at startup to wire the server worker up:
// stores the worker reference and routes its messages to either answer a
// pickup-request (by flushing the resolved inbox batch) or relay an
// outgoing 'send' back onto the real server channel.
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

// sendMessage — the public send API: encodes and sends `type`/`args` over
// either the server or client channel depending on `serverMessage`.
function sendMessage(serverMessage, type, ...args) {
  _sendReal(serverMessage, type, ...args);
}

// pickupMessages — the public receive API for the client side: registers
// `callback` as the handler for messages pushed to this client. Throws if
// called with isServer true, since server-side pickup goes through the
// worker's own pickupMessages in server.js instead.
function pickupMessages(isServer, callback) {
  if (!isServer) {
    state.clientHandler = callback;
    return;
  }
  throw new Error('pickupMessages(true) must be called from the server (worker), not main thread');
}

// _sendReal — encodes `type`/`args` and sends the resulting buffer over the
// server or client channel (per `isServer`), or logs a DROPPED message and
// no-ops if that channel isn't open.
function _sendReal(isServer, type, ...args) {
  const channel = isServer ? state.serverChannel : state.clientChannel;
  if (channel?.readyState !== 'open') {
    console.log('[connection] DROPPED', type, 'channel state:', channel?.readyState);
    return;
  }
  const buf = encode(type, ...args);
  channel.send(buf);
}

// setServerChannel — wires up the real server-side RTCDataChannel once it
// exists: sets binary mode and installs the message handler, which routes
// REQUEST_DATA straight to the worker (bypassing the tick-based inbox
// entirely, since REQUEST_DATA isn't keyed by playerID the way the
// dedup-by-key scheme below assumes, and data requests should reach
// server.js immediately rather than wait for the next pickupMessages()
// batch) and folds everything else into the pending inbox via
// queueServerMessage.
function setServerChannel(channel) {
  state.serverChannel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onmessage = (e) => {
    const msg = decode(e.data);
    if (msg.type === 'REQUEST_DATA') {
      serverWorker.postMessage({ type: 'data-request', requestId: msg.requestId, dataType: msg.dataType, mode: msg.mode });
      return;
    }
    queueServerMessage(msg);
  };
}

// onClientReady — registers `callback` to fire once the client channel is
// open. If the channel is already open when this is called (e.g. registered
// late, after a fast handshake), fires immediately instead of waiting for a
// future 'open' event.
function onClientReady(callback) {
  clientReadyCallback = callback;
  if (state.clientChannel?.readyState === 'open') {
    callback();
  }
}

// setClientChannel — wires up the real client-side RTCDataChannel once it
// exists: sets binary mode, fires clientReadyCallback on open, routes
// RESPONSE_DATA messages to routeDataResponse and everything else to the
// registered clientHandler, and notifies the server worker to clean up if
// the channel actually closes (network drop, remote tab closed, etc. — NOT
// the same as receiving LEAVE_REQUEST, which is a message that assumes the
// channel is still alive to send it).
function setClientChannel(channel) {
  state.clientChannel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    console.log('[connection] client channel open');
    clientReadyCallback?.();
  };
  channel.onmessage = (e) => {
    const msg = decode(e.data);
    if (msg.type === 'RESPONSE_DATA') {
      routeDataResponse(msg);
      return;
    }
    state.clientHandler?.(msg);
  };
  channel.onclose = () => {
    console.log('[connection] client channel closed, notifying worker to clean up');
    serverWorker?.postMessage({ type: 'client-disconnected' });
  };
}

// =============================================================================
// data request protocol — REQUEST_DATA / RESPONSE_DATA
// =============================================================================
//
// Two request modes, both usable before JOIN_REQUEST is ever sent (this
// rides the same channel/worker plumbing as everything else and doesn't
// touch server.js's `players` map at all):
//
//   'once'       — fire, resolve/callback exactly once, then the entry is
//                  deleted. requestData() also returns a Promise for this
//                  mode so callers can `await` instead of passing a callback.
//   'continuous' — server re-checks this data every tick and pushes again
//                  only when the value has changed (see server.js's
//                  dataSubscriptions). The callback is stored and re-invoked
//                  on every push; it is NEVER auto-deleted — call
//                  cancelDataRequest(requestId) to stop it.

// requestData — issues a REQUEST_DATA request for `dataType` in the given
// `mode`. In 'once' mode, returns a Promise that resolves with the payload
// (also invoking `callback` if given). In 'continuous' mode, requires a
// callback, stores it keyed by requestId, and returns that requestId so the
// caller can later cancel it via cancelDataRequest.
function requestData(dataType, mode, callback) {
  const requestId = requestIdCounter++;

  if (mode === 'once') {
    return new Promise((resolve, reject) => {
      pendingDataRequests.set(requestId, {
        mode,
        callback: (payload) => {
          callback?.(payload); // optional: caller can use the callback, the Promise, or both
          resolve(payload);
        },
      });
      _sendReal(false, 'REQUEST_DATA', requestId, dataType, mode);
    });
  }

  if (mode === 'continuous') {
    if (typeof callback !== 'function') {
      throw new Error('requestData(..., "continuous", callback) requires a callback');
    }
    pendingDataRequests.set(requestId, { mode, callback });
    _sendReal(false, 'REQUEST_DATA', requestId, dataType, mode);
    return requestId; // caller needs this to cancel later
  }

  throw new Error(`Unknown requestData mode: ${mode}`);
}

// cancelDataRequest — stops a continuous subscription on the client side by
// deleting its pendingDataRequests entry. server.js still holds its own
// subscription entry until the client disconnects or explicitly tells it to
// stop — this only silences the client-side callback. (Fully tearing down
// the server-side subscription isn't wired up yet; flagging rather than
// silently pretending this is a complete unsubscribe.)
function cancelDataRequest(requestId) {
  pendingDataRequests.delete(requestId);
}

// routeDataResponse — looks up the pending request matching a RESPONSE_DATA
// message's requestId, invokes its callback with the payload, and deletes
// the entry if it was a 'once' request. No-ops if the request was
// cancelled, unknown, or already resolved.
function routeDataResponse(msg) {
  const entry = pendingDataRequests.get(msg.requestId);
  if (!entry) return; // response for a cancelled/unknown/already-resolved request

  entry.callback(msg.payload);

  if (entry.mode === 'once') {
    pendingDataRequests.delete(msg.requestId);
  }
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

// resolveInputsCode — applies one raw PLAYER_INPUTS code (set or toggle) on
// top of playerID's tracked bit state, updates that tracked state in place,
// and returns the equivalent resolved "set" code.
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

// queueServerMessage — folds one decoded inbound message into pendingByKey,
// keyed by `${type}:${playerID}`. PLAYER_INPUTS gets special handling via
// resolveInputsCode (see the protocol comment above); everything else is
// latest-wins. Also drops a departed player's tracked input state on
// LEAVE_REQUEST.
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

// flushServerInbox — called once per pickup: hands back the resolved batch
// of pending messages, then resets pendingByKey for the next tick's
// pile-up. playerInputState is NOT cleared here — it has to persist across
// pickups so toggle codes keep resolving correctly.
function flushServerInbox() {
  const batch = [...pendingByKey.values()];
  pendingByKey.clear();
  return batch;
}

// encode — looks up and calls the encoder for `type`, returning the packed
// ArrayBuffer. Throws if `type` has no known encoder.
function encode(type, ...args) {
  const fn = encoders[type];
  if (!fn) throw new Error(`Unknown message type to encode: ${type}`);
  return fn(...args);
}

// decode — reads the leading type byte off `buf`, looks up and calls the
// matching decoder, and returns the resulting decoded message object.
// Throws if the type byte has no known decoder.
function decode(buf) {
  const view = new DataView(buf);
  const type = view.getUint8(0);
  const fn = decoders[type];
  if (!fn) throw new Error(`Unknown message type to decode: ${type}`);
  return fn(view);
}