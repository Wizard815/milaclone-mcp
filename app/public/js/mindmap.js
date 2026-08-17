'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons } from './util.js';
import { select } from './editing.js';
import { applyCam } from './viewport.js';
import { openCanvas } from './main.js';

// A radial "sunburst" tree of every board (root dead center, children
// allocated an angular slice of their parent's slice, recursively — so
// depth alone determines ring radius and the tree shape determines angle).
// No physics simulation: deterministic and stable across reloads, closer to
// what the user asked for ("Home dead center, rest spiders out") than a
// force-directed layout would give for free anyway.
//
// Semantic zoom: clicking a board node expands it in place into a ring of
// its own cards (satellite nodes) instead of navigating — double-click (or
// the context menu) does the actual navigation.

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 220;
const NODE_R = 26;
const SAT_R = 10;
const SAT_DIST = NODE_R + 72;
// Minimum arc length (px) between adjacent satellites' centers. A fixed
// ring radius works fine for a handful of cards, but a board with a dozen+
// items packs them so tight on a fixed-size ring that neighboring icons and
// labels overlap — so the ring grows with the item count to keep spacing
// roughly constant instead.
const SAT_MIN_ARC = 62;
function satDistFor(count) {
  return Math.max(SAT_DIST, (SAT_MIN_ARC * count) / (2 * Math.PI));
}

const ICONS = {
  note: 'file-text', todo: 'list-checks', link: 'link-2', heading: 'heading-1',
  document: 'file-text', table: 'table', color: 'palette', draw: 'pencil',
  comment: 'message-circle', column: 'columns-3', file: 'file', image: 'image'
};

let root = null; // #mindMap
let expanded = new Set();      // board ids currently expanded
let itemCache = new Map();     // boardId -> items[] (cleared each time the map re-opens)
let ctxTarget = null;          // {canvasId, itemId|null} for the open context menu
let clickTimer = null;         // pending single-click (see wireNodeClicks) — cancelled by a dblclick

function refs() {
  if (root) return root;
  root = {
    el: document.getElementById('mindMap'),
    close: document.getElementById('mmClose'),
    svg: document.getElementById('mmSvg'),
    ctx: document.getElementById('mmCtx'),
    ctxOpen: document.getElementById('mmCtxOpen')
  };
  return root;
}

function buildTree(canvases, rootId) {
  const byId = new Map(canvases.map(c => [c.id, Object.assign({}, c, { children: [] })]));
  for (const c of byId.values()) {
    if (c.parentCanvasId && byId.has(c.parentCanvasId)) byId.get(c.parentCanvasId).children.push(c);
  }
  return byId.get(rootId) || null;
}

