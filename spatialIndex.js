// spatialIndex.js — no dependencies, works on plain AABB objects, usable by client AND server
function buildIndexByMinX(items, getAABB) {
  return items
    .map((item, i) => ({ i, ...getAABB(item) }))
    .sort((a, b) => a.minX - b.minX);
}

function findInsertionIndex(sortedByMinX, x) {
  let lo = 0, hi = sortedByMinX.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedByMinX[mid].minX < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function queryAABB(sortedByMinX, viewMinX, viewMaxX, viewMinY, viewMaxY) {
  const insertAt = findInsertionIndex(sortedByMinX, viewMinX);
  const hits = [];
  for (let k = insertAt; k < sortedByMinX.length; k++) {
    const c = sortedByMinX[k];
    if (c.minX > viewMaxX) break;
    hits.push(c);
  }
  for (let k = insertAt - 1; k >= 0; k--) {
    const c = sortedByMinX[k];
    if (c.maxX < viewMinX) break;
    hits.push(c);
  }
  return hits.filter(c => c.minY <= viewMaxY && c.maxY >= viewMinY);
}