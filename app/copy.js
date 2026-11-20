'use strict';

// Deep-copy of cards and boards, used by duplicate and the template system.
// Everything is remapped to fresh ids: parentItemId (cards in a column), line
// ends, and nested boards (each gets its own new child canvas, recursively).

const { db, stmt, id, rowToItem } = require('./db');

const BOARD_FALLBACK_ICON = 'layout-grid';

// Copies one card (and what hangs off it) onto `canvasId`. `map` collects
// old id -> new id. Returns the new item.
function copyItem(src, canvasId, { x, y, parentItemId = null, map = new Map(), withLines = false } = {}) {
  const now = Date.now();
  const nid = id('i_');
  map.set(src.id, nid);
  let data = JSON.parse(JSON.stringify(src.data || {}));
  if (src.type === 'board' && data.childCanvasId) {
    const child = stmt.getCanvas.get(data.childCanvasId);
    const cid = id('c_');
    stmt.insertCanvas.run({
      id: cid, title: child ? child.title : 'Board', parentCanvasId: canvasId,
      color: child ? child.color : 'slate', icon: child ? child.icon : null, createdAt: now
    });
    copyCanvasContents(data.childCanvasId, cid, map);
    data = { childCanvasId: cid };
  }
  const copy = {
    id: nid, canvasId, parentItemId, type: src.type,
    x: Math.round(x ?? src.x), y: Math.round(y ?? src.y), w: src.w, h: src.h ?? null,
    z: src.type === 'panel' ? 0 : Math.max(0, stmt.maxZ.get().m || 0) + 1,
    color: src.color ?? null, data: JSON.stringify(data), stage: src.stage || null, createdAt: now
  };
  stmt.insertItem.run(copy);
  // cards inside a column
  for (const child of stmt.itemsByParent.all(src.id).map(rowToItem)) {
    copyItem(child, canvasId, { x: child.x, y: child.y, parentItemId: nid, map });
  }
  return nid;
}

// Copies every card on `srcCanvas` into `dstCanvas`, keeping layout, panels,
// columns and the lines between cards that were both copied.
function copyCanvasContents(srcCanvasId, dstCanvasId, map = new Map()) {
  const items = stmt.itemsForCanvas.all(srcCanvasId).map(rowToItem);
  for (const it of items) {
    if (it.parentItemId || it.type === 'line') continue; // columns bring their children; lines go last
    copyItem(it, dstCanvasId, { map });
  }
  for (const it of items.filter(i => i.type === 'line')) {
    const from = map.get(it.data.fromId), to = map.get(it.data.toId);
    if (!from || !to) continue; // a line whose end wasn't copied would dangle
    copyItem({ ...it, data: { ...it.data, fromId: from, toId: to } }, dstCanvasId, { map });
  }
  return map;
}

module.exports = { copyItem, copyCanvasContents, db, BOARD_FALLBACK_ICON };
