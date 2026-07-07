// rendering.js
// All canvas drawing and screen/world coordinate conversion for the game
// client: color utilities, world<->screen transforms, view-rect/arena-clip
// helpers, client-side position prediction, and the per-frame draw
// functions for the grid, boxes, arena border, player, and minimap.

// getContrastBorderColor — returns an rgb() string, using perceptual
// luminance of the given hex color to pick a contrasting grey border color
// (light border on dark fills, dark border on light fills).
function getContrastBorderColor(hexColor) {
  const { r, g, b } = hexToRgb(hexColor);
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  const contrast = (grey + 128) % 256;
  return `rgb(${contrast}, ${contrast}, ${contrast})`;
}

// strokeInsetRect — strokes a rectangle inset by half the border width on
// every side, so the stroke's outer edge lands exactly on (x, y, w, h)
// rather than bleeding outside it (see drawBoxes for the full reasoning).
function strokeInsetRect(ctx, x, y, w, h, borderPx, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = borderPx;
  ctx.strokeRect(x + borderPx / 2, y + borderPx / 2, w - borderPx, h - borderPx);
}

// hideAllMenus — hides every menu overlay, shows the minimap, and hides the
// main menu UI area and settings gear button. Called once the game actually
// starts.
function hideAllMenus() {
  document.getElementById('menu-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('host-config-overlay').classList.add('hidden');
  document.getElementById('mini-map').classList.remove('hidden');
  document.getElementById('ui-area').style.display = 'none';
  document.getElementById('btn-settings').style.display = 'none';
}

// screenToWorld — converts a screen-space pixel coordinate (canvas-relative)
// into world-space coordinates, using the camera's render position and the
// current unit pixel size.
function screenToWorld(screenX, screenY) {
  const unitSize = getUnitPixelSize();
  return {
    x: camera.renderpos.x + (screenX - canvas.width / 2) / unitSize,
    y: camera.renderpos.y + (screenY - canvas.height / 2) / unitSize,
  };
}

// worldToScreen — converts a world-space coordinate into screen-space pixel
// coordinates, using the camera's render position and the current unit
// pixel size.
function worldToScreen(worldX, worldY) {
  const unitSize = getUnitPixelSize();
  return {
    x: canvas.width / 2 + (worldX - camera.renderpos.x) * unitSize,
    y: canvas.height / 2 + (worldY - camera.renderpos.y) * unitSize,
  };
}

// getUnitPixelSize — returns how many screen pixels one world unit
// currently occupies, scaling with canvas width but never shrinking below a
// floor of 15px per unit.
function getUnitPixelSize() {
  return Math.max(canvas.width / 60, 15);
}

// getViewWorldRect — returns the world-space rectangle currently visible on
// screen, expanded by VIEW_CULL_MARGIN on every side so objects just outside
// the literal viewport are still considered visible for culling purposes.
function getViewWorldRect() {
  const unitSize = getUnitPixelSize();
  const halfWidthWorld = (canvas.width / 2) / unitSize;
  const halfHeightWorld = (canvas.height / 2) / unitSize;

  return {
    minX: camera.renderpos.x - halfWidthWorld - VIEW_CULL_MARGIN,
    maxX: camera.renderpos.x + halfWidthWorld + VIEW_CULL_MARGIN,
    minY: camera.renderpos.y - halfHeightWorld - VIEW_CULL_MARGIN,
    maxY: camera.renderpos.y + halfHeightWorld + VIEW_CULL_MARGIN,
  };
}

// withArenaClip — clips subsequent canvas drawing to the arena's interior
// world rect (converted to screen space) for the duration of calling `fn`,
// then restores the canvas state. Draws unclipped if arena size hasn't
// loaded yet, rather than drawing nothing.
function withArenaClip(fn) {
  const rect = getArenaInteriorWorldRect();
  if (!rect) {
    fn(); // arena size not loaded yet — draw unclipped rather than draw nothing
    return;
  }

  const topLeft = worldToScreen(rect.minX, rect.minY);
  const bottomRight = worldToScreen(rect.maxX, rect.maxY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Math.min(topLeft.x, bottomRight.x),
    Math.min(topLeft.y, bottomRight.y),
    Math.abs(bottomRight.x - topLeft.x),
    Math.abs(bottomRight.y - topLeft.y)
  );
  ctx.clip();
  fn();
  ctx.restore();
}

// getArenaInteriorWorldRect — returns the arena's interior world-space rect
// centered on the origin, or null if arenaSize hasn't been fetched yet.
function getArenaInteriorWorldRect() {
  if (!arenaSize) return null;
  return {
    minX: -arenaSize.width / 2,
    maxX: arenaSize.width / 2,
    minY: -arenaSize.height / 2,
    maxY: arenaSize.height / 2,
  };
}

// predictPlayerPosition — advances myPlayer.renderPos by dead-reckoning from
// the last authoritative position/velocity plus elapsed time, then applies
// and decays any pending correction (see CORRECTION_DECAY_MS). Falls back to
// the last known-good authoritative position if the result is non-finite.
// Called once per frame before drawing the player.
function predictPlayerPosition(dt) {
    myPlayer.timeSinceUpdate += dt;

    const predictedX = myPlayer.position.x + myPlayer.velocity.x * myPlayer.timeSinceUpdate;
    const predictedY = myPlayer.position.y + myPlayer.velocity.y * myPlayer.timeSinceUpdate;

    let nextX = predictedX + myPlayer.correction.x;
    let nextY = predictedY + myPlayer.correction.y;

    // guard: if anything upstream produced NaN/Infinity, fall back to the
    // last known-good authoritative position rather than drawing garbage
    // (or nothing at all, since canvas silently no-ops on NaN coordinates).
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
      console.warn('[client] renderPos went non-finite, resetting to authoritative position', { predictedX, predictedY, correction: { ...myPlayer.correction } });
      nextX = myPlayer.position.x;
      nextY = myPlayer.position.y;
      myPlayer.correction.x = 0;
      myPlayer.correction.y = 0;
    }

    myPlayer.renderPos.x = nextX;
    myPlayer.renderPos.y = nextY;

    // decay the leftover correction back to zero over CORRECTION_DECAY_MS
    const decay = Math.max(1 - dt * 1000 / CORRECTION_DECAY_MS, 0);
    myPlayer.correction.x *= decay;
    myPlayer.correction.y *= decay;
}

