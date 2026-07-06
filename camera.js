const camera = {
  truepos: { x: 0, y: 0 },
  lookaround: { x: 0, y: 0 },
  renderpos: { x: 0, y: 0 },
  value: {
    LOOKAROUND_RANGE: 1,
    CAMERA_EASE_RATE: 3,
  }
};

function updateRenderPos() {
  camera.renderpos.x = camera.truepos.x + camera.lookaround.x;
  camera.renderpos.y = camera.truepos.y + camera.lookaround.y;
}

function updateLookaround(mouse, canvas) {
  const normX = (mouse.x / canvas.width) * 2 - 1;
  const normY = -((mouse.y / canvas.height) * 2 - 1); // screen-bottom = -1

  camera.lookaround.x = camera.value.LOOKAROUND_RANGE * normX;
  camera.lookaround.y = -camera.value.LOOKAROUND_RANGE * normY;

  updateRenderPos();
}

function setTruePos(x, y) {
  camera.truepos.x = x;
  camera.truepos.y = y;
  updateRenderPos();
}

function updateCameraFollow(dt, player) {
  const factor = 1 - Math.exp(-camera.value.CAMERA_EASE_RATE * dt);
  camera.truepos.x += (player.renderPos.x - camera.truepos.x) * factor;
  camera.truepos.y += (player.renderPos.y - camera.truepos.y) * factor;
  updateRenderPos();
}