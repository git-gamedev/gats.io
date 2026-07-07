// settings.js
// Seeds save.data with default keybinds/colors/opacity, exposes getters used
// every frame by rendering code, and wires up the settings panel UI:
// opening/closing the panel, editing colors/opacity, and adding/removing
// keybinds per action.

// WRITER_LABEL — identifies this file's calls in save.js's logs.
const WRITER_LABEL = 'settings-panel';

// ACTIONS — canonical list of bindable actions, in keybind-panel display
// order (note: differs from input.js's INPUT_ORDER, which is bit-packing
// order).
const ACTIONS = ['left', 'up', 'right', 'down', 'fire', 'reload', 'ability'];

// ACTION_LABELS — human-readable display label for each action in ACTIONS.
const ACTION_LABELS = {
  left: 'Left',
  up: 'Up',
  right: 'Right',
  down: 'Down',
  fire: 'Fire',
  reload: 'Reload',
  ability: 'Ability'
};

// DEFAULT_KEYBINDS — default bind list for each action, used to seed
// save.data on first load.
const DEFAULT_KEYBINDS = {
  left: ['a', 'left-arrow'],
  up: ['w', 'up-arrow'],
  right: ['d', 'right-arrow'],
  down: ['s', 'down-arrow'],
  fire: ['left-click'],
  reload: ['r', 'right-click'],
  ability: ['space', 'middle-click']
};

// DEFAULT_BACKGROUND_COLOR — default canvas background color; matches the
// canvas's original hardcoded default.
const DEFAULT_BACKGROUND_COLOR = '#111111';

// DEFAULT_GRIDLINE_COLOR — default gridline color.
const DEFAULT_GRIDLINE_COLOR = '#ffffff';

// DEFAULT_GRIDLINE_OPACITY — default gridline opacity; all gridlines share
// the same color/opacity/thickness.
const DEFAULT_GRIDLINE_OPACITY = 0.025;

// defaultKeybinds — working copy of DEFAULT_KEYBINDS built below (one array
// per action, cloned so later per-action mutation doesn't touch the DEFAULT_
// KEYBINDS constant itself), then written into save.data as the initial
// 'keybinds' value.
const defaultKeybinds = {};

// gearBtn — the settings-panel toggle button (gear icon).
const gearBtn = document.getElementById('btn-settings');

// settingsOverlay — the settings panel's overlay element.
const settingsOverlay = document.getElementById('settings-overlay');

// uiArea — the main menu UI area (weapon/shield select + play/servers), hidden
// while the settings panel is open.
const uiArea = document.getElementById('ui-area');

// menuOverlay — the server-list menu overlay element. Declared as a global
// here; reused by script.js.
const menuOverlay = document.getElementById('menu-overlay');

// bgColorInput — the background-color <input type="color"> element.
const bgColorInput = document.getElementById('setting-bg-color');

// gridColorInput — the gridline-color <input type="color"> element.
const gridColorInput = document.getElementById('setting-grid-color');

// gridOpacityInput — the gridline-opacity <input type="range"> element.
const gridOpacityInput = document.getElementById('setting-grid-opacity');

// keybindList — container element that the per-action keybind rows are
// rendered into.
const keybindList = document.getElementById('keybind-list');

// backBtn — the settings panel's "Back" button.
const backBtn = document.getElementById('btn-settings-back');

// listeningForAction — the action currently waiting for a new keybind to be
// captured (via the next keydown/mousedown), or null if not currently
// listening.
let listeningForAction = null;

// getBackgroundColor — returns the current canvas background color from
// save.public. Read by rendering.js every frame.
function getBackgroundColor() {
  return save.public.backgroundColor;
}

// getGridlineColor — returns the current gridline color as an rgba() string,
// combining save.public's gridline color and opacity. Read by rendering.js
// every frame.
function getGridlineColor() {
  const { r, g, b } = hexToRgb(save.public.gridlineColor);
  return `rgba(${r}, ${g}, ${b}, ${save.public.gridlineOpacity})`;
}

// hexToRgb — converts a '#rrggbb' hex color string into an { r, g, b }
// object of integer channel values.
function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

// openSettings — hides the main UI area and server-list menu, then reveals
// the settings overlay.
function openSettings() {
  uiArea.style.display = 'none';
  menuOverlay.classList.add('hidden');
  settingsOverlay.classList.remove('hidden');
}

// closeSettings — hides the settings overlay and restores the main UI area.
function closeSettings() {
  settingsOverlay.classList.add('hidden');
  uiArea.style.display = '';
}

// renderKeybinds — rebuilds the entire keybind list UI from save.public.
// keybinds: one row per action, each showing its current binds as removable
// chips (an action's last remaining bind can't be removed) plus an "+ Add"
// button that starts capture mode for that action.
function renderKeybinds() {
  keybindList.innerHTML = '';

  for (const action of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keybind-row';

    const label = document.createElement('span');
    label.className = 'keybind-label';
    label.textContent = ACTION_LABELS[action];
    row.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'keybind-chips';

    for (const bind of save.public.keybinds[action]) {
      const chip = document.createElement('span');
      chip.className = 'keybind-chip';
      chip.append(bind + ' ');

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-bind';
      removeBtn.textContent = '\u00d7';
      // an action must always keep at least one keybind
      removeBtn.disabled = save.public.keybinds[action].length <= 1;
      removeBtn.addEventListener('click', () => removeKeybind(action, bind));

      chip.appendChild(removeBtn);
      chips.appendChild(chip);
    }
    row.appendChild(chips);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-bind';
    addBtn.textContent = listeningForAction === action ? 'Press a key...' : '+ Add';
    addBtn.addEventListener('click', () => {
      listeningForAction = action;
      renderKeybinds();
    });
    row.appendChild(addBtn);

    keybindList.appendChild(row);
  }
}

