'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { isLocked } from './util.js';
import { screenToWorld, cancelCamAnimation } from './viewport.js';
import { select, toggleSelect, enterEdit } from './editing.js';
import { render } from './cards.js';
import { renderLines, pickLineEndpoint } from './lines.js';

// Dragging cards (free-move + in/out of columns) and resizing.

export function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return;
  cancelCamAnimation();
  if (state.armed === 'line') { e.stopPropagation(); pickLineEndpoint(it); return; }
  if (state.armed && state.armed !== 'select') return;
  if (e.target.closest('[data-nodrag]')) { e.stopPropagation(); return; }
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) { e.stopPropagation(); return; }
  e.stopPropagation();

  // Ctrl/Cmd+click only toggles this card in/out of the selection — never
  // starts a drag, so you can build up a multi-selection one click at a
  // time without accidentally moving anything.
  if (e.ctrlKey || e.metaKey) { toggleSelect(it.id); return; }

  // Clicking a card that's already part of a multi-selection keeps the
  // whole group selected (so you can drag it as one unit) instead of
  // collapsing down to just this card — that's what a plain click on an
  // *unselected* card still does.
  const isGroup = state.selectedIds.has(it.id) && state.selectedIds.size > 1;
  if (!isGroup) select(it.id);
  if (isLocked(it)) return;

  if (isGroup) { startGroupDrag(e, it, el); return; }

  // Shapes have no dedicated resize handle (see cards.js) — holding Shift
  // while dragging the shape itself stretches it (independent width/height)
  // instead of moving it. Locked in at drag start so it can't flip mid-drag
  // if Shift is pressed/released partway through.
  const stretching = it.type === 'shape' && e.shiftKey;
  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;
  const rect = el.getBoundingClientRect();
  const startWorld = screenToWorld(rect.left, rect.top);
  const startSize = { w: rect.width, h: rect.height };
  state.drag = { it, el, start, startWorld, fromColumn, moved: false, dropCol: null };
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true; state.drag.moved = true;
      el.classList.add('dragging');
      if (fromColumn) {
        dom.world.appendChild(el);
        el.classList.remove('in-column');
        el.style.width = (it.w || 240) + 'px';
        el.style.zIndex = 99999;
      }
    }
    if (stretching) {
      const w = Math.max(40, startSize.w + dx / state.cam.scale);
      const h = Math.max(40, startSize.h + dy / state.cam.scale);
      el.style.width = w + 'px'; el.style.height = h + 'px';
      it.w = Math.round(w); it.h = Math.round(h);
    } else {
      const wx = startWorld.x + dx / state.cam.scale;
      const wy = startWorld.y + dy / state.cam.scale;
      el.style.left = wx + 'px'; el.style.top = wy + 'px';
      highlightColumn(ev, it);
    }
    renderLines();
  };

  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (!moved) {
      if (it.type !== 'board') maybeEdit(el, ev);
      state.drag = null; return;
    }
    if (stretching) {
      api.patch(it.id, { w: it.w, h: it.h });
      state.drag = null;
    } else {
      finishDrag(ev);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Moves every free-floating (not in a column), unlocked card in the current
// multi-selection by the same delta. Deliberately simpler than the single-
// card drag above: no column drop-target detection — a group only ever
// free-moves, never nests into or out of a column. Persists with one bulk
// PATCH /api/items call instead of one request per card.
function startGroupDrag(e, primaryIt, primaryEl) {
  const members = [...state.selectedIds]
    .map(id => ({ it: state.view.items.find(x => x.id === id), el: elMap.get(id) }))
    .filter(m => m.it && m.el && !m.it.parentItemId && !isLocked(m.it));
  if (!members.length) return;

  const start = { sx: e.clientX, sy: e.clientY };
  members.forEach(m => { m.startX = m.it.x || 0; m.startY = m.it.y || 0; });
  let moved = false;
  primaryEl.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    const wx = dx / state.cam.scale, wy = dy / state.cam.scale;
    members.forEach(m => {
      m.el.style.left = (m.startX + wx) + 'px';
      m.el.style.top = (m.startY + wy) + 'px';
    });
    renderLines();
  };

  const up = async (ev) => {
    primaryEl.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!moved) return;
    const dx = (ev.clientX - start.sx) / state.cam.scale, dy = (ev.clientY - start.sy) / state.cam.scale;
    const updates = members.map(m => {
      m.it.x = Math.round(m.startX + dx);
      m.it.y = Math.round(m.startY + dy);
      return { id: m.it.id, x: m.it.x, y: m.it.y };
    });
    await api.patchMany(updates);
  };

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function maybeEdit(el, ev) {
  if (!el.querySelector('[data-edit]')) return;
  if (!el.classList.contains('editing')) {
    enterEdit(el);
    const f = ev.target.closest('[data-edit]') || el.querySelector('[data-edit]');
    requestAnimationFrame(() => f?.focus());
  }
}

function columnBodyUnder(clientX, clientY, excludeId) {
  const bodies = dom.world.querySelectorAll('.col-body');
  for (const b of bodies) {
    if (b.dataset.colbody === excludeId) continue;
    const r = b.getBoundingClientRect();
    if (clientX >= r.left - 6 && clientX <= r.right + 6 && clientY >= r.top - 6 && clientY <= r.bottom + 30) return b;
  }
  return null;
}

function highlightColumn(ev, it) {
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (it.type === 'column') { state.drag.dropCol = null; return; }
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  state.drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

async function finishDrag(ev) {
  const { it, el } = state.drag;
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (state.drag.dropCol) {
    const order = insertOrder(state.drag.dropCol, ev.clientY, it.id);
    it.parentItemId = state.drag.dropCol;
    it.y = order;
    const sibs = state.view.items.filter(k => k.parentItemId === state.drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => s.y = i);
    await api.patch(it.id, { parentItemId: it.parentItemId, canvasId: state.view.canvas.id });
    await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    render();
  } else {
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = state.drag.fromColumn;
    it.x = wx; it.y = wy; it.parentItemId = null;
    await api.patch(it.id, { x: wx, y: wy, parentItemId: null });
    if (wasChild) render();
  }
  state.drag = null;
}

function insertOrder(colId, clientY, selfId) {
  const rows = [...dom.world.querySelectorAll(`[data-colbody="${colId}"] > .item`)].filter(r => r.dataset.id !== selfId);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

export function startResize(e, it, el) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startW = it.w || el.offsetWidth;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    let w = startW + (ev.clientX - startX) / state.cam.scale;
    w = Math.max(120, Math.min(900, w));
    el.style.width = w + 'px'; it.w = Math.round(w);
    renderLines();
  };
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    api.patch(it.id, { w: it.w });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
