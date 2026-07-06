const heldKeys = new Set();
const mouse = { x: 0, y: 0, moved: false }; // screen-space pixels, canvas-relative

const INPUT_ORDER = ['left', 'right', 'up', 'down', 'fire', 'reload', 'ability'];
let lastInputState = INPUT_ORDER.map(() => false);

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
window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  mouse.moved = true;
  updateLookaround(mouse, canvas);
});
function isActionPressed(action) {
  return save.public.keybinds[action].some(bind => heldKeys.has(bind));
}

function returnInputs() {
  const currentState = INPUT_ORDER.map(isActionPressed);

  let code = 0b10000000; // always a set packet

  currentState.forEach((pressed, i) => {
    if (pressed) code |= (1 << (6 - i));
  });

  lastInputState = currentState;
  return code;
}

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