// drawArenaBorder — draws the arena's outer border, inset by half the
// border width so it sits fully within the arena's actual boundary line.
// No-ops if arenaSize hasn't been fetched yet.
function drawArenaBorder() {
  if (!arenaSize) return; // not fetched yet

  const unitSize = getUnitPixelSize();
  const borderPx = ARENA_BORDER_THICKNESS_UNITS * unitSize;

  const topLeft = worldToScreen(-arenaSize.width / 2, -arenaSize.height / 2);
  const bottomRight = worldToScreen(arenaSize.width / 2, arenaSize.height / 2);
  const wPx = bottomRight.x - topLeft.x;
  const hPx = bottomRight.y - topLeft.y;

  // inset by half the border width on every side, same reasoning as
  // drawBoxes' strokeRect call — keeps the border fully within the arena's
  // actual boundary line rather than straddling it
  ctx.strokeStyle = getContrastBorderColor(save.public.backgroundColor);
  ctx.lineWidth = borderPx;
  ctx.strokeRect(
    topLeft.x - borderPx / 2,
    topLeft.y - borderPx / 2,
    wPx + borderPx,
    hPx + borderPx
  );
}

// drawBoxes — draws every world box currently within the view rect (queried
// from the spatial index, clipped to the arena interior). Fills at full box
// size (the hitbox) then strokes an inset border so the border never
// extends past the hitbox boundary. No-ops if renderBoxes hasn't been baked
// yet.
function drawBoxes() {
  if (!renderBoxes) return; // not baked yet (fetch + bakeRenderBoxes hasn't resolved)

  withArenaClip(() => {
    const unitSize = getUnitPixelSize();
    const borderPx = BOX_BORDER_THICKNESS_UNITS * unitSize;
    const borderColor = getContrastBorderColor(save.public.backgroundColor);

    const view = getViewWorldRect();
    const visibleBoxes = queryAABB(renderBoxesByMinX, view.minX, view.maxX, view.minY, view.maxY)
      .map(c => renderBoxes[c.i]);

    for (const box of visibleBoxes) {
      const isSquare = box.width === box.height;
      const topLeft = worldToScreen(box.x - box.width / 2, box.y - box.height / 2);
      const wPx = box.width * unitSize;
      const hPx = box.height * unitSize;

      // fill first, full box size — this is the hitbox, unaffected by border
      ctx.fillStyle = isSquare ? BOX_FILL_COLOR_SQUARE : BOX_FILL_COLOR_SKINNY;
      ctx.fillRect(topLeft.x, topLeft.y, wPx, hPx);

      // border second, drawn INSET by half its own width so the stroke's
      // outer edge lands exactly on the hitbox boundary. ctx.strokeRect
      // centers the stroke on the path it's given — half the lineWidth draws
      // outside that path, half inside — so stroking the box's own edges at
      // full lineWidth would push borderPx/2 outside the hitbox on every
      // side. Shrinking the stroked rect inward by borderPx/2 on each edge
      // cancels that outward half, keeping the whole border within bounds.
      strokeInsetRect(ctx, topLeft.x, topLeft.y, wPx, hPx, borderPx, borderColor);
    }
  });
}

