'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { colorVar, toast, lucideEl, refreshIcons } from './util.js';
import { select, deleteItem, saveData } from './editing.js';
import { disarm } from './tools.js';
import { screenToWorld } from './viewport.js';


// Connector lines between two cards. Unlike every other item type, a line
// has no box of its own on the canvas — it's just a fromId/toId pair drawn
// into an SVG layer that lives inside #world so it inherits the same
// pan/zoom transform as everything else, no extra math required.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Reused across calls rather than recreated, since renderLines() runs on
// every drag/resize tick (not just on a full render()) — recreating it each
// time would pile up stale detached-looking duplicates as the drag proceeds.
// Appended last (and z-indexed above cards in CSS) so connectors read as
// free-floating over the board instead of tucked behind every card.
function ensureLayer() {
  let svg = document.getElementById('linesLayer');
  if (!svg || svg.parentNode !== dom.world) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'linesLayer';
    dom.world.appendChild(svg);
  }
  svg.innerHTML = '';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  return { svg, defs };
}

// Label pills are plain HTML (easier to make editable than SVG <text>), so
// they live as siblings of the SVG layer rather than inside it. Tracked here
// so a mid-drag renderLines() call can clear the previous batch instead of
// piling up duplicates the same way the old ensureLayer() bug did for paths.
let labelEls = [];
function clearLabels() { labelEls.forEach(el => el.remove()); labelEls = []; }

// Markers can't reference a CSS var per-instance, so each line gets its own
// arrowhead def sized to its own color instead of sharing one global marker.
function addArrowMarker(defs, id, color) {
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
  path.setAttribute('fill', color);
  marker.appendChild(path);
  defs.appendChild(marker);
}

// Reads the *live* DOM position rather than it.x/it.y so a line dragged
// mid-move (which only updates el.style.left/top until the drag finishes)
// still tracks the card instead of snapping into place after the drop.
function rectOf(id) {
  const el = elMap.get(id);
  if (!el) return null;
  if (el.style.left) {
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    const w = el.offsetWidth, h = el.offsetHeight;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  }
  // Column children never get an inline left/top (they're positioned by
  // normal document flow inside the column body, not absolute placement --
  // see renderItem in cards.js) -- without this fallback, a line to/from a
  // card in a column silently anchored at world (0,0) instead of the card's
  // actual position, whether the line was drawn to it directly or it was
  // dragged into a column after the line already existed. Read the real
  // rendered screen rect and convert to world space instead.
  const r = el.getBoundingClientRect();
  const topLeft = screenToWorld(r.left, r.top);
  const w = r.width / state.cam.scale, h = r.height / state.cam.scale;
  return { x: topLeft.x, y: topLeft.y, w, h, cx: topLeft.x + w / 2, cy: topLeft.y + h / 2 };
}

// Where a ray from the rect's center toward (tx,ty) exits the rectangle.
function edgePoint(rect, tx, ty) {
  const dx = tx - rect.cx, dy = ty - rect.cy;
  if (!dx && !dy) return { x: rect.cx, y: rect.cy };
  const hw = rect.w / 2, hh = rect.h / 2;
  const scale = Math.min(dx ? Math.abs(hw / dx) : Infinity, dy ? Math.abs(hh / dy) : Infinity);
  return { x: rect.cx + dx * scale, y: rect.cy + dy * scale };
}

// Direct connection: the dot (and the line itself) sits right on the card
// edge, no offset — this used to sit a fixed gap outside the card, bridged
// by a separate dashed stub, but that read as a gap in the connection
// rather than a direct one.
function attachPoint(rect, tx, ty) {
  const edge = edgePoint(rect, tx, ty);
  return { edge, dot: edge };
}

