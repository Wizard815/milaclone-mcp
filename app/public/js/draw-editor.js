'use strict';

import { api } from './api.js';
import { toast, refreshIcons } from './util.js';
import { refreshItem } from './cards.js';

// Full-page drawing editor. Mirrors docs.js: a card on the board is just a
// tile; opening it swaps in this overlay. Edits are local to a draft copy of
// the item's strokes and only committed to the server on Save — Cancel just
// throws the draft away.

const SVG_NS = 'http://www.w3.org/2000/svg';

let doc = null;         // the item currently open, or null
let draft = null;       // { title, strokes } — working copy
let el = null;          // cached DOM refs
let tool = 'pen';
let color = '#565d6b';
let width = 3;
let selected = null;    // the selected stroke object (select tool), or null
let history = [];
let hIndex = -1;

function refs() {
  if (el) return el;
  el = {
    root: document.getElementById('drawEditor'),
    cancel: document.getElementById('dwCancel'),
    save: document.getElementById('dwSave'),
    title: document.getElementById('dwTitle'),
    toolbar: document.getElementById('dwToolbar'),
    undo: document.getElementById('dwUndo'),
    redo: document.getElementById('dwRedo'),
    color: document.getElementById('dwColor'),
    width: document.getElementById('dwWidth'),
    svg: document.getElementById('dwSvg')
  };
  return el;
}

export function isDrawEditorOpen() { return !!doc; }

function pointsToPath(points) {
  return points.length ? 'M' + points.map(p => p[0] + ',' + p[1]).join(' L') : '';
}

function toLocal(e) {
  const rect = refs().svg.getBoundingClientRect();
  return [Math.round(e.clientX - rect.left), Math.round(e.clientY - rect.top)];
}

function pushHistory() {
  history = history.slice(0, hIndex + 1);
  history.push(JSON.parse(JSON.stringify(draft.strokes)));
  hIndex = history.length - 1;
}

function setTool(next) {
  tool = next;
  const r = refs();
  r.svg.classList.remove('tool-pen', 'tool-select', 'tool-eraser');
  r.svg.classList.add('tool-' + tool);
  r.toolbar.querySelectorAll('.dw-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'select') { selected = null; }
  renderStrokes();
}

function renderStrokes() {
  const r = refs();
  r.svg.innerHTML = '';
  draft.strokes.forEach((s) => {
    const dx = s._dx || 0, dy = s._dy || 0;
    const pts = dx || dy ? s.points.map(p => [p[0] + dx, p[1] + dy]) : s.points;
    const d = pointsToPath(pts);
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'dw-hit');
    hit.setAttribute('stroke-width', Math.max((s.width || 3) + 14, 18));
    const vis = document.createElementNS(SVG_NS, 'path');
    vis.setAttribute('d', d);
    vis.setAttribute('class', 'dw-stroke' + (s === selected ? ' selected' : ''));
    vis.setAttribute('stroke', s.color || '#565d6b');
    vis.setAttribute('stroke-width', s.width || 3);
    r.svg.appendChild(hit);
    r.svg.appendChild(vis);
    hit.addEventListener('pointerdown', (e) => {
      if (tool === 'select') { e.stopPropagation(); startMove(e, s); }
      else if (tool === 'eraser') { e.stopPropagation(); eraseStroke(s); erasedInDrag = true; }
    });
  });
}

