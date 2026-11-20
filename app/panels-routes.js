'use strict';

// Panel + template routes. Panels themselves (geometry, membership) live in
// panels.js; these are the bulk endpoints the MCP uses.

const express = require('express');
const { db, stmt, id, rootCanvasId, rowToItem, itemsForCanvas, copyItemDeep } = require('./db');
const panels = require('./panels');

const router = express.Router();

const previewOf = it => {
  const d = it.data || {};
  const p = d.title || d.text || d.url || d.name || (it.type === 'board' ? '' : it.type);
  return { id: it.id, type: it.type, preview: String(p || it.type).slice(0, 60) };
};

// ---- Panels ------------------------------------------------------------------
// Every panel on a board with its members, plus the cards in no panel.
router.get('/api/canvas/:id/panels', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = panels.annotate(itemsForCanvas(canvas.id));
  const byId = new Map(items.map(i => [i.id, i]));
  const list = items.filter(panels.isPanel).map(p => ({
    id: p.id,
    title: p.data.title || 'Panel',
    shape: p.data.shape || 'rounded',
    color: p.color,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    parentPanelId: p._panelId || null,
    members: p._memberIds.map(mid => previewOf(byId.get(mid))),
  }));
  const ungrouped = items
    .filter(i => !panels.isPanel(i) && i.type !== 'line' && !i.parentItemId && !i._panelId)
    .map(previewOf);
  res.json({ canvasId: canvas.id, panels: list, ungrouped });
});

// Free cards on the panel's own board, by id. Returns {items} or {status, error}.
function freeCards(ids, canvasId, selfId) {
  if (!ids.length) return { status: 400, error: 'itemIds is required' };
  const items = ids
    .map(i => stmt.getItem.get(i))
    .filter(Boolean)
    .map(rowToItem);
  if (items.length !== ids.length) return { status: 404, error: 'some itemIds were not found' };
  const bad = items.find(i => i.canvasId !== canvasId || i.parentItemId || i.type === 'line' || i.id === selfId);
  if (bad) {
    return {
      status: 400,
      error: `item ${bad.id} must be a free card on this board (not a line, and not inside a column -- pass the column instead)`,
    };
  }
  return { items };
}

const writeItem = it =>
  stmt.updateItem.run({
    id: it.id,
    canvasId: it.canvasId,
    parentItemId: it.parentItemId ?? null,
    type: it.type,
    x: it.x,
    y: it.y,
    w: it.w,
    h: it.h ?? null,
    z: it.z,
    color: it.color ?? null,
    data: JSON.stringify(it.data),
  });

// Wraps existing cards in a new panel sized to fit them. Nothing moves.
router.post('/api/canvas/:id/panels/group', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const ids = Array.isArray(b.itemIds) ? b.itemIds : [];
  const found = freeCards(ids, canvas.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const box = panels.boundsFor(found.items, { padding: Number.isFinite(b.padding) ? b.padding : 40 });
  const panel = {
    id: id('i_'),
    canvasId: canvas.id,
    parentItemId: null,
    type: 'panel',
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    z: 0,
    color: b.color || 'slate',
    data: {
      title: String(b.title || 'Panel').slice(0, 200),
      shape: panels.SHAPES.includes(b.shape) ? b.shape : 'rounded',
    },
    createdAt: Date.now(),
  };
  stmt.insertItem.run({ ...panel, data: JSON.stringify(panel.data) });
  const all = itemsForCanvas(canvas.id);
  panels.annotate(all);
  const out = all.find(i => i.id === panel.id);
  // The box wraps a rectangle, so unrelated cards lying between the chosen
  // ones end up inside it too -- say so rather than grouping them silently.
  const extra = out._memberIds.filter(m => !ids.includes(m));
  if (extra.length) {
    out._warning = `${extra.length} other card(s) also lie inside this panel's area and are now members: ${extra.join(', ')}. Move them out or use a tighter selection.`;
  }
  res.json(out);
});

