// hosting.js
// owns spawning/tearing down a client-hosted game server. the server source
// is fetched as a plain JS string from the Cloudflare dispatch worker, then
// run as a dedicated Worker - a separate thread, still inside this browser
// tab, which dies automatically when the tab closes (dedicated Workers are
// tab-scoped; unlike SharedWorker, there's nothing to explicitly tear down
// on unload for that part).
//
// IMPORTANT: once the server Worker is running, this file's job is done.
// btn-host is the exception to "no direct interactions" - it's the one
// moment this client is allowed to touch the server directly (spawning it,
// and sending it the host's chosen config once, right after spawning).
// after that, if THIS client wants to play on the server it just hosted, it
// connects over the network exactly like any other client would - no
// postMessage game traffic, no shared state. the config message and the
// 'ready' reply are a one-off boot handshake, not a channel for anything
// beyond startup.
//
// deliberately minimal: this file only knows how to spawn a browser-hosted
// server Worker. registry registration/heartbeat lives in server.js itself,
// not here - so that a permanent, standalone-hosted server (someone running
// server.js directly via node, no browser tab at all) registers itself the
// same way without this file being involved at all.

const SERVER_DISPATCH_URL = 'https://gats-server-dispatch.gitgames.workers.dev';

const btnHost = document.getElementById('btn-host');
const hostConfigOverlay = document.getElementById('host-config-overlay');
const maxPlayersInput = document.getElementById('host-config-max-players');
const btnHostConfigCancel = document.getElementById('btn-host-config-cancel');
const btnHostConfigStart = document.getElementById('btn-host-config-start');

let serverWorker = null;    // the running server Worker, or null if none is hosted
let serverWorkerUrl = null; // blob: URL backing it, kept so we can revoke it on teardown

if (!btnHost || !hostConfigOverlay || !maxPlayersInput || !btnHostConfigCancel || !btnHostConfigStart) {
  console.error('Hosting setup failed - missing element:', {
    btnHost, hostConfigOverlay, maxPlayersInput, btnHostConfigCancel, btnHostConfigStart
  });
} else {
  btnHost.addEventListener('click', onHostButtonClick);
  btnHostConfigCancel.addEventListener('click', closeHostConfigOverlay);
  btnHostConfigStart.addEventListener('click', onHostConfigConfirmed);
}

// single click handler for the dual-purpose button: opens the config panel
// to start a server if none is running, stops it directly if one is (no
// config needed to stop).
function onHostButtonClick() {
  if (serverWorker) {
    stopServer();
  } else {
    openHostConfigOverlay();
  }
}

function openHostConfigOverlay() {
  menuOverlay.classList.add('hidden');
  hostConfigOverlay.classList.remove('hidden');
}

function closeHostConfigOverlay() {
  hostConfigOverlay.classList.add('hidden');
  menuOverlay.classList.remove('hidden'); // back to the server list
}

// reads the config panel's fields, validates them, and - if valid - closes
// the panel and actually starts the server with that config. this is the
// one place field values get parsed out of the DOM; hostServer() itself
// just takes a plain config object, so it doesn't care where the values
// came from.
function onHostConfigConfirmed() {
  const maxPlayers = parseInt(maxPlayersInput.value, 10);

  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 100) {
    maxPlayersInput.reportValidity();
    return;
  }

  closeHostConfigOverlay();
  hostServer({ maxPlayers });
}

async function hostServer(hostConfig) {
  setHostButtonState('starting');

  let serverSource;
  try {
    const response = await fetch(SERVER_DISPATCH_URL);
    if (!response.ok) {
      throw new Error(`Dispatch worker returned ${response.status}`);
    }
    serverSource = await response.text();
  } catch (err) {
    console.error('Failed to fetch server code:', err);
    setHostButtonState('idle');
    return;
  }

  // wrap the fetched source in a Blob so it can be handed to the Worker
  // constructor as a URL, same as if it were a static .js file on disk.
  const blob = new Blob([serverSource], { type: 'application/javascript' });
  serverWorkerUrl = URL.createObjectURL(blob);

  try {
    serverWorker = new Worker(serverWorkerUrl);
  } catch (err) {
    console.error('Failed to start server worker:', err);
    URL.revokeObjectURL(serverWorkerUrl);
    serverWorkerUrl = null;
    setHostButtonState('idle');
    return;
  }

  serverWorker.addEventListener('message', handleServerMessage);
  serverWorker.addEventListener('error', handleServerError);

  // one-off boot handshake, not ongoing game traffic - the browser queues
  // messages sent to a Worker before its listener attaches, so this is
  // safe to send immediately without waiting for anything back first.
  // server.js waits for this before registering or sending 'ready'.
  serverWorker.postMessage({ type: 'config', config: hostConfig });
}

// startup.js sets this if it needs to know when the server it just told us
// to host has actually made it into the registry (not just booted - see
// the 'registered' case below). null the rest of the time; hosting.js has
// no opinion on why anyone would want this, it just relays the one event.
let onServerRegistered = null;

function handleServerMessage(event) {
  if (!event.data) return;

  if (event.data.type === 'ready') {
    console.log('Server worker is up and running.');
    setHostButtonState('running');
  } else if (event.data.type === 'registered') {
    if (onServerRegistered) onServerRegistered(event.data.sessionId);
  }
  // server.js will grow more message types (status, player counts, etc.)
  // later - this handler is the one place to add cases for those.
}

function handleServerError(err) {
  console.error('Server worker error:', err.message || err);
  stopServer();
}

function stopServer() {
  if (serverWorker) {
    serverWorker.terminate();
    serverWorker = null;
  }
  if (serverWorkerUrl) {
    URL.revokeObjectURL(serverWorkerUrl);
    serverWorkerUrl = null;
  }
  onServerRegistered = null;
  setHostButtonState('idle');
}

// tab close/reload: dedicated Workers already die on their own here, this
// just releases the blob URL so it's not held past the point it's useful.
window.addEventListener('beforeunload', () => {
  if (serverWorkerUrl) URL.revokeObjectURL(serverWorkerUrl);
});

function setHostButtonState(state) {
  switch (state) {
    case 'starting':
      btnHost.disabled = true;
      btnHost.textContent = 'Starting...';
      break;
    case 'running':
      btnHost.disabled = false;
      btnHost.textContent = 'Stop Server';
      break;
    case 'idle':
    default:
      btnHost.disabled = false;
      btnHost.textContent = 'Host Server';
      break;
  }
}