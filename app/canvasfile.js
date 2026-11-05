'use strict';

// JSON Canvas 1.0 (https://jsoncanvas.org) export and import.
//
// Export: every card becomes a node (text, link or group) and every
// connector line an edge. Columns become groups with their cards stacked
// inside. With `nested`, a board card becomes a group holding its own
// board's contents (recursively); without it, a board card is a text node.
//
// Each node and edge also carries a small `miladash` object (type, stage,
// kind, and the original data for card types plain text can't express).
// Other JSON Canvas apps ignore unknown keys, and import uses it to bring
// the cards back as the same types.
//
// Import: groups marked as columns become columns; any other group becomes
// a nested board holding the nodes that sit inside it. Edges become lines
// when both ends land on the same board.

const { db, stmt, id, STAGES, LINE_KINDS, rowToItem } = require('./db');

// Milaclone palette -> JSON Canvas preset colours ("1".."6" = red, orange,
// yellow, green, cyan, purple); the rest go out as their hex value.
const PALETTE_HEX = {
  slate: '#565d6b', gray: '#c4c7ce', teal: '#15a39a', green: '#57bb6c',
  brown: '#b07a4f', yellow: '#f4c542', orange: '#f5862b', red: '#ef4b4b',
  pink: '#ff1f8e', purple: '#7c4dff', blue: '#4aa3ff', indigo: '#3a5bd9'
};
const TO_PRESET = { red: '1', orange: '2', yellow: '3', green: '4', teal: '5', purple: '6' };
const FROM_PRESET = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'green', 5: 'teal', 6: 'purple' };

function toCanvasColor(c) {
  if (!c) return undefined;
  return TO_PRESET[c] || PALETTE_HEX[c] || undefined;
}
function fromCanvasColor(c) {
  if (!c) return null;
  if (FROM_PRESET[c]) return FROM_PRESET[c];
  const hex = String(c).toLowerCase();
  for (const [name, h] of Object.entries(PALETTE_HEX)) if (h === hex) return name;
  return null;
}

const PAD = 20;          // inner padding of an exported group
const HEADER = 40;       // room above a group's contents for its label

function estimateHeight(it) {
  if (it.h) return it.h;
  const d = it.data || {};
  switch (it.type) {
    case 'heading': return 60;
    case 'link': return 90;
    case 'comment': return 100;
    case 'board': return 120;
    case 'todo': return 50 + 30 * ((d.tasks || []).length || 1);
    case 'image': return d.naturalW ? Math.round((it.w || 260) * d.naturalH / d.naturalW) : 180;
    case 'color': return 140;
    default: return 140;
  }
}

const stripHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();

