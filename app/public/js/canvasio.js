'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render } from './cards.js';
import { select } from './editing.js';
import { screenToWorld } from './viewport.js';

// JSON Canvas (.canvas, the open format Obsidian reads) export and import,
// from the topbar's Export button. The conversion itself is server-side
// (canvasfile.js); this module is the menu, the download and the file pick.

function slug(s) {
  return String(s || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'board';
}

async function exportBoard(nested) {
  const canvas = state.view.canvas;
  if (!canvas) return;
  const doc = await api.exportCanvas(canvas.id, nested);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slug(canvas.title) + '.canvas';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${doc.nodes.length} cards and ${doc.edges.length} arrows`);
}

async function importFile(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (e) { toast('That file is not JSON'); return; }
  const w = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const title = file.name.replace(/\.(canvas|json)$/i, '') || 'Imported board';
  const { ok, body } = await api.importCanvas(state.view.canvas.id, { canvas: doc, title, x: Math.round(w.x - 120), y: Math.round(w.y - 60) });
  if (!ok) { toast(body.error || 'Import failed'); return; }
  state.view.items.push(body);
  render();
  select(body.id);
  toast(`Imported "${body._childTitle}"`);
}

function openMenu(btn) {
  const menu = dom.ctxmenu;
  menu.innerHTML = '';
  const add = (label, act, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ctx-item'; b.dataset.act = act;
    const s = document.createElement('span'); s.textContent = label; b.appendChild(s);
    b.onclick = () => { menu.classList.remove('open'); menu.innerHTML = ''; fn(); };
    menu.appendChild(b);
  };
  add('Export board as JSON Canvas', 'export', () => exportBoard(false));
  add('Export with nested boards', 'export-nested', () => exportBoard(true));
  const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep);
  add('Import a .canvas file…', 'import', () => document.getElementById('canvasInput').click());
  menu.classList.add('open');
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
}

export function initCanvasIO() {
  const btn = document.getElementById('exportBtn');
  btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(btn); });
  const input = document.getElementById('canvasInput');
  input.addEventListener('change', () => {
    const f = input.files[0]; input.value = '';
    if (f) importFile(f).catch(() => toast('Import failed'));
  });
}
