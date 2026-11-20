'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { render } from './cards.js';
import { select } from './editing.js';
import { screenToWorld } from './viewport.js';

// JSON Canvas (.canvas, the open format Obsidian reads) export and import,
// from the topbar's Export button. The conversion itself is server-side
// (canvasfile.js); this module is the menu, the download and the file pick.

function slug(s) {
  return (
    String(s || 'board')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'board'
  );
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
  try {
    doc = JSON.parse(await file.text());
  } catch {
    toast('That file is not JSON');
    return;
  }
  const w = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const title = file.name.replace(/\.(canvas|json)$/i, '') || 'Imported board';
  const { ok, body } = await api.importCanvas(state.view.canvas.id, {
    canvas: doc,
    title,
    x: Math.round(w.x - 120),
    y: Math.round(w.y - 60),
  });
  if (!ok) {
    toast(body.error || 'Import failed');
    return;
  }
  state.view.items.push(body);
  render();
  select(body.id);
  toast(`Imported "${body._childTitle}"`);
}

// Wired from the topbar Export menu (index.html #exportCanvas / #exportCanvasNested / #importCanvas).
export function initCanvasIO() {
  const el = id => document.getElementById(id);
  el('exportCanvas').onclick = () => exportBoard(false);
  el('exportCanvasNested').onclick = () => exportBoard(true);
  el('importCanvas').onclick = () => el('canvasInput').click();
  const input = el('canvasInput');
  input.addEventListener('change', () => {
    const f = input.files[0];
    input.value = '';
    if (f) importFile(f).catch(() => toast('Import failed'));
  });
}