// Puts cards inside a panel: ones already inside stay put, others are laid out
// in rows in the panel's free space (below the header). The panel never resizes.
router.post('/api/panel/:id/members', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row || row.type !== 'panel') return res.status(404).json({ error: 'panel not found' });
  const panel = rowToItem(row);
  const ids = Array.isArray(req.body && req.body.itemIds) ? req.body.itemIds : [];
  const found = freeCards(ids, panel.canvasId, panel.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const GAP = 20,
    pad = 20,
    rowH = 150;
  let cx = panel.x + pad,
    cy = panel.y + panels.HEADER_H + pad,
    rowBottom = cy;
  const moves = [];
  for (const it of found.items) {
    if (panels.isMemberOf(panel, it)) continue;
    const w = it.w || 240;
    if (cx + w > panel.x + panel.w - pad && cx > panel.x + pad) {
      cx = panel.x + pad;
      cy = rowBottom + GAP;
    }
    moves.push({ it, x: cx, y: cy });
    cx += w + GAP;
    rowBottom = Math.max(cy + (it.h || rowH), rowBottom);
  }
  db.transaction(() => {
    for (const m of moves) writeItem({ ...m.it, x: Math.round(m.x), y: Math.round(m.y) });
  })();
  const all = itemsForCanvas(panel.canvasId);
  panels.annotate(all);
  const overflow = moves.length && moves[moves.length - 1].y + rowH > panel.y + panel.h;
  res.json({
    panel: all.find(i => i.id === panel.id),
    moved: moves.map(m => m.it.id),
    ...(overflow
      ? { warning: 'panel is too small for everything; some cards extend past its edge -- resize the panel' }
      : {}),
  });
});

// ---- Templates -----------------------------------------------------------------
// A template is a board inside a board titled "Templates" on Home (the same
// convention as the app's Template tool). Saving copies a board in; using one
// copies it out as a fresh board card, so a template is never edited by use.
const TEMPLATES_TITLE = 'Templates';
const boardCardFor = canvasId =>
  stmt.itemsByCanvas
    .all(stmt.getCanvas.get(canvasId)?.parentCanvasId || '')
    .map(rowToItem)
    .find(i => i.type === 'board' && i.data.childCanvasId === canvasId);

function templatesCanvas(create) {
  const rootId = rootCanvasId();
  const hit = stmt.itemsByCanvas
    .all(rootId)
    .map(rowToItem)
    .find(
      i =>
        i.type === 'board' &&
        i.data.childCanvasId &&
        (stmt.getCanvas.get(i.data.childCanvasId) || {}).title === TEMPLATES_TITLE
    );
  if (hit) return hit.data.childCanvasId;
  if (!create) return null;
  const cid = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({
      id: cid,
      title: TEMPLATES_TITLE,
      parentCanvasId: rootId,
      color: 'indigo',
      icon: 'layers',
      createdAt: Date.now(),
    });
    stmt.insertItem.run({
      id: id('i_'),
      canvasId: rootId,
      parentItemId: null,
      type: 'board',
      x: 80,
      y: 900,
      w: 152,
      h: null,
      z: Math.max(0, stmt.maxZ.get().m || 0) + 1,
      color: 'indigo',
      data: JSON.stringify({ childCanvasId: cid }),
      createdAt: Date.now(),
    });
  })();
  return cid;
}

function listTemplates() {
  const tc = templatesCanvas(false);
  if (!tc) return [];
  return stmt.itemsByCanvas
    .all(tc)
    .map(rowToItem)
    .filter(i => i.type === 'board' && i.data.childCanvasId)
    .map(i => {
      const c = stmt.getCanvas.get(i.data.childCanvasId);
      if (!c) return null;
      const its = itemsForCanvas(c.id);
      const types = {};
      for (const t of its) types[t.type] = (types[t.type] || 0) + 1;
      return {
        id: c.id,
        name: c.title,
        itemCount: its.length,
        panels: its.filter(panels.isPanel).map(p => p.data.title || 'Panel'),
        types,
      };
    })
    .filter(Boolean);
}

