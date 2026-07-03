// connection.js
// runs once at startup (called from script.js). decides how this client
// gets into a game with no user interaction required:
//   1. fetch the live server list.
//   2. among servers with room (playerCount < maxPlayers), connect to the
//      oldest one (lowest createdAt) - "oldest" is meaningful because
//      server-registry.js now preserves createdAt across a server's own
//      heartbeats instead of resetting it every time.
//   3. if there's no server at all, or every listed server is full, host
//      one instead (via hosting.js's hostServer()), then connect to it -
//      but only once it's actually visible in the registry, not just once
//      the Worker has booted. those are different moments (see server.js's
//      'ready' vs 'registered' messages) because /register is an async
//      network call that can land after 'ready' fires.
//
// reuses connectToServer() from server-browser.js as the actual connect
// step, so there's exactly one code path for "connect to a sessionId"
// whether it was chosen from the manual list or picked automatically here.

async function autoConnect() {
  let servers;
  try {
    const response = await fetch(`${SERVER_REGISTRY_URL}/list`);
    if (!response.ok) {
      throw new Error(`Registry /list returned ${response.status}`);
    }
    const data = await response.json();
    servers = data.servers || [];
  } catch (err) {
    console.error('Auto-connect: failed to fetch server list:', err);
    // no list to work from - fall back to hosting rather than getting stuck
    // with no path forward at all.
    servers = [];
  }

  const joinable = servers
    .filter(s => s.playerCount < s.maxPlayers)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (joinable.length > 0) {
    const target = joinable[0];
    console.log('Auto-connect: joining oldest open server', target.sessionId);
    connectToServer(target.sessionId);
    return;
  }

  console.log('Auto-connect: no open servers, hosting one.');
  hostAndConnect();
}

// starts a server with default config and connects to it as soon as it's
// confirmed registered. onServerRegistered is hosting.js's hook - set it
// here rather than having hosting.js know anything about connection logic.
function hostAndConnect() {
  onServerRegistered = (sessionId) => {
    onServerRegistered = null;
    console.log('Auto-connect: hosted server registered, connecting.', sessionId);
    connectToServer(sessionId);
  };

  // DEFAULT_HOST_CONFIG (server.js) already defaults maxPlayers to 25 on
  // its own if no config arrives at all, but hostServer() always sends a
  // config message (see hosting.js), so the default is made explicit here
  // rather than relying on a message that happens to omit the field.
  hostServer({ maxPlayers: 25 });
}