export function renderLines() {
  const { svg: layer, defs } = ensureLayer();
  clearLabels();
  const lines = state.view.items.filter(it => it.type === 'line');
  for (const line of lines) {
    const fromRect = elMap.has(line.data.fromId) && rectOf(line.data.fromId);
    const toRect = elMap.has(line.data.toId) && rectOf(line.data.toId);
    if (!fromRect || !toRect) {
      // Endpoint no longer exists on this board (deleted card) — the line
      // is meaningless now, so clean it up rather than leaving it stuck.
      deleteItem(line.id, { trackUndo: false });
      continue;
    }
    const fromAttach = attachPoint(fromRect, toRect.cx, toRect.cy);
    const toAttach = attachPoint(toRect, fromRect.cx, fromRect.cy);
    const from = fromAttach.dot, to = toAttach.dot;
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const ddx = to.x - from.x, ddy = to.y - from.y;
    const len = Math.hypot(ddx, ddy) || 1;
    const ax = ddx / len, ay = ddy / len;   // unit vector along the line
    const px = -ay, py = ax;                // unit vector perpendicular to it
    // Two independent offsets from the straight midpoint: "bend" (how far
    // off the line, perpendicular) and "along" (where the bulge sits along
    // the line's own length) — dragging the handle sets both freely, so it
    // can move up/down the line as well as bow it out.
    const bend = line.data.bend || 0;
    const along = line.data.along || 0;
    const ctrl = { x: mx + px * bend + ax * along, y: my + py * bend + ay * along };
    // Point at t=0.5 on the quadratic curve itself (not the control point,
    // which sits off the curve once bent) — used for the label position.
    const curveMid = { x: 0.25 * from.x + 0.5 * ctrl.x + 0.25 * to.x, y: 0.25 * from.y + 0.5 * ctrl.y + 0.25 * to.y };

    const color = colorVar(line.color || 'slate');
    const markerId = 'arrow-' + line.id;
    addArrowMarker(defs, markerId, color);

    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('cline');
    const selected = line.id === state.selectedId;
    if (selected) g.classList.add('selected');
    const d = `M ${from.x},${from.y} Q ${ctrl.x},${ctrl.y} ${to.x},${to.y}`;
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d); hit.setAttribute('class', 'chit');
    const vis = document.createElementNS(SVG_NS, 'path');
    vis.setAttribute('d', d); vis.setAttribute('class', 'cvis');
    vis.setAttribute('stroke', color);
    vis.setAttribute('marker-end', `url(#${markerId})`);
    g.appendChild(hit); g.appendChild(vis);
    // A dot marker sits right on the card edge, decorative (pointer-
    // events:none in CSS) — a much bigger invisible circle underneath it is
    // the actual, easy-to-grab drag target, same trick as the wide
    // invisible .chit under the visible line.
    for (const attach of [fromAttach, toAttach]) {
      const isFrom = attach === fromAttach;
      const grabArea = document.createElementNS(SVG_NS, 'circle');
      grabArea.setAttribute('cx', attach.edge.x); grabArea.setAttribute('cy', attach.edge.y); grabArea.setAttribute('r', 14);
      grabArea.setAttribute('class', 'cdot-grab');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', attach.edge.x); dot.setAttribute('cy', attach.edge.y); dot.setAttribute('r', 4);
      dot.setAttribute('class', 'cdot');
      dot.setAttribute('fill', color);
      g.appendChild(grabArea); g.appendChild(dot);

      // Drag an endpoint dot onto a different card to re-point the
      // connector at it. Dropping on empty canvas or the same card cancels.
      grabArea.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        select(line.id);
        const otherId = isFrom ? line.data.toId : line.data.fromId;
        const move = (ev) => {
          document.querySelectorAll('.item.line-target').forEach(el => el.classList.remove('line-target'));
          const overEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.item');
          if (overEl && overEl.dataset.id !== otherId) overEl.classList.add('line-target');
        };
        const up = (ev) => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.querySelectorAll('.item.line-target').forEach(el => el.classList.remove('line-target'));
          const overEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.item');
          const newId = overEl && overEl.dataset.id;
          if (newId && newId !== otherId && newId !== (isFrom ? line.data.fromId : line.data.toId)) {
            const patch = isFrom ? { fromId: newId } : { toId: newId };
            saveData(line, patch);
          }
          renderLines();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
    }
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); select(line.id); renderLines(); });
    layer.appendChild(g);

    if (selected) {
      const bendGrab = document.createElementNS(SVG_NS, 'circle');
      bendGrab.setAttribute('cx', ctrl.x); bendGrab.setAttribute('cy', ctrl.y); bendGrab.setAttribute('r', 14);
      bendGrab.setAttribute('class', 'cbend-grab');
      const handle = document.createElementNS(SVG_NS, 'circle');
      handle.setAttribute('cx', ctrl.x); handle.setAttribute('cy', ctrl.y); handle.setAttribute('r', 5);
      handle.setAttribute('class', 'cbend');
      bendGrab.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        const move = (ev) => {
          const w = screenToWorld(ev.clientX, ev.clientY);
          const vx = w.x - mx, vy = w.y - my;
          line.data.bend = vx * px + vy * py;
          line.data.along = vx * ax + vy * ay;
          renderLines();
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          saveData(line, { bend: line.data.bend, along: line.data.along });
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
      layer.appendChild(bendGrab);
      layer.appendChild(handle);
    }

    if (selected || line.data.label) {
      const label = document.createElement('div');
      label.className = 'cline-label';
      label.contentEditable = 'true';
      label.dataset.placeholder = 'Add label';
      label.textContent = line.data.label || '';
      // Offset below the curve so it doesn't sit exactly on top of (and
      // completely hide, since it paints above the SVG layer) the bend
      // handle, which lives right at the curve's midpoint when unselected
      // labels aren't shown and at the control point once selected.
      label.style.left = curveMid.x + 'px';
      label.style.top = (curveMid.y + (selected ? 20 : 0)) + 'px';
      label.addEventListener('pointerdown', (e) => e.stopPropagation());
      label.addEventListener('input', () => saveData(line, { label: label.textContent.trim() }));
      label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); label.blur(); } });
      dom.world.appendChild(label);
      labelEls.push(label);
    }

    if (selected) {
      const del = document.createElement('button');
      del.className = 'cline-del';
      del.title = 'Delete connector';
      del.appendChild(lucideEl('trash-2'));
      del.style.left = ctrl.x + 'px';
      del.style.top = (ctrl.y - 26) + 'px';
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(line.id); });
      dom.world.appendChild(del);
      labelEls.push(del);
      refreshIcons(del);
    }
  }
}

// Called from onItemPointerDown while the Line tool is armed, instead of
// the normal select/drag flow: first card clicked becomes "from", second
// becomes "to". Clicking the same card twice, or empty canvas, cancels.
export function pickLineEndpoint(it) {
  if (it.type === 'line') return;
  if (!state.lineFrom) {
    state.lineFrom = it.id;
    toast('Click another card to connect');
    return;
  }
  if (state.lineFrom === it.id) { cancelLine(); return; }
  const fromId = state.lineFrom;
  cancelLine();
  createLine(fromId, it.id);
}

export function cancelLine() {
  state.lineFrom = null;
  disarm();
}

async function createLine(fromId, toId) {
  const body = { canvasId: state.view.canvas.id, type: 'line', x: 0, y: 0, w: 0, color: 'slate', data: { fromId, toId } };
  const it = await api.create(body);
  state.view.items.push(it);
  renderLines();
  toast('Connected');
}