// Copies the board `srcCanvasId` out as a card on `target` and renames it.
function copyBoard(srcCanvasId, target, { title, x, y }) {
  const card = boardCardFor(srcCanvasId);
  if (!card) return null;
  return db.transaction(() => {
    const newId = copyItemDeep(
      card.id,
      target,
      Math.round(Number.isFinite(x) ? x : 60),
      Math.round(Number.isFinite(y) ? y : 60)
    );
    const copy = rowToItem(stmt.getItem.get(newId));
    if (title) {
      const c = stmt.getCanvas.get(copy.data.childCanvasId);
      stmt.updateCanvas.run({ ...c, title: String(title).slice(0, 200) });
    }
    return newId;
  })();
}

const asBoard = itemId => {
  const it = rowToItem(stmt.getItem.get(itemId));
  const c = stmt.getCanvas.get(it.data.childCanvasId);
  return Object.assign(it, {
    _childTitle: c.title,
    _childCount: stmt.childCount.get(c.id).c,
    _childColor: c.color,
    _childIcon: c.icon || 'layout-grid',
  });
};

router.get('/api/templates', (req, res) => res.json({ templates: listTemplates() }));

router.post('/api/templates', (req, res) => {
  const b = req.body || {};
  const src = stmt.getCanvas.get(b.fromCanvasId);
  if (!src) return res.status(404).json({ error: 'fromCanvasId: board not found' });
  if (!boardCardFor(src.id)) return res.status(400).json({ error: 'Home has no board card and cannot be a template' });
  const name =
    String(b.name || src.title || 'Template')
      .trim()
      .slice(0, 200) || 'Template';
  if (listTemplates().some(t => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `a template named "${name}" already exists` });
  }
  const tc = templatesCanvas(true);
  if (src.id === tc) return res.status(400).json({ error: 'cannot template the Templates board itself' });
  const n = stmt.childCount.get(tc).c;
  const newId = copyBoard(src.id, tc, { title: name, x: 60 + (n % 5) * 190, y: 60 + Math.floor(n / 5) * 190 });
  res.json(listTemplates().find(t => t.id === rowToItem(stmt.getItem.get(newId)).data.childCanvasId));
});

router.post('/api/templates/:id/use', (req, res) => {
  const tc = templatesCanvas(false);
  const tpl = stmt.getCanvas.get(req.params.id);
  if (!tc || !tpl || tpl.parentCanvasId !== tc)
    return res.status(404).json({ error: 'template not found (see GET /api/templates)' });
  const b = req.body || {};
  const target = b.canvasId || rootCanvasId();
  if (!stmt.getCanvas.get(target)) return res.status(400).json({ error: 'bad canvasId' });
  res.json(asBoard(copyBoard(tpl.id, target, { title: b.title || tpl.title, x: b.x, y: b.y })));
});

// Copy any board (by canvas id) as a new board card on another board.
router.post('/api/canvas/:id/copy', (req, res) => {
  const src = stmt.getCanvas.get(req.params.id);
  if (!src) return res.status(404).json({ error: 'board not found' });
  if (!boardCardFor(src.id)) return res.status(400).json({ error: 'Home has no board card and cannot be copied' });
  const b = req.body || {};
  const target = b.canvasId || rootCanvasId();
  if (!stmt.getCanvas.get(target)) return res.status(400).json({ error: 'bad canvasId' });
  for (let c = stmt.getCanvas.get(target); c; c = c.parentCanvasId ? stmt.getCanvas.get(c.parentCanvasId) : null) {
    if (c.id === src.id)
      return res.status(400).json({ error: 'cannot copy a board into itself or one of its own sub-boards' });
  }
  res.json(asBoard(copyBoard(src.id, target, { title: b.title || src.title + ' (copy)', x: b.x, y: b.y })));
});

module.exports = router;
