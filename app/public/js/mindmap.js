'use strict';

import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons } from './util.js';
import { openCanvas } from './main.js';
import { ICONS, openConnectPicker, navigateToTarget } from './connect.js';

// A radial "sunburst" tree of every board (root dead center, children
// allocated an angular slice of their parent's slice, recursively — so
// depth alone determines ring radius and the tree shape determines angle),
// with connect-badge links drawn as a second, visually distinct layer of
// edges cutting across that tree. No physics simulation: deterministic and
// stable across reloads, closer to what the user asked for ("Home dead
// center, rest spiders out") than a force-directed layout would give for
// free anyway.
//
// Semantic zoom: clicking a board node expands it in place into a ring of
// its own cards (satellite nodes) instead of navigating — double-click (or
// the context menu) does the actual navigation. Expanded boards are
// re-fetched and re-laid-out on every render, so this stays correct as you
// expand/collapse and as connect edges re-target actual item nodes once
// both ends happen to be visible.

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 150;
const NODE_R = 26;
const SAT_R = 10;
const SAT_DIST = NODE_R + 58;

let root = null; // #mindMap
let expanded = new Set();      // board ids currently expanded
let itemCache = new Map();     // boardId -> items[] (cleared each time the map re-opens)
let lastData = null;           // {rootCanvasId, canvases, connects} from the last fetch
let ctxTarget = null;          // {canvasId, itemId|null} for the open context menu

function refs() {
  if (root) return root;
  root = {
    el: document.getElementById('mindMap'),
    close: document.getElementById('mmClose'),
    svg: document.getElementById('mmSvg'),
    ctx: document.getElementById('mmCtx'),
    ctxConnect: document.getElementById('mmCtxConnect'),
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
  const items = (data.items || []).filter(it => !['board', 'line', 'connect'].includes(it.type) && !it.parentItemId);
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
  lastData = data;
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
    items.forEach((it, i) => {
      const angle = (i / Math.max(items.length, 1)) * Math.PI * 2 - Math.PI / 2;
      satellites.push({ boardId, it, x: node._x + SAT_DIST * Math.cos(angle), y: node._y + SAT_DIST * Math.sin(angle) });
    });
  }
  const satByItemId = new Map(satellites.map(s => [s.it.id, s]));

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
  const connectLayer = document.createElementNS(SVG_NS, 'g'); connectLayer.setAttribute('class', 'mm-connects');
  const nodeLayer = document.createElementNS(SVG_NS, 'g'); nodeLayer.setAttribute('class', 'mm-nodes');
  const satLayer = document.createElementNS(SVG_NS, 'g'); satLayer.setAttribute('class', 'mm-sats');
  r.svg.append(edgeLayer, satEdgeLayer, connectLayer, nodeLayer, satLayer);

  // Structural (nesting) edges between boards — dim, thin, always present.
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

  // Connect-badge edges — highlighted, bowed out far enough to clear any
  // *other* node the straight line would otherwise pass through (a real
  // risk here: two children of the same hub are often roughly opposite
  // each other, so the direct line runs right through that hub). Prefers
  // the precise item-level endpoint over the board when it's on screen.
  const clearanceNodes = nodes.map(n => ({ x: n._x, y: n._y, r: NODE_R })).concat(satellites.map(s => ({ x: s.x, y: s.y, r: SAT_R })));
  const seen = new Set();
  for (const c of data.connects) {
    const fromSat = c.sourceItemId && satByItemId.get(c.sourceItemId);
    const toSat = c.targetItemId && satByItemId.get(c.targetItemId);
    const fromNode = fromSat ? null : byId.get(c.canvasId);
    const toNode = toSat ? null : byId.get(c.targetCanvasId);
    const from = fromSat ? { x: fromSat.x, y: fromSat.y } : (fromNode ? { x: fromNode._x, y: fromNode._y } : null);
    const to = toSat ? { x: toSat.x, y: toSat.y } : (toNode ? { x: toNode._x, y: toNode._y } : null);
    if (!from || !to || (from.x === to.x && from.y === to.y)) continue;

    const key = (c.sourceItemId || c.canvasId) + '|' + (c.targetItemId || c.targetCanvasId);
    const side = seen.has(key) ? -1 : 1;
    seen.add(key);

    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux;

    let bow = Math.max(len * 0.22, 24);
    for (const other of clearanceNodes) {
      if ((other.x === from.x && other.y === from.y) || (other.x === to.x && other.y === to.y)) continue;
      const t = (other.x - from.x) * ux + (other.y - from.y) * uy;
      if (t <= 0 || t >= len) continue;
      const dist = Math.hypot(other.x - (from.x + ux * t), other.y - (from.y + uy * t));
      const clearance = other.r + 24;
      if (dist < clearance) bow = Math.max(bow, clearance + (clearance - dist));
    }

    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const cx = mx + px * bow * side, cy = my + py * bow * side;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${from.x},${from.y} Q ${cx},${cy} ${to.x},${to.y}`);
    path.setAttribute('class', 'mm-connect' + ((fromSat || toSat) ? ' mm-connect-item' : ''));
    if (c.note || c.label) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = c.label + (c.note ? ' — ' + c.note : ''); path.appendChild(t); }
    connectLayer.appendChild(path);
  }

  for (const n of nodes) {
    const isRoot = n.id === data.rootCanvasId;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-node' + (isRoot ? ' mm-root' : '') + (expanded.has(n.id) ? ' mm-expanded' : ''));
    g.setAttribute('transform', `translate(${n._x},${n._y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', isRoot ? NODE_R + 6 : NODE_R);
    circle.setAttribute('fill', colorVar(n.color || 'slate'));
    g.appendChild(circle);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', NODE_R + 16);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'mm-label');
    label.textContent = n.title || 'Untitled';
    g.appendChild(label);
    g.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(n.id); });
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); closeMindMap(); openCanvas(n.id); });
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
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); closeMindMap(); navigateToTarget(s.boardId, s.it.id); });
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openCtx(e, s.boardId, s.it.id); });
    satLayer.appendChild(g);
  }

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
  r.ctxConnect.addEventListener('click', () => {
    if (!ctxTarget) return;
    const { canvasId, itemId } = ctxTarget;
    // If a specific card was right-clicked, place the new badge right next
    // to it (same math as the canvas's own "Connect from here") so the
    // connection reads as coming from that card, not just "this board".
    let worldPos = { x: 60, y: 60 };
    const w = 220;
    if (itemId) {
      const items = itemCache.get(canvasId) || [];
      const it = items.find(x => x.id === itemId);
      if (it) worldPos = { x: (it.x || 0) + (it.w || 240) + 20 + w / 2, y: (it.y || 0) + 30 };
    }
    closeCtx();
    closeMindMap();
    openConnectPicker(worldPos, canvasId, itemId || null);
  });
  r.ctxOpen.addEventListener('click', () => {
    if (!ctxTarget) return;
    const { canvasId, itemId } = ctxTarget;
    closeCtx();
    closeMindMap();
    if (itemId) navigateToTarget(canvasId, itemId);
    else openCanvas(canvasId);
  });
  document.addEventListener('keydown', (e) => {
    if (r.el.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (!r.ctx.hidden) closeCtx(); else closeMindMap(); }
  });
}
