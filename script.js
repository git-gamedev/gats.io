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

let worker;

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