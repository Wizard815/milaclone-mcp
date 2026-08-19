'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { refreshIcons, toast } from './util.js';
import { loadCam, applyCamAnimated, initViewport } from './viewport.js';
import { render, renderCrumbs } from './cards.js';
import { deselect, renameSelected, deleteItem, exitEdit } from './editing.js';
import { closePalette, closeCtx } from './menus.js';
import { copySelected, pasteClipboard, duplicateSelected } from './clipboard.js';
import { arm, disarm, initTools } from './tools.js';
import { initMobile, updateMobileChrome } from './mobile.js';
import { initBoardChrome, updateSelectionChrome } from './boardchrome.js';
import { initQuickNotes, isQuickNotesOpen } from './quicknotes.js';
import { initDocs, isDocumentOpen } from './docs.js';
import { initDrawEditor, isDrawEditorOpen } from './draw-editor.js';
import { initTheme } from './theme.js';
import { performUndo, performRedo } from './undo.js';
import { initMindMap, isMindMapOpen } from './mindmap.js';
import { initConfirmDialog, isConfirmOpen } from './confirm.js';
import { initSettings } from './settings.js';
import { initConnectPicker, isConnectPickerOpen } from './connect.js';
import { initCalendar, isCalendarOpen } from './calendar.js';

// Entry point: canvas loading/navigation, global keyboard + pointer handling,
// and boot. Wiring for the viewport and toolbar lives in their own modules and
// is activated here.

// "Last Page" (topbar button) always jumps to wherever you were immediately
// before the board you're on now -- one level of back, not a full history
// stack. Recorded here, before state.view is overwritten, so it's always
// the board being *left*, not the one being entered; skips same-board
// navigation (e.g. a hash update that doesn't actually change boards) so it
// never points at itself.
export async function openCanvas(id) {
  const prevId = state.view.canvas ? state.view.canvas.id : null;
  if (prevId && prevId !== id) localStorage.setItem('lastCanvasId', prevId);
  state.view = await api.canvas(id);
  if (state.view.error) { if (id !== state.rootCanvasId) return openCanvas(state.rootCanvasId); toast('Board not found'); return; }
  state.cam = loadCam(id);
  state.selectedId = null; state.selectedIds = new Set(); state.editingId = null;
  closeCtx();
  renderCrumbs();
  updateMobileChrome();
  updateSelectionChrome();
  render();
  applyCamAnimated();
  if (location.hash.slice(1) !== id) { history.replaceState(null, '', '#' + id); }
}

document.addEventListener('keydown', (e) => {
  if (isQuickNotesOpen()) return;   // Quick notes owns the keyboard while it's up
  if (isDocumentOpen()) return;     // Document editor owns the keyboard while it's up (handles its own Escape)
  if (isDrawEditorOpen()) return;   // Draw editor owns the keyboard while it's up (handles its own Escape/undo)
  if (isMindMapOpen()) return;      // Mind map owns the keyboard while it's up (handles its own Escape)
  if (isConfirmOpen()) return;      // Confirm dialog owns the keyboard while it's up (handles its own Escape/Enter)
  if (isConnectPickerOpen()) return; // Connect picker owns the keyboard while it's up (handles its own Escape)
  if (isCalendarOpen()) return;      // Calendar owns the keyboard while it's up (handles its own Escape)
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly));
  if (e.key === 'Escape') { disarm(); deselect(); closePalette(); closeCtx(); }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(false); return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); copySelected(true); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); performUndo(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); performRedo(); return; }
  if (e.key === 'Enter' && state.selectedId && !mod) { e.preventDefault(); renameSelected(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); deleteItem(state.selectedId); }
  const map = { v: 'select', n: 'note', l: 'link', t: 'todo', b: 'board', c: 'column', m: 'comment', h: 'heading', d: 'draw' };
  if (map[e.key.toLowerCase()] && !mod) {
    const btn = document.querySelector(`.tool[data-tool="${map[e.key.toLowerCase()]}"]`);
    if (btn) arm(map[e.key.toLowerCase()], btn);
  }
});

document.addEventListener('pointerdown', (e) => {
  if (isQuickNotesOpen()) return;
  if (isConfirmOpen()) return;
  if (!e.target.closest('#palette') && !e.target.closest('.swatch')) closePalette();
  if (!e.target.closest('#ctxmenu') && !e.target.closest('.item')) closeCtx();
  if (state.editingId && !e.target.closest('.item')) exitEdit();
}, true);

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && (!state.view.canvas || id !== state.view.canvas.id)) openCanvas(id);
});

document.getElementById('lastPageBtn').onclick = () => {
  const id = localStorage.getItem('lastCanvasId');
  if (!id) { toast('No previous board yet'); return; }
  openCanvas(id);
};

initViewport();
initMobile();
initBoardChrome();
initQuickNotes();
initDocs();
initDrawEditor();
initTools();
initTheme();
initMindMap();
initConfirmDialog();
initSettings();
initConnectPicker();
initCalendar();

(async function boot() {
  refreshIcons();
  const r = await api.root();
  state.rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || state.rootCanvasId;
  await openCanvas(startId);
})();
