// camera.js
// Defines the game camera: its true (follow-target) position, a mouse-driven
// lookaround offset, and the combined render position derived from the two.
// Exposes functions to update the lookaround offset from mouse input, to set
// the true position directly, and to ease the true position toward a
// followed player each frame.

// camera — holds the camera's true position, lookaround offset, the combined
// renderpos used by all drawing/screen-conversion code, and tunable values
// controlling lookaround range and follow easing speed.
const camera = {
  truepos: { x: 0, y: 0 },
  lookaround: { x: 0, y: 0 },
  renderpos: { x: 0, y: 0 },
  value: {
    LOOKAROUND_RANGE: 1,
    CAMERA_EASE_RATE: 3,
  }
};

// updateRenderPos — recomputes camera.renderpos as truepos + lookaround.
// Called after truepos or lookaround changes so renderpos never goes stale.
function updateRenderPos() {
  camera.renderpos.x = camera.truepos.x + camera.lookaround.x;
  camera.renderpos.y = camera.truepos.y + camera.lookaround.y;
}

// updateLookaround — converts the current mouse position into a normalized
// (-1..1) offset scaled by LOOKAROUND_RANGE, storing it as camera.lookaround,
// then refreshes renderpos. Called on mouse movement.
function updateLookaround(mouse, canvas) {
  const normX = (mouse.x / canvas.width) * 2 - 1;
  const normY = -((mouse.y / canvas.height) * 2 - 1); // screen-bottom = -1

  camera.lookaround.x = camera.value.LOOKAROUND_RANGE * normX;
  camera.lookaround.y = -camera.value.LOOKAROUND_RANGE * normY;

  updateRenderPos();
}

// setTruePos — directly assigns the camera's true position to (x, y) and
// refreshes renderpos. Currently unused by the running game loop, but kept
// as the entry point for any future non-follow camera movement.
function setTruePos(x, y) {
  camera.truepos.x = x;
  camera.truepos.y = y;
  updateRenderPos();
}

// updateCameraFollow — eases camera.truepos toward the given player's
// renderPos over time dt, using an exponential ease based on
// CAMERA_EASE_RATE, then refreshes renderpos. Called once per frame from the
// client loop so the camera trails the player smoothly rather than snapping.
function updateCameraFollow(dt, player) {
  const factor = 1 - Math.exp(-camera.value.CAMERA_EASE_RATE * dt);
  camera.truepos.x += (player.renderPos.x - camera.truepos.x) * factor;
  camera.truepos.y += (player.renderPos.y - camera.truepos.y) * factor;
  updateRenderPos();
}