// removeKeybind — removes `bind` from `action`'s bind list and writes the
// whole updated keybinds object back to save.data (see the comment above
// these functions on why whole-object writes), then re-renders the keybind
// list. No-ops if `bind` is the action's only remaining bind.
//
// Keybinds are stored as ONE object under the single key "keybinds" in
// save.data (matching writePublic('keybinds', defaultKeybinds, ...) below)
// rather than one save key per action. So every keybind change reads the
// whole keybinds object out, mutates a local working copy, and writes the
// WHOLE object back via writePublic — writePublic has no concept of
// "just update one nested field," it replaces whatever value is passed in
// under that key.
function removeKeybind(action, bind) {
  const binds = save.public.keybinds[action];
  if (binds.length <= 1) return; // must keep at least one keybind for every action

  const updatedKeybinds = structuredClone(save.public.keybinds);
  updatedKeybinds[action] = binds.filter(b => b !== bind);
  save.data.writePublic('keybinds', updatedKeybinds, WRITER_LABEL);
  renderKeybinds();
}

// addKeybind — adds `bind` to `action`'s bind list (no-op if already
// present) and writes the whole updated keybinds object back to save.data,
// then clears listeningForAction and re-renders the keybind list.
function addKeybind(action, bind) {
  const binds = save.public.keybinds[action];
  if (binds.includes(bind)) {
    listeningForAction = null;
    renderKeybinds();
    return;
  }

  const updatedKeybinds = structuredClone(save.public.keybinds);
  updatedKeybinds[action] = [...binds, bind];
  save.data.writePublic('keybinds', updatedKeybinds, WRITER_LABEL);
  listeningForAction = null;
  renderKeybinds();
}

// keyEventToBindString — converts a keyboard event into this app's bind
// string format (lowercased key, with space/arrow keys given readable
// names).
function keyEventToBindString(e) {
  const key = e.key.toLowerCase();
  if (key === ' ') return 'space';
  if (key === 'arrowleft') return 'left-arrow';
  if (key === 'arrowright') return 'right-arrow';
  if (key === 'arrowup') return 'up-arrow';
  if (key === 'arrowdown') return 'down-arrow';
  return key;
}

// mouseButtonToBindString — converts a mouse event's button index into this
// app's bind string format, or null for buttons with no assigned bind
// string.
function mouseButtonToBindString(button) {
  if (button === 0) return 'left-click';
  if (button === 1) return 'middle-click';
  if (button === 2) return 'right-click';
  return null;
}

// Seed save.data with defaults, the same way the old top-level `settings`
// object used to be built. This still only ever writes into memory
// (save.data's private `data` object, mirrored to save.public) — it does
// not touch any actual file on disk, same as before.
for (const action of ACTIONS) {
  defaultKeybinds[action] = [...DEFAULT_KEYBINDS[action]];
}
save.data.writePublic('backgroundColor', DEFAULT_BACKGROUND_COLOR, WRITER_LABEL);
save.data.writePublic('gridlineColor', DEFAULT_GRIDLINE_COLOR, WRITER_LABEL);
save.data.writePublic('gridlineOpacity', DEFAULT_GRIDLINE_OPACITY, WRITER_LABEL);
save.data.writePublic('keybinds', defaultKeybinds, WRITER_LABEL);

// initialize the settings-panel inputs to the just-seeded values
bgColorInput.value = save.public.backgroundColor;
gridColorInput.value = save.public.gridlineColor;
gridOpacityInput.value = save.public.gridlineOpacity;

// wire up settings-panel input change handlers
bgColorInput.addEventListener('input', () => {
  save.data.writePublic('backgroundColor', bgColorInput.value, WRITER_LABEL);
});

gridColorInput.addEventListener('input', () => {
  save.data.writePublic('gridlineColor', gridColorInput.value, WRITER_LABEL);
});

gridOpacityInput.addEventListener('input', () => {
  save.data.writePublic('gridlineOpacity', parseFloat(gridOpacityInput.value), WRITER_LABEL);
});

// wire up the settings gear button to toggle the panel, and the back button
// to close it
gearBtn.addEventListener('click', () => {
  if (settingsOverlay.classList.contains('hidden')) {
    openSettings();
  } else {
    closeSettings();
  }
});

backBtn.addEventListener('click', closeSettings);

// while listening, the next key press or mouse click becomes the new bind
window.addEventListener('keydown', (e) => {
  if (!listeningForAction) return;
  if (e.key === 'Escape') {
    listeningForAction = null;
    renderKeybinds();
    return;
  }
  e.preventDefault();
  addKeybind(listeningForAction, keyEventToBindString(e));
});

window.addEventListener('mousedown', (e) => {
  if (!listeningForAction) return;
  const bind = mouseButtonToBindString(e.button);
  if (bind) {
    e.preventDefault();
    addKeybind(listeningForAction, bind);
  }
});

// stop the right-click context menu from popping up while capturing a bind
window.addEventListener('contextmenu', (e) => {
  if (listeningForAction) e.preventDefault();
});

// initial render of the keybind list, using the defaults just seeded above
renderKeybinds();