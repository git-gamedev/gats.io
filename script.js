// script.js
// Owns top-level page wiring: the server-list menu open/close buttons, and
// bootstrapping the game — spinning up server.js as a Worker and connecting
// it to the main thread over an in-page WebRTC loopback (two RTCPeerConnections
// wired directly to each other), then handing the resulting channels to
// connection.js. Once this wiring completes, client.js's game logic can run.
// Note: menuOverlay is already declared as a global in settings.js - reused here.

// btnServers — the "Servers" button that opens the server-list menu.
const btnServers = document.getElementById('btn-servers');

// btnClose — the "Close" button that closes the server-list menu.
const btnClose = document.getElementById('btn-close');

// worker — the Worker instance running server.js, created by the bootstrap
// IIFE below.
let worker;

// wire up the server-list menu's open/close buttons, or log an error if any
// required element is missing
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

// bootstrap: spin up the server Worker, create a client<->server WebRTC data
// channel pair via two locally-wired RTCPeerConnections, and hand the
// resulting channels off to connection.js via setServerChannel/
// setClientChannel
(() => {
  worker = new Worker('./server.js');
  attachServerWorker(worker);

  const serverPC = new RTCPeerConnection();
  const serverChannel = serverPC.createDataChannel('game');
  setServerChannel(serverChannel);

  const clientPC = new RTCPeerConnection();
  clientPC.ondatachannel = (e) => {
    setClientChannel(e.channel);
  };

  serverPC.onicecandidate = (e) => { if (e.candidate) clientPC.addIceCandidate(e.candidate); };
  clientPC.onicecandidate = (e) => { if (e.candidate) serverPC.addIceCandidate(e.candidate); };

  (async () => {
    const offer = await serverPC.createOffer();
    await serverPC.setLocalDescription(offer);
    await clientPC.setRemoteDescription(offer);

    const answer = await clientPC.createAnswer();
    await clientPC.setLocalDescription(answer);
    await serverPC.setRemoteDescription(answer);
  })();
})();