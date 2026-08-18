'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons } from './util.js';
import { select } from './editing.js';
import { applyCam } from './viewport.js';
import { openCanvas } from './main.js';
import { openConnectPicker } from './connect.js';

// A force-directed graph of every board (plus, per expanded board, its own
// items as satellites) — repulsion between every node pair, spring
// attraction along real edges, weak centering, damping + cooling. Board
// positions used to be a fixed deterministic radial tree; that kept things
// stable but meant a board with lots of items threw its satellites out to
// an ever-growing fixed-radius ring, regularly overlapping a neighboring
// board's own cluster with no sense of what actually related to what.
//
// Edges come from five places: board nesting (parent/child canvases),
// board -> its own expanded satellite items (or -> the item's own column,
// once columns can themselves be satellites -- see below), item <-> item
// for any Line the user has actually drawn between two items open on the
// same board (public/js/lines.js) -- both endpoints have to be currently-
// visible satellites for the edge to render -- item <-> item zigzag edges
// between cards sharing a column (visually distinct from a real Line), and
// cross-board Connect badges (public/js/connect.js), which unlike Line can
// link two items on entirely different boards and always render (using
// whichever end -- the specific card or its board's own hub -- is
// currently visible) rather than requiring both ends expanded.
//
// Positions persist across renders in `simPositions`, keyed by node id
// (board canvasId or item id — distinct id namespaces, no collision) and
// seeded from wherever a node last settled rather than restarting from
// scratch, so expanding/collapsing a board doesn't visibly scramble
// everything else. New nodes seed near whatever they're structurally
// closest to (a new board near its parent, a new satellite near its board)
// so they visibly emerge instead of popping in from the origin.
//
// Semantic zoom stays: clicking a board node expands it in place into a
// ring of its own cards (satellite nodes) instead of navigating —
// double-click (or the context menu) does the actual navigation.
//
// Camera: its own free pan/zoom (mmCam below), independent of the main
// canvas's — drag to pan, wheel/ctrl+wheel to zoom, same conventions as the
// board canvas (viewport.js). Deliberately never reset/refit by a layout
// change (only once, on initial open) — an SVG viewBox that auto-fits to
// whatever's currently expanded was tried first and was a mistake:
// expanding a board changed the fit, which reframed the whole graph around
// the new content on every click, making every other node appear to jump
// even though its own coordinates never moved.

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_R = 26;
const SAT_R = 10;

// Simulation tuning. Repulsion falls off as 1/dist^2 (Coulomb-style);
// springs pull connected nodes toward a rest length; a weak constant force
// pulls everything toward the origin so the graph doesn't drift arbitrarily
// far as repulsion pushes things apart; the root board gets an extra pin so
// "Home" stays roughly centered, matching the old design's intent.
const ITERATIONS = 220;
const REPULSE_K = 2600;
// Centering has to stay much weaker than the springs below, or it fights
// their rest length and drags everything in far tighter than intended (a
// board's equilibrium distance from its parent is roughly
// rest * spring_k / (spring_k + center_k) -- with center_k this small,
// that lands close to `rest` itself instead of collapsing toward it).
const CENTER_K = 0.004;
const ROOT_PIN_K = 0.16;
const DAMPING = 0.82;
const REST_BOARD = 200, SPRING_BOARD = 0.02;
const REST_SPOKE = 90, SPRING_SPOKE = 0.05;
const REST_LINE = 70, SPRING_LINE = 0.08;
// Column siblings should cluster tighter than a normal same-board Line.
const REST_GROUP = 50, SPRING_GROUP = 0.06;
// Weak on purpose -- nudges connected boards/items closer without
// overriding the tree's overall shape, since a connect edge can easily
// span two otherwise-unrelated branches of the whole graph.
const REST_CONNECT = 180, SPRING_CONNECT = 0.015;
// Extra push once two nodes are closer than their combined collision radius
// (visual circle + estimated label width) — smooth 1/dist^2 repulsion alone
// keeps circles from overlapping but doesn't know a label sticks out much
// wider than its 10-26px circle, so dense satellite clusters would still
// read as a jumble of crossed-out text without this.
const COLLISION_K = 0.7;

const ICONS = {
  note: 'file-text', todo: 'list-checks', link: 'link-2', heading: 'heading-1',
  document: 'file-text', table: 'table', color: 'palette', draw: 'pencil',
  comment: 'message-circle', column: 'columns-3', file: 'file', image: 'image'
};