function startMove(e, stroke) {
  selected = stroke;
  renderStrokes();
  const start = toLocal(e);
  let moved = false;
  const move = (ev) => {
    const now = toLocal(ev);
    const dx = now[0] - start[0], dy = now[1] - start[1];
    if (Math.hypot(dx, dy) > 1) moved = true;
    stroke._dx = dx; stroke._dy = dy;
    renderStrokes();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) {
      const dx = stroke._dx || 0, dy = stroke._dy || 0;
      stroke.points = stroke.points.map(p => [p[0] + dx, p[1] + dy]);
      delete stroke._dx; delete stroke._dy;
      pushHistory();
    } else {
      delete stroke._dx; delete stroke._dy;
    }
    renderStrokes();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function eraseStroke(stroke) {
  const idx = draft.strokes.indexOf(stroke);
  if (idx === -1) return;
  draft.strokes.splice(idx, 1);
  if (selected === stroke) selected = null;
  renderStrokes();
}

let current = null, currentPath = null;
let erasedInDrag = false;

function wireSurface() {
  const r = refs();
  r.svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (tool === 'pen') {
      current = { points: [toLocal(e)], color, width };
      currentPath = document.createElementNS(SVG_NS, 'path');
      currentPath.setAttribute('class', 'dw-stroke');
      currentPath.setAttribute('stroke', color);
      currentPath.setAttribute('stroke-width', width);
      r.svg.appendChild(currentPath);
      r.svg.setPointerCapture(e.pointerId);
    } else if (tool === 'select') {
      selected = null;
      renderStrokes();
    } else if (tool === 'eraser') {
      erasedInDrag = false;
      r.svg.setPointerCapture(e.pointerId);
    }
  });
  r.svg.addEventListener('pointermove', (e) => {
    if (tool === 'pen' && current) {
      current.points.push(toLocal(e));
      currentPath.setAttribute('d', pointsToPath(current.points));
    } else if (tool === 'eraser' && e.buttons === 1) {
      const hitEl = document.elementFromPoint(e.clientX, e.clientY);
      // matched by geometry only (not identity) since renderStrokes() rebuilds
      // fresh path elements on every erase — find the stroke under the point.
      if (hitEl && hitEl.classList.contains('dw-hit')) {
        const idx = [...r.svg.querySelectorAll('.dw-hit')].indexOf(hitEl);
        if (idx !== -1 && draft.strokes[idx]) { eraseStroke(draft.strokes[idx]); erasedInDrag = true; }
      }
    }
  });
  const finishPen = () => {
    if (!current) return;
    if (current.points.length > 1) { draft.strokes.push(current); pushHistory(); }
    else if (currentPath) { currentPath.remove(); }
    current = null; currentPath = null;
  };
  r.svg.addEventListener('pointerup', () => {
    finishPen();
    if (tool === 'eraser' && erasedInDrag) { pushHistory(); erasedInDrag = false; }
  });
  r.svg.addEventListener('pointercancel', finishPen);
}

export function openDrawEditor(it) {
  doc = it;
  draft = { title: it.data.title || '', strokes: JSON.parse(JSON.stringify(it.data.strokes || [])) };
  selected = null;
  history = [JSON.parse(JSON.stringify(draft.strokes))];
  hIndex = 0;
  const r = refs();
  r.root.hidden = false;
  r.title.value = draft.title;
  r.color.value = color;
  r.width.value = width;
  setTool('pen');
  refreshIcons(r.root);
}

function closeEditor() {
  refs().root.hidden = true;
  doc = null; draft = null; selected = null;
  history = []; hIndex = -1;
}

async function save() {
  if (!doc) return;
  const r = refs();
  const title = r.title.value.trim();
  const strokes = draft.strokes.map(s => ({ points: s.points, color: s.color, width: s.width }));
  Object.assign(doc.data, { title, strokes });
  await api.patch(doc.id, { data: { title, strokes } });
  toast('Drawing saved');
  closeEditor();
  refreshItem(doc); // re-render the tile — title may have changed
}

export function initDrawEditor() {
  const r = refs();
  wireSurface();
  r.cancel.addEventListener('click', closeEditor);
  r.save.addEventListener('click', save);
  r.toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.dw-tool');
    if (btn) setTool(btn.dataset.tool);
  });
  r.undo.addEventListener('click', () => {
    if (hIndex <= 0) return;
    hIndex--; draft.strokes = JSON.parse(JSON.stringify(history[hIndex])); selected = null; renderStrokes();
  });
  r.redo.addEventListener('click', () => {
    if (hIndex >= history.length - 1) return;
    hIndex++; draft.strokes = JSON.parse(JSON.stringify(history[hIndex])); selected = null; renderStrokes();
  });
  r.color.addEventListener('input', () => { color = r.color.value; });
  r.width.addEventListener('input', () => { width = parseInt(r.width.value, 10); });
  document.addEventListener('keydown', (e) => {
    if (!doc) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); r.undo.click(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); r.redo.click(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && document.activeElement !== r.title) {
      e.preventDefault();
      eraseStroke(selected);
      pushHistory();
    }
  });
}
