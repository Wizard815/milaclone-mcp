'use strict';

import { state, elMap } from './state.js';
import { api } from './api.js';

// Panels: named background regions that group the cards placed inside them.
// Membership is positional -- a card is "in" a panel when its anchor (its
// horizontal centre, 24px below its top edge) lies inside the panel. This
// mirrors the server's panels.js by hand; keep the two in sync.

const ANCHOR_DROP = 24;
const DEFAULT_W = 480,
  DEFAULT_H = 320;
export const PANEL_SHAPES = ['rect', 'rounded', 'ellipse'];

const area = p => (p.w || DEFAULT_W) * (p.h || DEFAULT_H);

function contains(panel, pt) {
  const w = panel.w || DEFAULT_W,
    h = panel.h || DEFAULT_H;
  if (panel.data.shape === 'ellipse') {
    const rx = w / 2,
      ry = h / 2;
    const dx = (pt.x - (panel.x + rx)) / rx,
      dy = (pt.y - (panel.y + ry)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return pt.x >= panel.x && pt.x <= panel.x + w && pt.y >= panel.y && pt.y <= panel.y + h;
}

export function isMember(panel, it) {
  if (it.id === panel.id || it.type === 'line' || it.parentItemId) return false;
  if (it.type === 'panel' && area(it) >= area(panel)) return false;
  return contains(panel, { x: it.x + (it.w || 240) / 2, y: it.y + ANCHOR_DROP });
}

// Everything inside `panel`, at any nesting depth -- what moves with it.
export function membersOf(panel) {
  return state.view.items.filter(it => isMember(panel, it));
}

// Recomputes each card's direct panel, then updates the badge on every panel
// and the data-panel marker on members. Cheap; called after any move/resize.
export function refreshPanels() {
  const items = state.view.items;
  const panels = items.filter(i => i.type === 'panel').sort((a, b) => area(a) - area(b));
  const counts = new Map(panels.map(p => [p.id, 0]));
  for (const it of items) {
    const p = panels.find(pn => isMember(pn, it));
    it._panelId = p ? p.id : undefined;
    it._panelTitle = p ? p.data.title || 'Panel' : undefined;
    const el = elMap.get(it.id);
    if (el) {
      if (p) el.dataset.panel = p.data.title || 'Panel';
      else delete el.dataset.panel;
    }
    if (p) counts.set(p.id, counts.get(p.id) + 1);
  }
  for (const p of panels) {
    p._memberCount = counts.get(p.id);
    const badge = elMap.get(p.id)?.querySelector('.panel-count');
    if (badge) badge.textContent = p._memberCount + (p._memberCount === 1 ? ' item' : ' items');
  }
}

// Highlights the panel a dragged card would land in (smallest containing one).
export function highlightDropPanel(it, wx, wy) {
  if (it.type === 'panel' || !state.view.items.some(i => i.type === 'panel')) return; // pointermove: stay cheap
  document.querySelectorAll('.panel.drop-target').forEach(e => e.classList.remove('drop-target'));
  const probe = { id: it.id, type: it.type, x: wx, y: wy, w: it.w };
  const p = state.view.items
    .filter(i => i.type === 'panel')
    .sort((a, b) => area(a) - area(b))
    .find(pn => isMember(pn, probe));
  if (p) elMap.get(p.id)?.classList.add('drop-target');
}
export function clearDropPanel() {
  document.querySelectorAll('.panel.drop-target').forEach(e => e.classList.remove('drop-target'));
}

// Free-form resize from the panel's corner handle: independent width/height.
export function startPanelResize(e, it, el) {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX,
    sy = e.clientY,
    sw = it.w || DEFAULT_W,
    sh = it.h || DEFAULT_H;
  el.setPointerCapture(e.pointerId);
  const move = ev => {
    it.w = Math.round(Math.max(120, sw + (ev.clientX - sx) / state.cam.scale));
    it.h = Math.round(Math.max(80, sh + (ev.clientY - sy) / state.cam.scale));
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
  };
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    api.patch(it.id, { w: it.w, h: it.h });
    refreshPanels();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