let root = null; // #mindMap
let expanded = new Set();      // board ids currently expanded
let itemCache = new Map();     // boardId -> {items, lines} (cleared each time the map re-opens)
let ctxTarget = null;          // {canvasId, itemId|null} for the open context menu
let clickTimer = null;         // pending single-click (see node click handler) — cancelled by a dblclick
let mmCam = { x: 0, y: 0, scale: 1 }; // this view's own camera, reset each time the map opens
let panStart = null;           // {sx, sy, cx, cy} while dragging the background
let renderToken = 0;           // guards against a slower, now-stale renderGraph() call overwriting a newer one
let simPositions = new Map();  // id -> {x, y, vx, vy}, persisted across renders

function refs() {
  if (root) return root;
  root = {
    el: document.getElementById('mindMap'),
    close: document.getElementById('mmClose'),
    svg: document.getElementById('mmSvg'),
    wrap: document.querySelector('.mm-canvas-wrap'),
    ctx: document.getElementById('mmCtx'),
    ctxOpen: document.getElementById('mmCtxOpen'),
    ctxConnect: document.getElementById('mmCtxConnect'),
    zoomIn: document.getElementById('mmZoomIn'),
    zoomOut: document.getElementById('mmZoomOut'),
    zoomReset: document.getElementById('mmZoomReset'),
    zoomLvl: document.getElementById('mmZoomLvl')
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

function flatten(node, acc) {
  acc.push(node);
  node.children.forEach(c => flatten(c, acc));
  return acc;
}

// Assigns a starting (x,y) the first time a node is ever seen, so the
// simulation doesn't have to relax from a dead stop every render; already-
// seen nodes keep wherever they last settled. `exact` places the root
// board precisely at the origin; everything else gets a small random
// offset from its structural anchor (parent board, or owning board for a
// satellite) so it visibly emerges from that anchor.
function seedPosition(id, nearX, nearY, exact) {
  if (simPositions.has(id)) return simPositions.get(id);
  let x = nearX, y = nearY;
  if (!exact) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 40;
    x += Math.cos(angle) * dist; y += Math.sin(angle) * dist;
  }
  const p = { x, y, vx: 0, vy: 0 };
  simPositions.set(id, p);
  return p;
}

function seedBoards(node, parentPos, rootId) {
  const pos = node.id === rootId
    ? seedPosition(node.id, 0, 0, true)
    : seedPosition(node.id, parentPos.x, parentPos.y, false);
  node.children.forEach(c => seedBoards(c, pos, rootId));
  return pos;
}

function previewText(it) {
  const d = it.data || {};
  const raw = String(d.title || d.text || (d.body && d.body.slice(0, 60)) || d.url || it.type || '');
  // Capped at 5 words so a long note/comment body doesn't bloat its own
  // satellite far past what a short label would.
  const words = raw.trim().split(/\s+/).filter(Boolean);
  return words.length > 5 ? words.slice(0, 5).join(' ') + '…' : raw;
}

// Rough label half-width in px (no real text metrics available before the
// label is actually in the DOM) — used only as extra collision-radius
// padding so two nodes' *labels* don't run into each other even when their
// circles wouldn't.
function labelHalfWidth(text) {
  return Math.max(20, String(text || '').length * 3);
}

async function getBoardItems(boardId) {
  if (itemCache.has(boardId)) return itemCache.get(boardId);
  const data = await api.canvas(boardId);
  const all = data.items || [];
  // shape cards are background decoration, not really a "thing" someone
  // would want to jump to or connect to. Connect badges are represented
  // purely via the connect-edge layer (see renderGraph), never as a
  // generic satellite of their own. Column children -- items with a
  // parentItemId -- USED to be excluded here too; now they're kept so a
  // column's members can show up as their own satellites, spoking to the
  // column instead of the board (see renderGraph).
  const items = all.filter(it => !['board', 'line', 'shape', 'connect'].includes(it.type));
  const lines = all.filter(it => it.type === 'line');
  const result = { items, lines };
  itemCache.set(boardId, result);
  return result;
}

// Plain iterative force simulation: repulsion between every pair, springs
// along edges toward a rest length, weak centering, damped + cooled so it
// settles instead of oscillating forever. Run synchronously to convergence
// once per renderGraph() call rather than as a continuous animation loop —
// matches the app's existing "compute once, draw once" render model.
function simulate(ids, edges, rootId, collisionR) {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;
    const force = new Map(ids.map(id => [id, { x: 0, y: 0 }]));

    for (let i = 0; i < ids.length; i++) {
      const a = simPositions.get(ids[i]);
      const ra = collisionR.get(ids[i]) || 0;
      for (let j = i + 1; j < ids.length; j++) {
        const b = simPositions.get(ids[j]);
        const rb = collisionR.get(ids[j]) || 0;
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist2 = 1; }
        const dist = Math.sqrt(dist2);
        let f = (REPULSE_K * alpha) / dist2;
        const minDist = ra + rb;
        if (dist < minDist) f += (minDist - dist) * COLLISION_K;
        const fx = (dx / dist) * f, fy = (dy / dist) * f;
        const fa = force.get(ids[i]), fb = force.get(ids[j]);
        fa.x += fx; fa.y += fy;
        fb.x -= fx; fb.y -= fy;
      }
    }

    for (const e of edges) {
      const a = simPositions.get(e.a), b = simPositions.get(e.b);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const diff = (dist - e.rest) * e.k * alpha;
      const ux = dx / dist, uy = dy / dist;
      const fa = force.get(e.a), fb = force.get(e.b);
      fa.x += ux * diff; fa.y += uy * diff;
      fb.x -= ux * diff; fb.y -= uy * diff;
    }

    for (const id of ids) {
      const p = simPositions.get(id);
      const f = force.get(id);
      f.x += -p.x * CENTER_K;
      f.y += -p.y * CENTER_K;
      if (id === rootId) { f.x += -p.x * ROOT_PIN_K; f.y += -p.y * ROOT_PIN_K; }
      p.vx = (p.vx + f.x) * DAMPING;
      p.vy = (p.vy + f.y) * DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }
  }
}

