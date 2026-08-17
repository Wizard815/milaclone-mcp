'use strict';

import { state, elMap } from './state.js';
import { api } from './api.js';
import { render, renderCrumbs } from './cards.js';
import { closePalette, closeCtx } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { snapshotForUndo } from './undo.js';
import { confirmDialog } from './confirm.js';

// Selection, inline-edit mode, debounced saves, and deletion.

// Selects exactly `id` (or clears selection if null), replacing whatever
// multi-selection existed before. This is the plain-click path — clicking
// any single card always collapses back down to just that one.
export function select(id) {
  if (state.editingId && state.editingId !== id) exitEdit();
  for (const sid of state.selectedIds) { const e = elMap.get(sid); if (e) e.classList.remove('selected'); }
  state.selectedIds = new Set(id ? [id] : []);
  state.selectedId = id;
  if (id && elMap.get(id)) elMap.get(id).classList.add('selected');
  closePalette();
  closeCtx();
  updateSelectionChrome();
}

export function deselect() { select(null); if (state.editingId) exitEdit(); }

// Ctrl/Cmd+click: adds/removes one card from the current selection without
// touching the rest of it.
export function toggleSelect(id) {
  const el = elMap.get(id);
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
    if (el) el.classList.remove('selected');
    if (state.selectedId === id) {
      const remaining = [...state.selectedIds];
      state.selectedId = remaining.length ? remaining[remaining.length - 1] : null;
    }
  } else {
    state.selectedIds.add(id);
    if (el) el.classList.add('selected');
    state.selectedId = id;
  }
  closePalette();
  closeCtx();
  updateSelectionChrome();
}

// Marquee-select: replaces the selection with `ids`, or adds them to the
// existing one when `additive` (Shift/Ctrl held during the drag).
export function selectMany(ids, additive) {
  if (!additive) {
    for (const sid of state.selectedIds) { const e = elMap.get(sid); if (e) e.classList.remove('selected'); }
    state.selectedIds = new Set();
  }
  for (const id of ids) state.selectedIds.add(id);
  for (const id of state.selectedIds) { const e = elMap.get(id); if (e) e.classList.add('selected'); }
  const all = [...state.selectedIds];
  state.selectedId = all.length ? all[all.length - 1] : null;
  closePalette();
  closeCtx();
  updateSelectionChrome();
}

export function enterEdit(el) {
  if (state.editingId && state.editingId !== el.dataset.id) exitEdit();
  state.editingId = el.dataset.id;
  el.classList.add('editing');
  el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = false; f.tabIndex = 0; });
}

export function exitEdit() {
  if (!state.editingId) return;
  const el = elMap.get(state.editingId);
  if (el) { el.classList.remove('editing'); el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = true; f.tabIndex = -1; f.blur(); }); }
  state.editingId = null;
}

export function renameSelected() {
  if (!state.selectedId) return;
  const el = elMap.get(state.selectedId);
  if (!el || !el.querySelector('[data-edit]')) return;
  enterEdit(el);
  // focus synchronously so keystrokes right after the rename shortcut land in
  // the field instead of falling through to the document
  const f = el.querySelector('[data-edit]');
  if (f) { f.focus(); if (f.select) f.select(); }
}

const saveTimers = new Map();
export function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
  if (it.type === 'board' && patch.icon != null) it._childIcon = patch.icon;
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(it.id, setTimeout(() => {
    api.patch(it.id, { data: patch });
    if (it.type === 'board' && patch.title != null) renderCrumbs();
  }, 400));
}

// trackUndo:false is used for automatic cleanup (e.g. an orphaned connector
// line whose card just got deleted) — not a distinct user action, and its
// fromId/toId would point at an already-gone card anyway if restored alone.
export async function deleteItem(id, { trackUndo = true } = {}) {
  const it = state.view.items.find(x => x.id === id);
  if (it && it.type === 'board' && it.data && it.data.childCanvasId) {
    const label = it._childTitle || it.data.title || 'this board';
    const ok = await confirmDialog(`Delete "${label}" and everything inside it?\n\nYou can undo this with Ctrl+Z.`);
    if (!ok) return;
  }
  if (trackUndo) snapshotForUndo(id);
  await api.remove(id);
  state.view.items = state.view.items.filter(x => x.parentItemId !== id && x.id !== id);
  state.selectedIds.delete(id);
  if (state.selectedId === id) state.selectedId = [...state.selectedIds].pop() || null;
  closeCtx();
  render();
  updateSelectionChrome();
}
