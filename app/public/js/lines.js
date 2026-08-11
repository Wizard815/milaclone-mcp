'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { colorVar, toast } from './util.js';
import { select, deleteItem } from './editing.js';
import { disarm } from './tools.js';

// Connector lines between two cards. Unlike every other item type, a line
// has no box of its own on the canvas — it's just a fromId/toId pair drawn
// into an SVG layer that lives inside #world so it inherits the same
// pan/zoom transform as everything else, no extra math required.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Reused across calls rather than recreated, since renderLines() runs on
// every drag/resize tick (not just on a full render()) — recreating it each
// time would pile up stale detached-looking duplicates as the drag proceeds.
function ensureLayer() {
  let svg = document.getElementById('linesLayer');
  if (!svg || svg.parentNode !== dom.world) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'linesLayer';
    dom.world.insertBefore(svg, dom.world.firstChild);
  }
  svg.innerHTML = '';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  return { svg, defs };
}

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
function centerOf(id) {
  const el = elMap.get(id);
  if (!el) return null;
  const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
}

export function renderLines() {
  const { svg: layer, defs } = ensureLayer();
  const lines = state.view.items.filter(it => it.type === 'line');
  for (const line of lines) {
    const from = elMap.has(line.data.fromId) && centerOf(line.data.fromId);
    const to = elMap.has(line.data.toId) && centerOf(line.data.toId);
    if (!from || !to) {
      // Endpoint no longer exists on this board (deleted card) — the line
      // is meaningless now, so clean it up rather than leaving it stuck.
      deleteItem(line.id);
      continue;
    }
    const color = colorVar(line.color || 'slate');
    const markerId = 'arrow-' + line.id;
    addArrowMarker(defs, markerId, color);

    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('cline');
    if (line.id === state.selectedId) g.classList.add('selected');
    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('x1', from.x); hit.setAttribute('y1', from.y);
    hit.setAttribute('x2', to.x); hit.setAttribute('y2', to.y);
    hit.setAttribute('class', 'chit');
    const vis = document.createElementNS(SVG_NS, 'line');
    vis.setAttribute('x1', from.x); vis.setAttribute('y1', from.y);
    vis.setAttribute('x2', to.x); vis.setAttribute('y2', to.y);
    vis.setAttribute('class', 'cvis');
    vis.setAttribute('stroke', color);
    vis.setAttribute('marker-end', `url(#${markerId})`);
    g.appendChild(hit); g.appendChild(vis);
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(line.id); renderLines(); });
    layer.appendChild(g);
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