function applyMmCam() {
  const g = document.getElementById('mmWorld');
  if (g) g.setAttribute('transform', `translate(${mmCam.x},${mmCam.y}) scale(${mmCam.scale})`);
  const r = refs();
  if (r.zoomLvl) r.zoomLvl.textContent = Math.round(mmCam.scale * 100) + '%';
}

function resetMmCam() {
  const r = refs();
  const vw = r.wrap.clientWidth || 800, vh = r.wrap.clientHeight || 600;
  mmCam = { x: vw / 2, y: vh / 2, scale: 1 }; // Home (0,0) centered in the visible wrap
  applyMmCam();
}

// One-time fit after the initial (unexpanded) graph has settled — a force
// simulation's bounding box isn't known in advance the way the old fixed-
// radius tree's was. Never called again after that: layout changes from
// expand/collapse must never move the user's own camera (see file header).
function fitToBounds(padding = 90) {
  const r = refs();
  const ids = [...simPositions.keys()];
  if (!ids.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const p = simPositions.get(id);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const vw = r.wrap.clientWidth || 800, vh = r.wrap.clientHeight || 600;
  const scale = Math.max(0.2, Math.min(1, Math.min((vw - padding * 2) / w, (vh - padding * 2) / h)));
  mmCam.scale = scale;
  mmCam.x = vw / 2 - ((minX + maxX) / 2) * scale;
  mmCam.y = vh / 2 - ((minY + maxY) / 2) * scale;
  applyMmCam();
}

export async function openMindMap() {
  const r = refs();
  r.el.hidden = false;
  expanded = new Set();
  itemCache = new Map();
  simPositions = new Map();
  r.svg.innerHTML = '<text x="16" y="24" fill="var(--ink-faint)" font-size="14">Loading…</text>';
  resetMmCam();
  await renderGraph();
  fitToBounds();
}

// Expanding a node schedules a render 220ms out (see the click handler
// below), so it's easy to have two renderGraph() calls in flight at once —
// click one node, click another before the first settles. Each is async
// (fetches the graph, then each newly-expanded board's items) and they
// don't necessarily resolve in the order they started, so without a guard
// a slower *older* call can finish last and overwrite a newer one's result
// — a real flash of a different, stale layout for a frame. Each call
// grabs a token and bails before touching the DOM if a newer one has
// since started.
async function renderGraph() {
  const myToken = ++renderToken;
  const r = refs();
  const data = await api.graph();
  const tree = buildTree(data.canvases, data.rootCanvasId);
  if (!tree) { if (myToken === renderToken) r.svg.innerHTML = ''; return; }

  const boardNodes = flatten(tree, []);
  const byId = new Map(boardNodes.map(n => [n.id, n]));
  seedBoards(tree, null, data.rootCanvasId);

  // Satellite (item-level) nodes + line-drawn edges for every currently-
  // expanded board.
  const satellites = []; // {boardId, it}
  const rawLineEdges = []; // {fromId, toId}
  const visibleSatIds = new Set();
  for (const boardId of expanded) {
    if (!byId.has(boardId)) continue;
    const { items, lines } = await getBoardItems(boardId);
    for (const it of items) { satellites.push({ boardId, it }); visibleSatIds.add(it.id); }
    for (const ln of lines) rawLineEdges.push({ fromId: ln.data.fromId, toId: ln.data.toId });
  }
  if (myToken !== renderToken) return; // a newer render started while we were awaiting — don't clobber it

  for (const s of satellites) {
    const boardPos = simPositions.get(s.boardId);
    seedPosition(s.it.id, boardPos.x, boardPos.y, false);
  }

  // Build the edge list + a degree count for node sizing. Boards count
  // nesting + satellite-spoke edges (a board with many children/items
  // legitimately reads as more central); satellites only count edges that
  // actually mean something -- lines, column-group, connect -- not their
  // one always-present spoke, which isn't informative the way those are.
  const edges = [];
  const degree = new Map();
  const bump = (id) => degree.set(id, (degree.get(id) || 0) + 1);

  for (const n of boardNodes) {
    if (n.parentCanvasId && byId.has(n.parentCanvasId)) {
      edges.push({ a: n.parentCanvasId, b: n.id, rest: REST_BOARD, k: SPRING_BOARD });
      bump(n.parentCanvasId); bump(n.id);
    }
  }
  // A column child spokes to its own column (once the column is also a
  // visible satellite) instead of straight to the board -- both the
  // column and the board get their degree bumped by this, which is what
  // makes a column with several members visibly size up.
  for (const s of satellites) {
    const parentVisible = s.it.parentItemId && visibleSatIds.has(s.it.parentItemId);
    const target = parentVisible ? s.it.parentItemId : s.boardId;
    edges.push({ a: target, b: s.it.id, rest: REST_SPOKE, k: SPRING_SPOKE });
    bump(target);
  }
  const lineEdges = [];
  for (const le of rawLineEdges) {
    if (le.fromId === le.toId) continue;
    if (!visibleSatIds.has(le.fromId) || !visibleSatIds.has(le.toId)) continue;
    edges.push({ a: le.fromId, b: le.toId, rest: REST_LINE, k: SPRING_LINE });
    bump(le.fromId); bump(le.toId);
    lineEdges.push(le);
  }

  // Column-group edges: consecutive siblings (server child order, i.e.
  // it.y -- not a full pairwise mesh, which would be O(n^2) edges for a
  // larger column) chained together, rendered as a literal zigzag so
  // "these are grouped" reads as visually distinct from a real Line.
  const columnGroups = new Map(); // columnId -> its visible children
  for (const s of satellites) {
    if (!s.it.parentItemId || !visibleSatIds.has(s.it.parentItemId)) continue;
    if (!columnGroups.has(s.it.parentItemId)) columnGroups.set(s.it.parentItemId, []);
    columnGroups.get(s.it.parentItemId).push(s.it);
  }
  const groupEdges = [];
  for (const members of columnGroups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => (a.y || 0) - (b.y || 0));
    for (let i = 0; i < members.length - 1; i++) {
      const a = members[i].id, b = members[i + 1].id;
      edges.push({ a, b, rest: REST_GROUP, k: SPRING_GROUP });
      bump(a); bump(b);
      groupEdges.push({ a, b });
    }
  }

  // Connect-badge edges: prefer the specific card's satellite when it's
  // currently visible, otherwise fall back to that side's board hub --
  // unlike Line edges above, these always render with *something*, which
  // is the point: the link should show up in the map whether or not
  // you've drilled into either board.
  const connectEdges = [];
  for (const c of data.connects) {
    const fromId = (c.sourceItemId && visibleSatIds.has(c.sourceItemId)) ? c.sourceItemId : (byId.has(c.canvasId) ? c.canvasId : null);
    const toId = (c.targetItemId && visibleSatIds.has(c.targetItemId)) ? c.targetItemId : (byId.has(c.targetCanvasId) ? c.targetCanvasId : null);
    if (!fromId || !toId || fromId === toId) continue;
    edges.push({ a: fromId, b: toId, rest: REST_CONNECT, k: SPRING_CONNECT });
    bump(fromId); bump(toId);
    connectEdges.push({ a: fromId, b: toId, label: c.label, note: c.note });
  }

  const allIds = boardNodes.map(n => n.id).concat(satellites.map(s => s.it.id));
  const liveIds = new Set(allIds);
  for (const id of [...simPositions.keys()]) if (!liveIds.has(id)) simPositions.delete(id);

  const boardR = (id) => {
    const base = id === data.rootCanvasId ? NODE_R + 6 : NODE_R;
    return Math.min(base + (degree.get(id) || 0) * 2.2, base + 26);
  };
  const satR = (id) => Math.min(SAT_R + (degree.get(id) || 0) * 2, SAT_R + 14);

  const collisionR = new Map();
  for (const n of boardNodes) collisionR.set(n.id, boardR(n.id) + labelHalfWidth(n.title));
  for (const s of satellites) collisionR.set(s.it.id, satR(s.it.id) + labelHalfWidth(previewText(s.it)));

  simulate(allIds, edges, data.rootCanvasId, collisionR);
  if (myToken !== renderToken) return;

  r.svg.innerHTML = '';
  const world = document.createElementNS(SVG_NS, 'g');
  world.id = 'mmWorld';
  world.setAttribute('transform', `translate(${mmCam.x},${mmCam.y}) scale(${mmCam.scale})`);
  r.svg.appendChild(world);

  const edgeLayer = document.createElementNS(SVG_NS, 'g'); edgeLayer.setAttribute('class', 'mm-edges');
  const satEdgeLayer = document.createElementNS(SVG_NS, 'g'); satEdgeLayer.setAttribute('class', 'mm-sat-edges');
  const lineEdgeLayer = document.createElementNS(SVG_NS, 'g'); lineEdgeLayer.setAttribute('class', 'mm-line-edges');
  const groupEdgeLayer = document.createElementNS(SVG_NS, 'g'); groupEdgeLayer.setAttribute('class', 'mm-group-edges');
  const connectEdgeLayer = document.createElementNS(SVG_NS, 'g'); connectEdgeLayer.setAttribute('class', 'mm-connect-edges');
  const nodeLayer = document.createElementNS(SVG_NS, 'g'); nodeLayer.setAttribute('class', 'mm-nodes');
  const satLayer = document.createElementNS(SVG_NS, 'g'); satLayer.setAttribute('class', 'mm-sats');
  world.append(edgeLayer, satEdgeLayer, lineEdgeLayer, groupEdgeLayer, connectEdgeLayer, nodeLayer, satLayer);

  const drawLine = (layer, aId, bId, cls, titleText) => {
    const a = simPositions.get(aId), b = simPositions.get(bId);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', cls);
    if (titleText) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = titleText; line.appendChild(t); }
    layer.appendChild(line);
  };

  // A literal zigzag polyline (not just a dashed straight line) between two
  // column siblings, alternating a fixed perpendicular offset along the
  // straight path between them.
  const drawZigzag = (layer, aId, bId, cls) => {
    const a = simPositions.get(aId), b = simPositions.get(bId);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux;
    const segments = 6, amp = 7;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const bx = a.x + dx * t, by = a.y + dy * t;
      const off = (i === 0 || i === segments) ? 0 : (i % 2 === 0 ? amp : -amp);
      pts.push((bx + px * off) + ',' + (by + py * off));
    }
    const poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('class', cls);
    layer.appendChild(poly);
  };

  for (const n of boardNodes) {
    if (n.parentCanvasId && byId.has(n.parentCanvasId)) drawLine(edgeLayer, n.parentCanvasId, n.id, 'mm-edge');
  }
  for (const s of satellites) {
    const parentVisible = s.it.parentItemId && visibleSatIds.has(s.it.parentItemId);
    drawLine(satEdgeLayer, parentVisible ? s.it.parentItemId : s.boardId, s.it.id, 'mm-sat-edge');
  }
  for (const le of lineEdges) drawLine(lineEdgeLayer, le.fromId, le.toId, 'mm-line-edge');
  for (const ge of groupEdges) drawZigzag(groupEdgeLayer, ge.a, ge.b, 'mm-group-edge');
  for (const ce of connectEdges) drawLine(connectEdgeLayer, ce.a, ce.b, 'mm-connect-edge', ce.note ? ce.label + ' — ' + ce.note : ce.label);

  for (const n of boardNodes) {
    const isRoot = n.id === data.rootCanvasId;
    const r2 = boardR(n.id);
    const pos = simPositions.get(n.id);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-node' + (isRoot ? ' mm-root' : '') + (expanded.has(n.id) ? ' mm-expanded' : ''));
    g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', r2);
    circle.setAttribute('fill', colorVar(n.color || 'slate'));
    g.appendChild(circle);
    // Same icon as the board's own tile on the canvas (buildBoard in
    // cards.js), so a board reads as the same "thing" in both views.
    const icon = lucideEl(n.icon || 'layout-grid');
    const iconSize = r2 * 0.85;
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.setAttribute('x', -iconSize / 2); fo.setAttribute('y', -iconSize / 2);
    fo.setAttribute('width', iconSize); fo.setAttribute('height', iconSize);
    fo.appendChild(icon);
    g.appendChild(fo);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', r2 + 16);
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
    const sR = satR(s.it.id);
    const pos = simPositions.get(s.it.id);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'mm-sat');
    g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', sR);
    circle.setAttribute('class', 'mm-sat-circle');
    g.appendChild(circle);
    const icon = lucideEl(ICONS[s.it.type] || 'square');
    const iconSize = Math.max(14, sR * 1.4);
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.setAttribute('x', -iconSize / 2); fo.setAttribute('y', -iconSize / 2);
    fo.setAttribute('width', iconSize); fo.setAttribute('height', iconSize);
    fo.appendChild(icon);
    g.appendChild(fo);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('y', sR + 13);
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
  const wrapRect = r.wrap.getBoundingClientRect();
  r.ctx.style.left = (e.clientX - wrapRect.left) + 'px';
  r.ctx.style.top = (e.clientY - wrapRect.top) + 'px';
  r.ctx.hidden = false;
}

