'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render } from './cards.js';
import { reloadView } from './main.js';

// Undo/redo (Ctrl+Z / Ctrl+Y or shift+Ctrl+Z). Two kinds of entry:
//
// - `{ restoreIds }` — one delete action. Deleting moves cards to the
//   server-side trash (with everything inside them: column cards, a board's
//   whole nested board, attached lines), so undo just restores those ids and
//   redo trashes them again. The same entry backs the "Moved to trash" toast's
//   Undo button.
// - `{ taskEdit }` — deleting a task row inside a to-do card. Tasks live in the
//   card's data.tasks array, not as their own items, so the whole array is
//   snapshotted before the change and undo/redo swap it back.

const MAX_STACK = 20;

export function pushUndo(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > MAX_STACK) state.undoStack.shift();
  state.redoStack.length = 0;
  return entry;
}

export function snapshotTaskEdit(it, prevTasks) {
  pushUndo({ taskEdit: { itemId: it.id, tasks: JSON.parse(JSON.stringify(prevTasks)) } });
}

// The Trash sheet restored or purged it: undo/redo must not try again.
// No id = everything (the trash was emptied).
export function forgetUndoFor(id) {
  for (const stack of [state.undoStack, state.redoStack]) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const ids = stack[i].restoreIds || stack[i].trashIds;
      if (!ids) continue;
      if (id === undefined) ids.length = 0;
      else if (ids.includes(id)) ids.splice(ids.indexOf(id), 1);
      if (!ids.length) stack.splice(i, 1);
    }
  }
}

async function restoreAll(ids) {
  const restored = await Promise.all(ids.map(id => api.restore(id)));
  if (!restored.some(Boolean)) return false;
  await reloadView();
  return true;
}

async function trashAll(ids) {
  await Promise.all(ids.map(id => api.remove(id)));
  await reloadView();
}

async function swapTasks(entry, done) {
  const { itemId, tasks } = entry.taskEdit;
  const it = state.view.items.find(x => x.id === itemId);
  if (!it) return null;
  const other = JSON.parse(JSON.stringify(it.data.tasks || []));
  it.data.tasks = JSON.parse(JSON.stringify(tasks));
  await api.patch(itemId, { data: { tasks: it.data.tasks } });
  render();
  toast(done);
  return { taskEdit: { itemId, tasks: other } };
}

async function undo(entry) {
  if (entry.taskEdit) {
    const back = await swapTasks(entry, 'Undone');
    if (!back) return toast('Could not undo');
    state.redoStack.push(back);
    return;
  }
  if (!entry.restoreIds.length) return; // all of it was restored or purged from the Trash sheet
  if (!(await restoreAll(entry.restoreIds))) return;
  state.redoStack.push({ trashIds: [...entry.restoreIds] });
  toast('Restored');
}

export async function performUndo() {
  const entry = state.undoStack.pop();
  if (!entry) return toast('Nothing to undo');
  await undo(entry);
}

// The toast's Undo button: undoes that particular delete, if it's still on the stack.
export async function undoEntry(entry) {
  const i = state.undoStack.indexOf(entry);
  if (i === -1) return; // already undone
  state.undoStack.splice(i, 1);
  await undo(entry);
}

export async function performRedo() {
  const entry = state.redoStack.pop();
  if (!entry) return toast('Nothing to redo');
  if (entry.taskEdit) {
    const back = await swapTasks(entry, 'Redone');
    if (!back) return toast('Nothing to redo');
    state.undoStack.push(back);
    return;
  }
  await trashAll(entry.trashIds);
  state.undoStack.push({ restoreIds: [...entry.trashIds] });
  toast('Moved to trash');
}
