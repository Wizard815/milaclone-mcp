'use strict';

import { api } from './api.js';
import { colorVar } from './util.js';
import { openCanvas } from './main.js';

// A radial "sunburst" tree of every board (root dead center, children
// allocated an angular slice of their parent's slice, recursively — so
// depth alone determines ring radius and the tree shape determines angle),
// with connect-badge links drawn as a second, visually distinct layer of
// edges cutting across that tree. No physics simulation: deterministic and
// stable across reloads, closer to what the user asked for ("Home dead
// center, rest spiders out") than a force-directed layout would give for
// free anyway.

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 150;
const NODE_R = 26;

let root = null; // #mindMap

function refs() {
  if (root) return root;
  root = {
    el: document.getElementById('mindMap'),
    close: document.getElementById('mmClose'),
    svg: document.getElementById('mmSvg')
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

export async function openMindMap() {
  const r = refs();
  r.el.hidden = false;
  r.svg.innerHTML = '<text x="0" y="0" fill="var(--ink-faint)" font-size="14">Loading…</text>';

  const data = await api.graph();
  const tree = buildTree(data.canvases, data.rootCanvasId);
  if (!tree) { r.svg.innerHTML = ''; return; }

  // A single node (just Home, no boards yet) gets a 0-span layout — fine,
  // it just sits at the center with nothing to fan out.
  layout(tree, -Math.PI, Math.PI, 0);
  const nodes = flatten(tree, []);
  const byId = new Map(nodes.map(n => [n.id, n]));

  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const n of nodes) {
    minX = Math.min(minX, n._x - NODE_R); maxX = Math.max(maxX, n._x + NODE_R);
    minY = Math.min(minY, n._y - NODE_R); maxY = Math.max(maxY, n._y + NODE_R);
  }
  const pad = 60;
  const vbX = minX - pad, vbY = minY - pad, vbW = (maxX - minX) + pad * 2, vbH = (maxY - minY) + pad * 2;

  r.svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  r.svg.innerHTML = '';

  const edgeLayer = document.createElementNS(SVG_NS, 'g'); edgeLayer.setAttribute('class', 'mm-edges');
  const connectLayer = document.createElementNS(SVG_NS, 'g'); connectLayer.setAttribute('class', 'mm-connects');
  const nodeLayer = document.createElementNS(SVG_NS, 'g'); nodeLayer.setAttribute('class', 'mm-nodes');
  r.svg.appendChild(edgeLayer); r.svg.appendChild(connectLayer); r.svg.appendChild(nodeLayer);

  // Structural (nesting) edges — dim, thin, always present.
  for (const n of nodes) {
    if (!n.parentCanvasId || !byId.has(n.parentCanvasId)) continue;
    const p = byId.get(n.parentCanvasId);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', p._x); line.setAttribute('y1', p._y);
    line.setAttribute('x2', n._x); line.setAttribute('y2', n._y);
    line.setAttribute('class', 'mm-edge');
    edgeLayer.appendChild(line);
  }

  // Connect-badge edges — highlighted, drawn as a curve so they read as
  // distinct "shortcuts" laid over the plain tree structure. Bowed out far
  // enough to clear any *other* node the straight line would otherwise
  // pass through (a real risk here specifically: two children of the same
  // hub are often roughly opposite each other, so the direct line between
  // them runs right through that hub — Home most commonly).
  const seen = new Set();
  for (const c of data.connects) {
    const from = byId.get(c.canvasId), to = byId.get(c.targetCanvasId);
    if (!from || !to || from === to) continue;
    const key = [from.id, to.id].sort().join('|');
    const side = seen.has(key) ? -1 : 1; // nudge a second edge between the same pair to the other side
    seen.add(key);

    const dx = to._x - from._x, dy = to._y - from._y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // unit vector along the edge
    const px = -uy, py = ux;            // unit vector perpendicular to it

    let bow = Math.max(len * 0.22, 24);
    for (const other of nodes) {
      if (other === from || other === to) continue;
      // distance from `other` to the straight line from->to
      const t = (other._x - from._x) * ux + (other._y - from._y) * uy;
      if (t <= 0 || t >= len) continue; // projects outside the segment — not in the way
      const closestX = from._x + ux * t, closestY = from._y + uy * t;
      const dist = Math.hypot(other._x - closestX, other._y - closestY);
      const clearance = NODE_R + 24;
      if (dist < clearance) bow = Math.max(bow, clearance + (clearance - dist));
    }

    const mx = (from._x + to._x) / 2, my = (from._y + to._y) / 2;
    const cx = mx + px * bow * side, cy = my + py * bow * side;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${from._x},${from._y} Q ${cx},${cy} ${to._x},${to._y}`);
    path.setAttribute('class', 'mm-connect');
    if (c.note || c.label) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = c.label + (c.note ? ' — ' + c.note : ''); path.appendChild(t); }
    connectLayer.appendChild(path);
  }

  for (const n of nodes) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-node' + (n.id === data.rootCanvasId ? ' mm-root' : ''));
    g.setAttribute('transform', `translate(${n._x},${n._y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', n.id === data.rootCanvasId ? NODE_R + 6 : NODE_R);
    circle.setAttribute('fill', colorVar(n.color || 'slate'));
    g.appendChild(circle);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', NODE_R + 16);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'mm-label');
    label.textContent = n.title || 'Untitled';
    g.appendChild(label);
    g.addEventListener('click', () => { closeMindMap(); openCanvas(n.id); });
    nodeLayer.appendChild(g);
  }
}

export function isMindMapOpen() { return !refs().el.hidden; }

function closeMindMap() {
  refs().el.hidden = true;
}

export function initMindMap() {
  const r = refs();
  document.getElementById('mindMapBtn').addEventListener('click', openMindMap);
  r.close.addEventListener('click', closeMindMap);
  document.addEventListener('keydown', (e) => {
    if (r.el.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMindMap(); }
  });
}
