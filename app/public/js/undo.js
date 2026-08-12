'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render } from './cards.js';

// Undo/redo for deletions. Board deletions are excluded entirely (a board
// owns an entire nested canvas subtree that isn't loaded client-side, so
// there's nothing here to snapshot/restore) — everything else (cards,
// columns-with-children, lines) round-trips through a plain
// snapshot-then-recreate, since the server always mints a fresh id on
// create and there's no "undelete" endpoint.

const MAX_STACK = 20;

// Called by deleteItem() right before it removes `id`. Skips tracking (and
// warns) if the subtree includes a board, which can't be restored.
export function snapshotForUndo(id) {
  const it = state.view.items.find(x => x.id === id);
  if (!it) return;
  const children = state.view.items.filter(x => x.parentItemId === id);
  const items = [it, ...children];
  if (items.some(x => x.type === 'board')) {
    toast('Board deleted — nested content can\'t be undone');
    return;
  }
  const snapshot = items.map(x => JSON.parse(JSON.stringify(x)));
  state.undoStack.push({ items: snapshot });
  if (state.undoStack.length > MAX_STACK) state.undoStack.shift();
  state.redoStack.length = 0;
}

function remapData(type, data, idMap) {
  if (type === 'line') {
    return Object.assign({}, data, {
      fromId: idMap.get(data.fromId) || data.fromId,
      toId: idMap.get(data.toId) || data.toId
    });
  }
  return data;
}

// Parents (no parentItemId within this batch) must be created before their
// children so the recreated child can point at the new parent id.
async function recreate(items) {
  const idsInBatch = new Set(items.map(x => x.id));
  const ordered = [...items].sort((a, b) => {
    const aChild = a.parentItemId && idsInBatch.has(a.parentItemId) ? 1 : 0;
    const bChild = b.parentItemId && idsInBatch.has(b.parentItemId) ? 1 : 0;
    return aChild - bChild;
  });
  const idMap = new Map();
  const created = [];
  for (const snap of ordered) {
    const parentItemId = snap.parentItemId && idsInBatch.has(snap.parentItemId)
      ? idMap.get(snap.parentItemId) || null
      : null;
    const body = {
      canvasId: state.view.canvas.id,
      type: snap.type,
      x: snap.x, y: snap.y, w: snap.w,
      color: snap.color,
      data: remapData(snap.type, snap.data, idMap),
      parentItemId
    };
    const it = await api.create(body);
    idMap.set(snap.id, it.id);
    created.push(it);
  }
  state.view.items.push(...created);
  return created;
}

export async function performUndo() {
  const entry = state.undoStack.pop();
  if (!entry) { toast('Nothing to undo'); return; }
  const created = await recreate(entry.items);
  state.redoStack.push({ items: created.map(it => it.id) });
  render();
  toast('Undone');
}

export async function performRedo() {
  const entry = state.redoStack.pop();
  if (!entry) { toast('Nothing to redo'); return; }
  const idSet = new Set(entry.items);
  const live = entry.items.map(id => state.view.items.find(it => it.id === id)).filter(Boolean);
  if (!live.length) { toast('Nothing to redo'); return; }
  const snapshot = live.map(it => JSON.parse(JSON.stringify(it)));
  const roots = live.filter(it => !it.parentItemId || !idSet.has(it.parentItemId));
  for (const root of roots) await api.remove(root.id);
  state.view.items = state.view.items.filter(it => !idSet.has(it.id));
  state.undoStack.push({ items: snapshot });
  render();
  toast('Redone');
}
