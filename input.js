// input.js
// tracks raw key/mouse state, maps it through settings.keybinds into
// per-action pressed/changed state, fires placeholder hooks on every
// press/release, and compiles that into an 8-bit "input message" once per
// animation frame (called from client.js's game loop).

const ACTION_BIT_ORDER = ['left', 'right', 'up', 'down', 'fire', 'reload', 'ability'];
const SET_INTERVAL_MS = 500;

const actionState = {};   // action -> currently pressed (bool)
const actionChanged = {}; // action -> changed since the last frame's message (bool)
for (const action of ACTIONS) {
  actionState[action] = false;
  actionChanged[action] = false;
}

const heldBinds = new Set(); // every physical key/click string currently held down
let lastSetTime = 0;         // timestamp (from rAF) of the last "set" message

// --- placeholder hooks - empty for now, fired on every raw press/release ---

function onInputDown(action) {
}

function onInputUp(action) {
}

// --- raw input -> action state ---

function updateActionState(bind, isPressed) {
  if (!bind) return;

  if (isPressed) {
    heldBinds.add(bind);
  } else {
    heldBinds.delete(bind);
  }

  // an action counts as pressed if any of its (possibly several) bound
  // keys/clicks are currently held
  for (const action of ACTIONS) {
    const pressed = settings.keybinds[action].some(b => heldBinds.has(b));
    if (pressed !== actionState[action]) {
      actionState[action] = pressed;
      actionChanged[action] = true;
      if (pressed) {
        onInputDown(action);
      } else {
        onInputUp(action);
      }
    }
  }
}

window.addEventListener('keydown', (e) => {
  if (listeningForAction) return; // settings.js is capturing a new bind right now
  updateActionState(keyEventToBindString(e), true);
});

window.addEventListener('keyup', (e) => {
  updateActionState(keyEventToBindString(e), false);
});

window.addEventListener('mousedown', (e) => {
  if (listeningForAction) return;
  updateActionState(mouseButtonToBindString(e.button), true);
});

window.addEventListener('mouseup', (e) => {
  updateActionState(mouseButtonToBindString(e.button), false);
});

// --- 8-bit message compiling ---

// builds the 8-bit input message and does nothing further with it. leftmost
// bit is the header (1 = set, 0 = toggle), followed by one bit per action in
// ACTION_BIT_ORDER - for a set message, whether it's currently pressed; for
// a toggle message, whether it changed since the last frame. purely a
// placeholder until something downstream consumes it.
function compileInputMessage(isSetMessage) {
  let message = (isSetMessage ? 1 : 0) << 7;

  ACTION_BIT_ORDER.forEach((action, i) => {
    const bit = isSetMessage
      ? (actionState[action] ? 1 : 0)
      : (actionChanged[action] ? 1 : 0);
    message |= bit << (6 - i);
  });

  console.log(message);
}

// called once per animation frame. every 500ms this produces a "set"
// message covering the current state of every action. on other frames, if
// anything changed since the last frame, it produces a "toggle" message
// instead - unless a set message already fired this same frame, in which
// case the change is already covered and no toggle is sent.
function updateInputMessage(now) {
  const isSetFrame = now - lastSetTime >= SET_INTERVAL_MS;

  if (isSetFrame) {
    lastSetTime = now;
    compileInputMessage(true);
  } else if (ACTIONS.some(action => actionChanged[action])) {
    compileInputMessage(false);
  }

  for (const action of ACTIONS) {
    actionChanged[action] = false;
  }
}