// spatialIndex.js
// Shared, dependency-free spatial indexing over plain AABB objects. Builds a
// min-X-sorted index for a list of items and answers "which items overlap
// this view rectangle" queries against it via binary search plus a linear
// scan. Usable by both the client and the server.

// buildIndexByMinX — builds a spatial index over `items` by computing each
// item's AABB (via getAABB) and sorting the resulting list ascending by
// minX. Returns an array of { i, minX, maxX, minY, maxY } entries, where i
// is the original index into `items`.
function buildIndexByMinX(items, getAABB) {
  return items
    .map((item, i) => ({ i, ...getAABB(item) }))
    .sort((a, b) => a.minX - b.minX);
}

// findInsertionIndex — binary searches a min-X-sorted index for the index of
// the first entry whose minX is >= x. Used internally by queryAABB to locate
// the starting point for its outward scan.
function findInsertionIndex(sortedByMinX, x) {
  let lo = 0, hi = sortedByMinX.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedByMinX[mid].minX < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// queryAABB — returns every entry in a min-X-sorted index whose AABB
// overlaps the given view rectangle (viewMinX..viewMaxX, viewMinY..viewMaxY).
// Binary searches to the insertion point for viewMinX, then scans outward in
// both directions while minX stays in range, filtering the result by Y
// overlap.
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