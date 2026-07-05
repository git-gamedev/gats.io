// settings.js

const WRITER_LABEL = 'settings-panel'; // identifies this file's calls in save.js's logs

const ACTIONS = ['left', 'up', 'right', 'down', 'fire', 'reload', 'ability'];

const ACTION_LABELS = {
  left: 'Left',
  up: 'Up',
  right: 'Right',
  down: 'Down',
  fire: 'Fire',
  reload: 'Reload',
  ability: 'Ability'
};

const DEFAULT_KEYBINDS = {
  left: ['a', 'left-arrow'],
  up: ['w', 'up-arrow'],
  right: ['d', 'right-arrow'],
  down: ['s', 'down-arrow'],
  fire: ['left-click'],
  reload: ['r', 'right-click'],
  ability: ['space', 'middle-click']
};

const DEFAULT_BACKGROUND_COLOR = '#111111'; // matches the canvas's original default
const DEFAULT_GRIDLINE_COLOR = '#ffffff';
const DEFAULT_GRIDLINE_OPACITY = 0.025; // all gridlines share the same color/opacity/thickness

// Seed save.data with defaults, the same way the old top-level `settings`
// object used to be built. This still only ever writes into memory
// (save.data's private `data` object, mirrored to save.public) — it does
// not touch any actual file on disk, same as before.
const defaultKeybinds = {};
for (const action of ACTIONS) {
  defaultKeybinds[action] = [...DEFAULT_KEYBINDS[action]];
}
save.data.writePublic('backgroundColor', DEFAULT_BACKGROUND_COLOR, WRITER_LABEL);
save.data.writePublic('gridlineColor', DEFAULT_GRIDLINE_COLOR, WRITER_LABEL);
save.data.writePublic('gridlineOpacity', DEFAULT_GRIDLINE_OPACITY, WRITER_LABEL);
save.data.writePublic('keybinds', defaultKeybinds, WRITER_LABEL);

// --- getters used by client.js every frame ---
// these now read straight from save.public instead of a local `settings`
// object — save.public IS the current source of truth after the seed
// step above.

function getBackgroundColor() {
  return save.public.backgroundColor;
}

function getGridlineColor() {
  const { r, g, b } = hexToRgb(save.public.gridlineColor);
  return `rgba(${r}, ${g}, ${b}, ${save.public.gridlineOpacity})`;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

// --- panel open/close ---

const gearBtn = document.getElementById('btn-settings');
const settingsOverlay = document.getElementById('settings-overlay');
const uiArea = document.getElementById('ui-area');
const menuOverlay = document.getElementById('menu-overlay');
const bgColorInput = document.getElementById('setting-bg-color');
const gridColorInput = document.getElementById('setting-grid-color');
const gridOpacityInput = document.getElementById('setting-grid-opacity');
const keybindList = document.getElementById('keybind-list');
const backBtn = document.getElementById('btn-settings-back');

bgColorInput.value = save.public.backgroundColor;
gridColorInput.value = save.public.gridlineColor;
gridOpacityInput.value = save.public.gridlineOpacity;

bgColorInput.addEventListener('input', () => {
  save.data.writePublic('backgroundColor', bgColorInput.value, WRITER_LABEL);
});

gridColorInput.addEventListener('input', () => {
  save.data.writePublic('gridlineColor', gridColorInput.value, WRITER_LABEL);
});

gridOpacityInput.addEventListener('input', () => {
  save.data.writePublic('gridlineOpacity', parseFloat(gridOpacityInput.value), WRITER_LABEL);
});

function openSettings() {
  uiArea.style.display = 'none';
  menuOverlay.classList.add('hidden');
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  uiArea.style.display = '';
}

gearBtn.addEventListener('click', () => {
  if (settingsOverlay.classList.contains('hidden')) {
    openSettings();
  } else {
    closeSettings();
  }
});

backBtn.addEventListener('click', closeSettings);

// --- keybind list ---

let listeningForAction = null; // action currently waiting for a new bind, or null

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

// Keybinds are stored as ONE object under the single key "keybinds" in
// save.data (matching writePublic('keybinds', defaultKeybinds, ...) above)
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

function keyEventToBindString(e) {
  const key = e.key.toLowerCase();
  if (key === ' ') return 'space';
  if (key === 'arrowleft') return 'left-arrow';
  if (key === 'arrowright') return 'right-arrow';
  if (key === 'arrowup') return 'up-arrow';
  if (key === 'arrowdown') return 'down-arrow';
  return key;
}

function mouseButtonToBindString(button) {
  if (button === 0) return 'left-click';
  if (button === 1) return 'middle-click';
  if (button === 2) return 'right-click';
  return null;
}

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

renderKeybinds();