'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { exportBoard, pickCanvasFile } from './canvasio.js';

// The topbar Export menu: this board as Markdown (re-importable with
// scripts/import-milanote-md.js) or as a JSON Canvas file (canvasio.js), a
// .canvas import, or a backup of the whole database.

const el = id => document.getElementById(id);
export const boardMarkdownUrl = () =>
  `/api/canvas/${state.view.canvas.id}/export.md?origin=${encodeURIComponent(location.origin)}`;

// Downloads go through fetch (so they carry the API key when the server has
// one) and a blob link: an error answer shows a toast instead of being saved
// as a file, and nothing navigates (which inside an embedding iframe would
// replace the app).
export async function download(url, fallbackName = 'download') {
  const f = await api.file(url);
  if (!f) return toast('Download failed');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f.blob);
  a.download = f.name || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function close() {
  el('exportMenu').hidden = true;
  el('exportBtn').setAttribute('aria-expanded', 'false');
}

export function initExport() {
  const btn = el('exportBtn');
  const menu = el('exportMenu');
  btn.onclick = () => {
    if (!menu.hidden) return close();
    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.right = window.innerWidth - r.right + 'px';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  el('exportMd').onclick = () => download(boardMarkdownUrl(), 'board.md');
  el('exportCanvas').onclick = () => exportBoard(false);
  el('exportCanvasNested').onclick = () => exportBoard(true);
  el('importCanvas').onclick = () => pickCanvasFile();
  el('exportBackup').onclick = () => download('/api/backup', 'milaclone.db');
  menu.addEventListener('click', close); // an entry was picked
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !e.target.closest('#exportMenu, #exportBtn')) close();
  });
}