function textFor(it, title) {
  const d = it.data || {};
  switch (it.type) {
    case 'note': return [d.title ? '# ' + d.title : '', d.body || ''].filter(Boolean).join('\n\n');
    case 'heading': return '# ' + (d.text || '');
    case 'comment': return d.body || '';
    case 'todo': {
      const tasks = (d.tasks || []).filter(t => t.text).map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`);
      return [d.title ? '## ' + d.title : '', tasks.join('\n')].filter(Boolean).join('\n\n');
    }
    case 'document': return [d.title ? '# ' + d.title : '', stripHtml(d.bodyHtml)].filter(Boolean).join('\n\n');
    case 'table': {
      const rows = d.rows || [];
      if (!rows.length) return '';
      const line = (r) => '| ' + r.map(c => String(c || '').replace(/\|/g, '\\|')).join(' | ') + ' |';
      return [line(rows[0]), '|' + rows[0].map(() => ' --- |').join(''), ...rows.slice(1).map(line)].join('\n');
    }
    case 'color': return d.hex || '';
    case 'image': return `![${d.name || 'image'}](${d.src || ''})`;
    case 'file': return `[${d.name || 'file'}](${d.src || ''})`;
    case 'board': return '**' + (title || 'Board') + '**';
    case 'connect': return d.targetLabel || 'Link to another board';
    default: return d.title || d.text || d.label || it.type;
  }
}

// Data that can't be read back out of the node text, kept in the
// `miladash` extension so a Miladash -> Miladash round trip is lossless.
const OPAQUE_TYPES = new Set(['document', 'table', 'color', 'draw', 'shape', 'image', 'file', 'connect']);

function itemsOn(canvasId) {
  return stmt.itemsForCanvas.all(canvasId).map(rowToItem);
}

// Returns { nodes, edges } in this canvas's own coordinates.
function buildCanvas(canvasId, nested, seen) {
  seen.add(canvasId);
  const items = itemsOn(canvasId);
  const ids = new Set(items.map(i => i.id));
  const nodes = [];
  const edges = [];
  const emitted = new Set();

  const base = (it, extra) => {
    const n = {
      id: it.id, type: 'text',
      x: Math.round(it.x || 0), y: Math.round(it.y || 0),
      width: Math.round(it.w || 240), height: Math.round(estimateHeight(it))
    };
    const color = toCanvasColor(it.color);
    if (color) n.color = color;
    const md = { type: it.type };
    if (it.stage) md.stage = it.stage;
    if (OPAQUE_TYPES.has(it.type) || it.type === 'heading') md.data = it.data;
    if (it.data && it.data.tags && it.data.tags.length) md.tags = it.data.tags;
    if (it.data && it.data.promoted) md.promoted = it.data.promoted;
    n.miladash = md;
    return Object.assign(n, extra);
  };

  const leaf = (it, at) => {
    if (it.type === 'link') {
      return base(it, Object.assign({ type: 'link', url: it.data.url || '' }, at));
    }
    let title;
    if (it.type === 'board') {
      const child = it.data.childCanvasId ? stmt.getCanvas.get(it.data.childCanvasId) : null;
      title = child ? child.title : 'Board';
      const n = base(it, Object.assign({ text: textFor(it, title) }, at));
      n.miladash.title = title;
      if (child && child.icon) n.miladash.icon = child.icon;
      return n;
    }
    return base(it, Object.assign({ text: textFor(it) }, at));
  };

  for (const it of items) {
    if (it.type === 'line' || (it.parentItemId && ids.has(it.parentItemId))) continue;

    if (it.type === 'column') {
      const kids = items.filter(k => k.parentItemId === it.id).sort((a, b) => (a.y || 0) - (b.y || 0));
      const w = Math.round(it.w || 280);
      const group = base(it, { type: 'group', label: it.data.title || 'Column' });
      nodes.push(group);
      emitted.add(it.id);
      let y = group.y + HEADER;
      for (const k of kids) {
        const n = leaf(k, { x: group.x + PAD, y, width: w - 2 * PAD });
        nodes.push(n); emitted.add(k.id);
        y += n.height + PAD / 2;
      }
      group.width = w;
      group.height = Math.max(120, y - group.y + PAD / 2);
      continue;
    }

    const childId = it.type === 'board' && it.data.childCanvasId;
    if (nested && childId && !seen.has(childId) && stmt.getCanvas.get(childId)) {
      const child = stmt.getCanvas.get(childId);
      const sub = buildCanvas(childId, nested, seen);
      const group = base(it, { type: 'group', label: child.title });
      group.miladash.title = child.title;
      if (child.icon) group.miladash.icon = child.icon;
      if (sub.nodes.length) {
        const minX = Math.min(...sub.nodes.map(n => n.x)), minY = Math.min(...sub.nodes.map(n => n.y));
        const maxX = Math.max(...sub.nodes.map(n => n.x + n.width)), maxY = Math.max(...sub.nodes.map(n => n.y + n.height));
        const dx = group.x + PAD - minX, dy = group.y + HEADER - minY;
        for (const n of sub.nodes) { n.x += dx; n.y += dy; }
        group.width = Math.max(group.width, maxX - minX + 2 * PAD);
        group.height = maxY - minY + HEADER + PAD;
        // Remember where the child board's own origin went, so import can
        // put its cards back at their original coordinates.
        group.miladash.origin = { x: minX, y: minY };
      }
      nodes.push(group, ...sub.nodes);
      edges.push(...sub.edges);
      emitted.add(it.id);
      continue;
    }

    nodes.push(leaf(it));
    emitted.add(it.id);
  }

  for (const line of items.filter(i => i.type === 'line')) {
    const d = line.data || {};
    if (!emitted.has(d.fromId) || !emitted.has(d.toId)) continue;
    const e = { id: line.id, fromNode: d.fromId, toNode: d.toId, toEnd: 'arrow' };
    if (d.label) e.label = d.label;
    const color = toCanvasColor(line.color);
    if (color && line.color !== 'slate') e.color = color;
    e.miladash = { kind: d.kind || 'relates' };
    edges.push(e);
  }
  return { nodes, edges };
}

function exportCanvas(canvasId, { nested = false } = {}) {
  const canvas = stmt.getCanvas.get(canvasId);
  if (!canvas) return null;
  const { nodes, edges } = buildCanvas(canvasId, nested, new Set());
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseText(text) {
  const s = String(text || '');
  const m = s.match(/^#{1,6}\s+(.+?)\s*(?:\n+|$)([\s\S]*)$/);
  return m ? { title: m[1], body: m[2].trim() } : { title: '', body: s };
}

function dataFromNode(n) {
  const md = n.miladash || {};
  let type = md.type || (n.type === 'link' ? 'link' : 'note');
  let data;
  const text = n.text || (n.type === 'file' ? String(n.file || '') : '');
  switch (type) {
    case 'link': data = { url: n.url || '', title: md.title || '' }; if (n.type !== 'link') type = 'note'; break;
    case 'heading': data = Object.assign({}, md.data || {}, { text: text.replace(/^#{1,6}\s+/, '') }); break;
    case 'comment': data = { body: text }; break;
    case 'todo': {
      const p = parseText(text);
      const tasks = [];
      let i = 0;
      for (const l of (p.body || '').split('\n')) {
        const t = l.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
        if (t) tasks.push({ id: 't' + (i++) + Math.random().toString(36).slice(2, 7), text: t[2], done: t[1] !== ' ' });
      }
      data = { title: p.title, tasks };
      break;
    }
    case 'board': data = { title: md.title || text.replace(/\*\*/g, '') || 'Board' }; break;
    case 'note': { const p = parseText(text); data = { title: p.title, body: p.body }; break; }
    default:
      if (md.data && OPAQUE_TYPES.has(type) && type !== 'connect') data = md.data;
      else { type = 'note'; const p = parseText(text); data = { title: p.title, body: p.body }; }
  }
  if (Array.isArray(md.tags)) data.tags = md.tags;
  if (md.promoted) data.promoted = md.promoted;
  if (md.icon && type === 'board') data.icon = md.icon;
  return { type, data };
}

const contains = (g, n) => n !== g &&
  n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;

function validate(doc) {
  if (!doc || typeof doc !== 'object') return 'not a JSON object';
  const nodes = doc.nodes || [];
  const edges = doc.edges || [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return 'nodes and edges must be arrays';
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !['text', 'link', 'group', 'file'].includes(n.type)) return 'bad node';
    for (const k of ['x', 'y', 'width', 'height']) if (typeof n[k] !== 'number' || !isFinite(n[k])) return `node ${n.id} needs a numeric ${k}`;
  }
  for (const e of edges) {
    if (!e || typeof e.fromNode !== 'string' || typeof e.toNode !== 'string') return 'bad edge';
  }
  if (nodes.length > 5000) return 'too many nodes';
  return null;
}

// Creates a new board card on `parentCanvasId` holding the imported canvas.
// Returns the new board item row.
function importCanvas(doc, { parentCanvasId, title = 'Imported board', x = 60, y = 60 }) {
  const nodes = (doc.nodes || []).map(n => Object.assign({}, n));
  const edges = doc.edges || [];

  // Each node's parent is the smallest group that fully contains it.
  const groups = nodes.filter(n => n.type === 'group').sort((a, b) => a.width * a.height - b.width * b.height);
  for (const n of nodes) {
    n._parent = groups.find(g => contains(g, n)) || null;
  }

  const now = Date.now();
  let z = Math.max(0, stmt.maxZ.get().m || 0);
  const placed = new Map(); // node id -> { itemId, canvasId }

  const newCanvas = (t, parent, color, icon) => {
    const cid = id('c_');
    stmt.insertCanvas.run({ id: cid, title: String(t || 'Board').slice(0, 200), parentCanvasId: parent, color: color || 'slate', icon: icon || 'layout-grid', createdAt: now });
    return cid;
  };
  const insert = (row) => {
    const item = Object.assign({
      id: id('i_'), parentItemId: null, h: null, color: null, stage: null, createdAt: now, z: ++z
    }, row);
    stmt.insertItem.run(Object.assign({}, item, { data: JSON.stringify(item.data || {}) }));
    return item;
  };
  const stageOf = (n) => (n.miladash && STAGES.includes(n.miladash.stage)) ? n.miladash.stage : null;

  // Place `members` (nodes whose parent is `owner`) onto canvasId, with
  // (ox, oy) subtracted from their coordinates.
  const placeOn = (canvasId, owner, ox, oy) => {
    const members = nodes.filter(n => n._parent === owner);
    for (const n of members) {
      const md = n.miladash || {};
      const color = fromCanvasColor(n.color);
      const pos = { x: Math.round(n.x - ox), y: Math.round(n.y - oy), w: Math.round(n.width) };
      if (n.type === 'group' && md.type === 'column') {
        const col = insert(Object.assign({ canvasId, type: 'column', color, data: { title: n.label || '' } }, pos));
        placed.set(n.id, { itemId: col.id, canvasId });
        const kids = nodes.filter(k => k._parent === n).sort((a, b) => a.y - b.y);
        kids.forEach((k, i) => {
          if (k.type === 'group') return; // nested groups inside a column are flattened away
          const { type, data } = dataFromNode(k);
          const kid = insert({ canvasId, parentItemId: col.id, type: type === 'board' ? 'note' : type, x: 0, y: i, w: Math.round(k.width), color: fromCanvasColor(k.color), stage: stageOf(k), data });
          placed.set(k.id, { itemId: kid.id, canvasId });
        });
        continue;
      }
      if (n.type === 'group') {
        const childId = newCanvas(md.title || n.label || 'Group', canvasId, color, md.icon);
        const board = insert(Object.assign({ canvasId, type: 'board', color, stage: stageOf(n), data: { childCanvasId: childId } }, pos));
        placed.set(n.id, { itemId: board.id, canvasId });
        const origin = md.origin || { x: PAD, y: HEADER };
        placeOn(childId, n, n.x + PAD - origin.x, n.y + HEADER - origin.y);
        continue;
      }
      const { type, data } = dataFromNode(n);
      if (type === 'board') {
        const childId = newCanvas(data.title, canvasId, color, data.icon);
        const board = insert(Object.assign({ canvasId, type: 'board', color, stage: stageOf(n), data: { childCanvasId: childId } }, pos));
        placed.set(n.id, { itemId: board.id, canvasId });
        continue;
      }
      const it = insert(Object.assign({ canvasId, type, color, stage: stageOf(n), data }, pos));
      placed.set(n.id, { itemId: it.id, canvasId });
    }
  };

  let boardItem;
  db.transaction(() => {
    const rootChild = newCanvas(title, parentCanvasId, 'slate', 'layers');
    boardItem = insert({ canvasId: parentCanvasId, type: 'board', x: Math.round(x), y: Math.round(y), w: 240, data: { childCanvasId: rootChild } });
    placeOn(rootChild, null, 0, 0);
    for (const e of edges) {
      const a = placed.get(e.fromNode), b = placed.get(e.toNode);
      if (!a || !b || a.canvasId !== b.canvasId) continue;
      const kind = e.miladash && LINE_KINDS.includes(e.miladash.kind) ? e.miladash.kind : 'relates';
      const data = { fromId: a.itemId, toId: b.itemId, kind };
      if (e.label) data.label = String(e.label);
      insert({ canvasId: a.canvasId, type: 'line', x: 0, y: 0, w: 0, color: fromCanvasColor(e.color) || 'slate', data });
    }
  })();
  return boardItem;
}

module.exports = { exportCanvas, importCanvas, validate, toCanvasColor, fromCanvasColor };
