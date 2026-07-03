// script.js
// owns the UI: menu open/close. once the UI is set up, kicks off client.js
// (canvas + game logic) by calling initClient().
// note: menuOverlay is already declared as a global in settings.js - reused here.

const btnServers = document.getElementById('btn-servers');
const btnClose = document.getElementById('btn-close');

if (!menuOverlay || !btnServers || !btnClose) {
  console.error('Menu setup failed - missing element:', {
    menuOverlay, btnServers, btnClose
  });
} else {
  btnServers.addEventListener('click', () => {
    menuOverlay.classList.remove('hidden');
  });

  btnClose.addEventListener('click', () => {
    menuOverlay.classList.add('hidden');
  });
}

// hand off to client.js for canvas/game setup
initClient();