// drawPlayer — draws myPlayer as a filled, bordered circle at its current
// renderPos, converted to screen space.
function drawPlayer() {
  const screenPos = worldToScreen(myPlayer.renderPos.x, myPlayer.renderPos.y);
  const radiusPx = PLAYER_RADIUS * getUnitPixelSize();

  ctx.beginPath();
  ctx.arc(screenPos.x, screenPos.y, radiusPx, 0, Math.PI * 2);
  ctx.fillStyle = '#3399ff';
  ctx.fill();
  ctx.lineWidth = PLAYER_BORDER_PX;
  ctx.strokeStyle = getContrastBorderColor(save.public.backgroundColor);
  ctx.stroke();
}

// drawGrid — fills the full canvas with the background color (outside the
// arena clip, so it covers the whole screen regardless of arena size), then
// draws gridlines clipped to the arena interior, snapped to whole pixels so
// they stay consistent with everything else drawn via worldToScreen.
function drawGrid() {
  const unitSize = getUnitPixelSize();

  // full-canvas background fill happens OUTSIDE the arena clip — this is
  // the "typical background color" visible past the frame edge, and it must
  // stay full-canvas regardless of arena size/position so there's never an
  // unpainted gap between the frame and the screen edge
  ctx.fillStyle = getBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  withArenaClip(() => {
    ctx.strokeStyle = getGridlineColor();
    ctx.lineWidth = 1;

    // rounded for the same reason worldToScreen rounds its output — see that
    // function's comment. Gridlines don't go through worldToScreen (they're
    // built directly from a repeating offset, not per-point world
    // coordinates), so they need the same snap applied here explicitly or
    // they'd "flex" independently of, and inconsistently with, everything
    // that does go through worldToScreen.
    const centerX = Math.round(canvas.width / 2);
    const centerY = Math.round(canvas.height / 2);
    const offsetX = centerX - Math.round(camera.renderpos.x * unitSize) % unitSize;
    const offsetY = centerY - Math.round(camera.renderpos.y * unitSize) % unitSize;

    ctx.beginPath();
    for (let x = offsetX % unitSize; x < canvas.width; x += unitSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
    }
    for (let y = offsetY % unitSize; y < canvas.height; y += unitSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();
  });
}

// drawMinimap — draws the minimap background/border, then plots myPlayer's
// position within it (scaled by arena size) as a dot, once arena size has
// loaded.
function drawMinimap() {
  minictx.clearRect(0, 0, minimap.width, minimap.height);
  minictx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  minictx.fillRect(0, 0, minimap.width, minimap.height);

  minictx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  minictx.lineWidth = MINIMAP_BORDER_THICKNESS_PX;
  minictx.strokeRect(
    MINIMAP_BORDER_THICKNESS_PX / 2,
    MINIMAP_BORDER_THICKNESS_PX / 2,
    minimap.width - MINIMAP_BORDER_THICKNESS_PX,
    minimap.height - MINIMAP_BORDER_THICKNESS_PX
  );

  if (arenaSize) {
    const relX = (myPlayer.renderPos.x + arenaSize.width / 2) / arenaSize.width;
    const relY = (myPlayer.renderPos.y + arenaSize.height / 2) / arenaSize.height;

    minictx.beginPath();
    minictx.arc(relX * minimap.width, relY * minimap.height, MINIMAP_DOT_RADIUS, 0, Math.PI * 2);
    minictx.fillStyle = MINIMAP_DOT_COLOR;
    minictx.fill();
  }
}