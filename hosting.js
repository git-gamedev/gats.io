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
// moment this client is allowed to touch the server directly (spawning it).
// after that, if THIS client wants to play on the server it just hosted, it
// connects over the network exactly like any other client would - no
// postMessage game traffic, no shared state. the handshake below exists
// purely to confirm the worker booted, not as a channel for anything else.

const SERVER_DISPATCH_URL = 'https://gats-server-dispatch.gitgames.workers.dev';

const btnHost = document.getElementById('btn-host');

let serverWorker = null;    // the running server Worker, or null if none is hosted
let serverWorkerUrl = null; // blob: URL backing it, kept so we can revoke it on teardown

if (!btnHost) {
  console.error('Hosting setup failed - missing element: btn-host');
} else {
  btnHost.addEventListener('click', onHostButtonClick);
}

// single click handler for the dual-purpose button: starts a server if none
// is running, stops it if one is.
function onHostButtonClick() {
  if (serverWorker) {
    stopServer();
  } else {
    hostServer();
  }
}

async function hostServer() {
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
}

function handleServerMessage(event) {
  if (event.data && event.data.type === 'ready') {
    console.log('Server worker is up and running.');
    setHostButtonState('running');
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