// server-browser.js
// fetches the live server list from the registry and renders it into
// #server-list. only polls while the server menu is actually open - no
// point hammering the registry in the background when nobody's looking.
//
// NOTE: SERVER_REGISTRY_URL is duplicated here from server.js. they need to
// stay in sync manually for now - worth pulling into one shared config file
// once there's a third place that needs it.
//
// connecting to a listed server isn't implemented yet - the Connect button
// exists and is wired up, but just reports that WebRTC signaling doesn't
// exist yet rather than pretending to do anything. that's next.

const SERVER_REGISTRY_URL = 'https://gats-server-registry.gitgames.workers.dev';

const POLL_INTERVAL_MS = 4000; // registry has ~1-3s KV propagation delay - no point polling faster

const serverListEl = document.getElementById('server-list');
const btnServersRef = document.getElementById('btn-servers'); // same element script.js already owns for open/close
const btnCloseRef = document.getElementById('btn-close');

let pollIntervalId = null;

if (!serverListEl || !btnServersRef || !btnCloseRef) {
  console.error('Server browser setup failed - missing element:', {
    serverListEl, btnServersRef, btnCloseRef
  });
} else {
  // second, independent listener on the same buttons script.js already
  // listens to - doesn't touch script.js's own open/close logic at all.
  btnServersRef.addEventListener('click', startPolling);
  btnCloseRef.addEventListener('click', stopPolling);
}

function startPolling() {
  fetchAndRenderList(); // don't wait for the first interval tick
  if (pollIntervalId === null) {
    pollIntervalId = setInterval(fetchAndRenderList, POLL_INTERVAL_MS);
  }
}

function stopPolling() {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

async function fetchAndRenderList() {
  let servers;
  try {
    const response = await fetch(`${SERVER_REGISTRY_URL}/list`);
    if (!response.ok) {
      throw new Error(`Registry /list returned ${response.status}`);
    }
    const data = await response.json();
    servers = data.servers;
  } catch (err) {
    console.error('Failed to fetch server list:', err);
    renderError();
    return;
  }

  renderServerList(servers);
}

function renderError() {
  serverListEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'server-list-message';
  msg.textContent = 'Could not reach the server registry.';
  serverListEl.appendChild(msg);
}

function renderServerList(servers) {
  serverListEl.innerHTML = '';

  if (!servers || servers.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'server-list-message';
    msg.textContent = 'No open servers right now.';
    serverListEl.appendChild(msg);
    return;
  }

  for (const server of servers) {
    serverListEl.appendChild(buildServerRow(server));
  }
}

function buildServerRow(server) {
  const row = document.createElement('div');
  row.className = 'server-row';

  const info = document.createElement('div');
  info.className = 'server-row-info';

  const location = document.createElement('span');
  location.className = 'server-row-location';
  location.textContent = `${server.city}, ${server.country}`;
  info.appendChild(location);

  const players = document.createElement('span');
  players.className = 'server-row-players';
  players.textContent = `${server.playerCount}/${server.maxPlayers}`;
  info.appendChild(players);

  if (server.modded) {
    const modded = document.createElement('span');
    modded.className = 'server-row-modded';
    modded.textContent = 'Modded';
    info.appendChild(modded);
  }

  row.appendChild(info);

  const connectBtn = document.createElement('button');
  connectBtn.className = 'server-row-connect';
  connectBtn.textContent = 'Connect';
  connectBtn.addEventListener('click', () => connectToServer(server.sessionId));
  row.appendChild(connectBtn);

  return row;
}

// placeholder - the registry has no /offer or /answer implementation yet,
// so there's no actual signaling to do. this exists so the button does
// something honest instead of nothing at all.
function connectToServer(sessionId) {
  console.log('Would connect to server:', sessionId, '- WebRTC signaling not implemented yet.');
  if (typeof spawnCard === 'function') {
    spawnCard('Connecting not implemented yet.');
  }
}