'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render } from './cards.js';

// Undo/redo for deletions. A lone board card deletes via a server-side
// soft-delete of its whole nested subtree (see routes.js), keyed by the
// board item's own id — undo for that case is just asking the server to
// restore that id, since nothing needs to round-trip through the client.
// Everything else (cards, columns-with-children, lines) round-trips through
// a plain snapshot-then-recreate, since the server always mints a fresh id
// on create and there's no "undelete" for non-board rows. A subtree that
// merely *contains* a board (e.g. a column with a board card nested inside
// it) still can't be undone as a whole — that mixed case is skipped with a
// warning, same as before.

const MAX_STACK = 20;

// Called by deleteItem() right before it removes `id`.
export function snapshotForUndo(id) {
  const it = state.view.items.find(x => x.id === id);
  if (!it) return;
  if (it.type === 'board' && it.data && it.data.childCanvasId) {
    state.undoStack.push({ restoreBoardId: id });
    if (state.undoStack.length > MAX_STACK) state.undoStack.shift();
    state.redoStack.length = 0;
    return;
  }
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
  if (entry.restoreBoardId) {
    const restored = await api.restore(entry.restoreBoardId);
    if (!restored || restored.error) { toast('Could not undo'); return; }
    state.view.items.push(restored);
    state.redoStack.push({ items: [restored.id] });
    render();
    toast('Undone');
    return;
  }
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

  // A restored board redone back to "deleted": re-run the same soft-delete
  // the server does for any board, so a further undo restores the whole
  // nested subtree again instead of recreating an empty board via the
  // generic path below (which would mint a fresh, empty child canvas).
  if (live.length === 1 && live[0].type === 'board' && live[0].data && live[0].data.childCanvasId) {
    const boardId = live[0].id;
    await api.remove(boardId);
    state.view.items = state.view.items.filter(it => it.id !== boardId && it.parentItemId !== boardId);
    state.undoStack.push({ restoreBoardId: boardId });
    render();
    toast('Redone');
    return;
  }

  const snapshot = live.map(it => JSON.parse(JSON.stringify(it)));
  const roots = live.filter(it => !it.parentItemId || !idSet.has(it.parentItemId));
  for (const root of roots) await api.remove(root.id);
  state.view.items = state.view.items.filter(it => !idSet.has(it.id));
  state.undoStack.push({ items: snapshot });
  render();
  toast('Redone');
}
