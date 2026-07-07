// input.js
// Tracks currently-held keys/mouse buttons and the current mouse position,
// converts held input into the packed bit-code the network protocol expects,
// and sends per-frame input/aim messages to the server.

// heldKeys — set of bind-string identifiers (e.g. 'w', 'left-click') for
// every key/mouse button currently held down.
const heldKeys = new Set();

// mouse — current mouse position in screen-space pixels, canvas-relative,
// plus a `moved` flag marking whether it has moved since the last send.
const mouse = { x: 0, y: 0, moved: false };

// INPUT_ORDER — canonical bit order of the 7 tracked actions; must match the
// bit order server.js's decodeInputs expects.
const INPUT_ORDER = ['left', 'right', 'up', 'down', 'fire', 'reload', 'ability'];

// lastInputState — last computed pressed/released state for every action in
// INPUT_ORDER, in the same order.
let lastInputState = INPUT_ORDER.map(() => false);

// isActionPressed — returns whether any bind currently assigned to `action`
// (per the user's keybind settings) is currently held.
function isActionPressed(action) {
  return save.public.keybinds[action].some(bind => heldKeys.has(bind));
}

// returnInputs — computes the current pressed/released state of every
// action in INPUT_ORDER, packs it into a single "set" code (high bit always
// set, one bit per action), updates lastInputState, and returns the code.
function returnInputs() {
  const currentState = INPUT_ORDER.map(isActionPressed);

  let code = 0b10000000; // always a set packet

  currentState.forEach((pressed, i) => {
    if (pressed) code |= (1 << (6 - i));
  });

  lastInputState = currentState;
  return code;
}

// sendInputs — sends the current input code to the server as
// PLAYER_INPUTS (skipped if the code is 0, i.e. nothing pressed), and, if
// the mouse has moved since the last call, sends the current world-space
// aim position as PLAYER_AIM and clears the moved flag.
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

// register key/mouse listeners that track held state into heldKeys
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

// register the mousemove listener that tracks screen-space mouse position
// and feeds it to the camera's lookaround
window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  mouse.moved = true;
  updateLookaround(mouse, canvas);
});