function closeCtx() {
  refs().ctx.hidden = true;
  ctxTarget = null;
}

// Centers the *main canvas's* camera on a world point — used instead of
// scrollIntoView() since items live inside #world's pan/zoom transform,
// which the DOM's own scroll machinery knows nothing about. Unrelated to
// mmCam above (that's this view's own camera).
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

function zoomMmBy(factor, anchorX, anchorY) {
  const r = refs();
  const rect = r.svg.getBoundingClientRect();
  const px = anchorX != null ? anchorX - rect.left : rect.width / 2;
  const py = anchorY != null ? anchorY - rect.top : rect.height / 2;
  const wx = (px - mmCam.x) / mmCam.scale, wy = (py - mmCam.y) / mmCam.scale;
  mmCam.scale = Math.max(0.2, Math.min(2.5, mmCam.scale * factor));
  mmCam.x = px - wx * mmCam.scale; mmCam.y = py - wy * mmCam.scale;
  applyMmCam();
}

function initMmCamera() {
  const r = refs();

  // Move/up listeners live on document (only while actually panning), not
  // on the svg — mirrors onItemPointerDown in drag.js. Keeps tracking the
  // drag even if the pointer leaves the svg mid-gesture (a fast drag easily
  // outruns a small viewport), which a listener scoped to the svg wouldn't.
  r.svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.mm-node, .mm-sat')) return; // let node clicks handle themselves
    panStart = { sx: e.clientX, sy: e.clientY, cx: mmCam.x, cy: mmCam.y };
    r.svg.classList.add('panning');

    const move = (ev) => {
      mmCam.x = panStart.cx + (ev.clientX - panStart.sx);
      mmCam.y = panStart.cy + (ev.clientY - panStart.sy);
      applyMmCam();
    };
    const up = () => {
      panStart = null;
      r.svg.classList.remove('panning');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  r.svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomMmBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    } else {
      mmCam.x -= e.deltaX; mmCam.y -= e.deltaY;
      applyMmCam();
    }
  }, { passive: false });

  r.zoomIn.addEventListener('click', () => zoomMmBy(1.2));
  r.zoomOut.addEventListener('click', () => zoomMmBy(1 / 1.2));
  r.zoomReset.addEventListener('click', resetMmCam);
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
      const cached = itemCache.get(canvasId);
      const it = cached && cached.items.find(x => x.id === itemId);
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
    if (itemId) navigateToItem(canvasId, itemId);
    else openCanvas(canvasId);
  });
  document.addEventListener('keydown', (e) => {
    if (r.el.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (!r.ctx.hidden) closeCtx(); else closeMindMap(); }
  });
  initMmCamera();
}