function countNodes(node) {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

// Deliberately independent of expand state: a node's position depends only
// on the static tree (parent/child counts), never on which nodes happen to
// be expanded right now. Earlier this scaled angle/radius by expanded
// rings to avoid overlap, but that meant expanding *any* node could shift
// *every* other node's position — clicking one board made the whole map
// jump. Positions now stay put; only the clicked node's own ring of
// satellites appears/disappears around its fixed spot.
function layout(node, angleStart, angleEnd, depth) {
  const angle = (angleStart + angleEnd) / 2;
  const r = depth * RING;
  node._x = r * Math.cos(angle);
  node._y = r * Math.sin(angle);
  node._angle = angle;
  if (!node.children.length) return;
  const span = angleEnd - angleStart;
  const weights = node.children.map(c => Math.max(countNodes(c), 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let a = angleStart;
  node.children.forEach((c, i) => {
    const share = (weights[i] / total) * span;
    layout(c, a, a + share, depth + 1);
    a += share;
  });
}

function flatten(node, acc) {
  acc.push(node);
  node.children.forEach(c => flatten(c, acc));
  return acc;
}

function previewText(it) {
  const d = it.data || {};
  return d.title || d.text || (d.body && d.body.slice(0, 30)) || d.url || it.type;
}

async function getBoardItems(boardId) {
  if (itemCache.has(boardId)) return itemCache.get(boardId);
  const data = await api.canvas(boardId);
  const items = (data.items || []).filter(it => !['board', 'line'].includes(it.type) && !it.parentItemId);
  itemCache.set(boardId, items);
  return items;
}

export async function openMindMap() {
  const r = refs();
  r.el.hidden = false;
  expanded = new Set();
  itemCache = new Map();
  r.svg.innerHTML = '<text x="0" y="0" fill="var(--ink-faint)" font-size="14">Loading…</text>';
  r.svg.removeAttribute('viewBox');
  await renderGraph();
}

async function renderGraph() {
  const r = refs();
  const data = await api.graph();
  const tree = buildTree(data.canvases, data.rootCanvasId);
  if (!tree) { r.svg.innerHTML = ''; return; }

  layout(tree, -Math.PI, Math.PI, 0);
  const nodes = flatten(tree, []);
  const byId = new Map(nodes.map(n => [n.id, n]));

  // Satellite (item-level) nodes for every currently-expanded board.
  const satellites = []; // {boardId, it, x, y}
  for (const boardId of expanded) {
    const node = byId.get(boardId);
    if (!node) continue;
    const items = await getBoardItems(boardId);
    const dist = satDistFor(items.length);
    items.forEach((it, i) => {
      const angle = (i / Math.max(items.length, 1)) * Math.PI * 2 - Math.PI / 2;
      satellites.push({ boardId, it, x: node._x + dist * Math.cos(angle), y: node._y + dist * Math.sin(angle) });
    });
  }

  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const n of nodes) {
    minX = Math.min(minX, n._x - NODE_R); maxX = Math.max(maxX, n._x + NODE_R);
    minY = Math.min(minY, n._y - NODE_R); maxY = Math.max(maxY, n._y + NODE_R);
  }
  for (const s of satellites) {
    minX = Math.min(minX, s.x - SAT_R); maxX = Math.max(maxX, s.x + SAT_R);
    minY = Math.min(minY, s.y - SAT_R); maxY = Math.max(maxY, s.y + SAT_R);
  }
  const pad = 60;
  r.svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${(maxX - minX) + pad * 2} ${(maxY - minY) + pad * 2}`);
  r.svg.innerHTML = '';

  const edgeLayer = document.createElementNS(SVG_NS, 'g'); edgeLayer.setAttribute('class', 'mm-edges');
  const satEdgeLayer = document.createElementNS(SVG_NS, 'g'); satEdgeLayer.setAttribute('class', 'mm-sat-edges');
  const nodeLayer = document.createElementNS(SVG_NS, 'g'); nodeLayer.setAttribute('class', 'mm-nodes');
  const satLayer = document.createElementNS(SVG_NS, 'g'); satLayer.setAttribute('class', 'mm-sats');
  r.svg.append(edgeLayer, satEdgeLayer, nodeLayer, satLayer);

  // Structural (nesting) edges between boards.
  for (const n of nodes) {
    if (!n.parentCanvasId || !byId.has(n.parentCanvasId)) continue;
    const p = byId.get(n.parentCanvasId);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', p._x); line.setAttribute('y1', p._y);
    line.setAttribute('x2', n._x); line.setAttribute('y2', n._y);
    line.setAttribute('class', 'mm-edge');
    edgeLayer.appendChild(line);
  }
  // Board -> its own satellite cards, once expanded.
  for (const s of satellites) {
    const b = byId.get(s.boardId);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', b._x); line.setAttribute('y1', b._y);
    line.setAttribute('x2', s.x); line.setAttribute('y2', s.y);
    line.setAttribute('class', 'mm-sat-edge');
    satEdgeLayer.appendChild(line);
  }

  for (const n of nodes) {
    const isRoot = n.id === data.rootCanvasId;
    const r = isRoot ? NODE_R + 6 : NODE_R;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-node' + (isRoot ? ' mm-root' : '') + (expanded.has(n.id) ? ' mm-expanded' : ''));
    g.setAttribute('transform', `translate(${n._x},${n._y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', r);
    circle.setAttribute('fill', colorVar(n.color || 'slate'));
    g.appendChild(circle);
    // Same icon as the board's own tile on the canvas (buildBoard in
    // cards.js), so a board reads as the same "thing" in both views.
    const icon = lucideEl(n.icon || 'layout-grid');
    const iconSize = r * 0.85;
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.setAttribute('x', -iconSize / 2); fo.setAttribute('y', -iconSize / 2);
    fo.setAttribute('width', iconSize); fo.setAttribute('height', iconSize);
    fo.appendChild(icon);
    g.appendChild(fo);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', NODE_R + 16);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'mm-label');
    label.textContent = n.title || 'Untitled';
    g.appendChild(label);
    // A dblclick sequence fires two 'click' events before the 'dblclick'
    // itself (native browser behavior) — without this delay, opening a
    // board would first toggle-expand it (twice) and only then navigate,
    // producing a visible flicker right before the jump. Hold each click
    // for a beat in case a second one arrives to cancel it into an open.
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => toggleExpand(n.id), 220);
    });
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      closeMindMap(); openCanvas(n.id);
    });
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openCtx(e, n.id, null); });
    nodeLayer.appendChild(g);
  }

  for (const s of satellites) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-sat');
    g.setAttribute('transform', `translate(${s.x},${s.y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', SAT_R);
    circle.setAttribute('class', 'mm-sat-circle');
    g.appendChild(circle);
    const icon = lucideEl(ICONS[s.it.type] || 'square');
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.setAttribute('x', -8); fo.setAttribute('y', -8); fo.setAttribute('width', 16); fo.setAttribute('height', 16);
    fo.appendChild(icon);
    g.appendChild(fo);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', SAT_R + 13);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'mm-sat-label');
    label.textContent = previewText(s.it);
    g.appendChild(label);
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); closeMindMap(); navigateToItem(s.boardId, s.it.id); });
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openCtx(e, s.boardId, s.it.id); });
    satLayer.appendChild(g);
  }

  refreshIcons(nodeLayer);
  refreshIcons(satLayer);
}

function toggleExpand(boardId) {
  if (expanded.has(boardId)) expanded.delete(boardId); else expanded.add(boardId);
  renderGraph();
}

function openCtx(e, canvasId, itemId) {
  ctxTarget = { canvasId, itemId };
  const r = refs();
  const wrapRect = document.querySelector('.mm-canvas-wrap').getBoundingClientRect();
  r.ctx.style.left = (e.clientX - wrapRect.left) + 'px';
  r.ctx.style.top = (e.clientY - wrapRect.top) + 'px';
  r.ctx.hidden = false;
}

function closeCtx() {
  refs().ctx.hidden = true;
  ctxTarget = null;
}

// Centers the camera on a world point — used instead of scrollIntoView()
// since items live inside #world's pan/zoom transform, which the DOM's own
// scroll machinery knows nothing about.
function centerCameraOn(x, y) {
  const vw = dom.stage.clientWidth, vh = dom.stage.clientHeight;
  state.cam.x = vw / 2 - x * state.cam.scale;
  state.cam.y = vh / 2 - y * state.cam.scale;
  applyCam();
}

async function navigateToItem(canvasId, itemId) {
  await openCanvas(canvasId);
  const target = state.view.items.find(x => x.id === itemId);
  if (target) {
    select(target.id);
    centerCameraOn((target.x || 0) + (target.w || 240) / 2, (target.y || 0) + 60);
  }
}

export function isMindMapOpen() { return !refs().el.hidden; }

function closeMindMap() {
  refs().el.hidden = true;
  closeCtx();
}

export function initMindMap() {
  const r = refs();
  document.getElementById('mindMapBtn').addEventListener('click', openMindMap);
  r.close.addEventListener('click', closeMindMap);
  r.svg.addEventListener('click', closeCtx);
  r.ctxOpen.addEventListener('click', () => {
    if (!ctxTarget) return;
    const { canvasId, itemId } = ctxTarget;
    closeCtx();
    closeMindMap();
    if (itemId) navigateToItem(canvasId, itemId);
    else openCanvas(canvasId);
  });
  document.addEventListener('keydown', (e) => {
    if (r.el.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (!r.ctx.hidden) closeCtx(); else closeMindMap(); }
  });
}
