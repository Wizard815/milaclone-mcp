'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  db, stmt, id, rootCanvasId, getSettings, setSettings, STAGES, LINE_KINDS,
  rowToItem, rowToCanvas, breadcrumb, itemsForCanvas, deleteItemDeep, likeEscape
} = require('./db');
const canvasFile = require('./canvasfile');
const panels = require('./panels');
const { copyItem, copyCanvasContents } = require('./copy');

// stage: one of STAGES, or null for "not in the pipeline".
const badStage = (v) => v !== undefined && v !== null && !STAGES.includes(v);
// A connector line's kind lives in data.kind (relates | depends | became).
const badLineKind = (type, data) => type === 'line' && data && data.kind !== undefined && !LINE_KINDS.includes(data.kind);

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BOARD_ICONS = [
  'layout-grid', 'book-open', 'monitor', 'clock', 'heart', 'house', 'lightbulb',
  'palette', 'briefcase', 'sparkles', 'glasses', 'landmark', 'compass', 'camera',
  'music', 'pen-tool', 'layers', 'folder', 'star', 'zap', 'globe', 'cpu', 'leaf', 'target'
];
const randomBoardIcon = () => BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];

// Same preview-text rule the client uses (connect.js/mindmap.js) -- kept in
// sync by hand since there's no shared module between server and client code.
function previewTextFor(it) {
  const d = it.data || {};
  return d.title || d.text || (d.body && d.body.slice(0, 40)) || d.url || it.type;
}

// A connect badge's label used to be frozen at creation time (whatever the
// source/target were called then), so renaming either side left it stale --
// same class of problem `_childTitle` below already solves for board tiles
// by resolving the live canvas on every read instead of storing a copy.
// Resolves the *current* source/target names the same way; falls back to
// the originally-stored label if either side has since been deleted, so a
// dangling badge still shows something instead of "undefined".
function liveConnectLabel(it) {
  const source = it.data.sourceItemId ? stmt.getItem.get(it.data.sourceItemId) : null;
  const sourcePreview = source ? previewTextFor(rowToItem(source)) : null;

  const targetCanvas = it.data.targetCanvasId ? stmt.getCanvas.get(it.data.targetCanvasId) : null;
  if (!targetCanvas) return it.data.targetLabel;

  let targetSide = targetCanvas.title;
  if (it.data.targetItemId) {
    const target = stmt.getItem.get(it.data.targetItemId);
    if (!target) return it.data.targetLabel;
    targetSide = previewTextFor(rowToItem(target));
  }

  if (sourcePreview) return `${sourcePreview} → ${targetSide}`;
  return it.data.targetItemId ? `${targetCanvas.title} → ${targetSide}` : targetSide;
}

const ALLOWED_UPLOAD = (mime) =>
  /^image\//.test(mime) ||
  /^text\//.test(mime) ||
  mime === 'application/pdf' ||
  mime === 'application/msword' ||
  mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
  mime === 'application/vnd.ms-excel' ||
  mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
  mime === 'application/vnd.ms-powerpoint' ||
  mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
  mime === 'application/zip' ||
  mime === 'application/json';

const router = express.Router();

// ---- API key auth -----------------------------------------------------------
// Set API_KEY in the environment to require every /api/* request (except the
// unauthenticated health check) to present it via the `X-API-Key` header or an
// `Authorization: Bearer <key>` header. Leave API_KEY unset to keep the API
// open, as before (fine when the app is only reachable over Tailscale).
const API_KEY = (process.env.API_KEY || '').trim();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.use((req, res, next) => {
  if (!API_KEY || req.path === '/api/health') return next();
  const header = req.get('Authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = req.get('X-API-Key') || bearer;
  if (provided && timingSafeEqual(provided, API_KEY)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, id('img_') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_UPLOAD(file.mimetype))
});

// ---- Settings ----------------------------------------------------------------
// One JSON blob for the whole app (theme default, accent color, CalDAV sync).
// The CalDAV password is never echoed back over GET -- callers see
// `passwordSet` instead and can PATCH a new caldav.password to replace it;
// omitting it (or sending '') on PATCH leaves the stored password untouched.
router.get('/api/settings', (req, res) => {
  const settings = getSettings();
  const caldav = settings.caldav
    ? { ...settings.caldav, password: undefined, passwordSet: !!settings.caldav.password }
    : null;
  res.json({ ...settings, caldav });
});

router.patch('/api/settings', (req, res) => {
  const { theme, look, accent, caldav } = req.body || {};
  const patch = {};
  if (theme !== undefined) patch.theme = theme;
  if (look !== undefined) patch.look = ['classic', 'night', 'parchment'].includes(look) ? look : 'classic';
  if (accent !== undefined) patch.accent = accent;
  if (caldav !== undefined) {
    const prev = getSettings().caldav || {};
    patch.caldav = caldav === null ? null : {
      url: caldav.url ?? prev.url ?? '',
      username: caldav.username ?? prev.username ?? '',
      password: caldav.password || prev.password || ''
    };
  }
  const settings = setSettings(patch);
  const outCaldav = settings.caldav
    ? { ...settings.caldav, password: undefined, passwordSet: !!settings.caldav.password }
    : null;
  res.json({ ...settings, caldav: outCaldav });
});

// ---- Canvas ----------------------------------------------------------------
router.get('/api/root', (req, res) => res.json({ rootCanvasId: rootCanvasId() }));

router.get('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = itemsForCanvas(canvas.id).map(it => {
    if (it.type === 'board' && it.data && it.data.childCanvasId) {
      const child = stmt.getCanvas.get(it.data.childCanvasId);
      const count = stmt.childCount.get(it.data.childCanvasId).c;
      return Object.assign({}, it, {
        _childTitle: child ? child.title : 'Board',
        _childCount: count,
        _childColor: child ? child.color : 'slate',
        _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid'
      });
    }
    if (it.type === 'connect') {
      return Object.assign({}, it, { _liveLabel: liveConnectLabel(it) });
    }
    return it;
  });
  panels.annotate(items);
  res.json({ canvas: rowToCanvas(canvas), items, breadcrumb: breadcrumb(canvas.id) });
});

router.patch('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const { title, color, icon } = req.body || {};
  if (typeof title === 'string') canvas.title = title.slice(0, 200);
  if (typeof color === 'string') canvas.color = color;
  if (typeof icon === 'string') canvas.icon = icon;
  stmt.updateCanvas.run(canvas);
  res.json(rowToCanvas(canvas));
});

// ---- Items -----------------------------------------------------------------
router.post('/api/item', (req, res) => {
  const b = req.body || {};
  if (!stmt.getCanvas.get(b.canvasId)) return res.status(400).json({ error: 'bad canvasId' });
  if (badStage(b.stage)) return res.status(400).json({ error: 'stage must be one of ' + STAGES.join(', ') + ' or null' });
  if (badLineKind(b.type, b.data)) return res.status(400).json({ error: 'line kind must be one of ' + LINE_KINDS.join(', ') });

  if (b.type === 'panel') {
    b.data = Object.assign({ title: 'Panel', shape: 'rounded' }, b.data || {});
    if (!panels.SHAPES.includes(b.data.shape)) return res.status(400).json({ error: 'panel shape must be one of ' + panels.SHAPES.join(', ') });
    b.w = b.w || panels.DEFAULT_PANEL.w;
    b.h = b.h || panels.DEFAULT_PANEL.h;
  }

  const item = {
    id: id('i_'),
    canvasId: b.canvasId,
    parentItemId: b.parentItemId || null,
    type: b.type || 'note',
    x: Math.round(Number.isFinite(b.x) ? b.x : 60),
    y: Math.round(Number.isFinite(b.y) ? b.y : 60),
    w: Math.round(b.w || 240),
    h: b.h != null ? Math.round(b.h) : null,
    z: b.type === 'panel' ? 0 : Math.max(0, stmt.maxZ.get().m || 0) + 1,
    color: b.color || null,
    data: b.data || {},
    stage: b.stage || null,
    createdAt: Date.now()
  };
  item.updatedAt = item.createdAt;

  db.transaction(() => {
    // A board item owns a freshly created child canvas.
    if (item.type === 'board') {
      const childId = id('c_');
      const icon = (item.data && item.data.icon) || randomBoardIcon();
      stmt.insertCanvas.run({
        id: childId,
        title: item.data.title || 'Untitled board',
        parentCanvasId: item.canvasId,
        color: item.color || 'slate',
        icon,
        createdAt: Date.now()
      });
      item.data = { childCanvasId: childId };
    }
    stmt.insertItem.run(Object.assign({}, item, { data: JSON.stringify(item.data) }));
  })();

  if (item.type === 'board' && item.data.childCanvasId) {
    const child = stmt.getCanvas.get(item.data.childCanvasId);
    Object.assign(item, {
      _childTitle: child ? child.title : 'Board',
      _childCount: 0,
      _childColor: child ? child.color : 'slate',
      _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid'
    });
  }

  res.json(item.type === 'panel' ? annotateOne(item) : item);
});

// Panel/member annotations for a single item (needs its whole canvas to know).
function annotateOne(item) {
  const all = itemsForCanvas(item.canvasId).map(x => x.id === item.id ? item : x);
  if (!all.includes(item)) all.push(item);
  panels.annotate(all);
  return item;
}

router.get('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  if (it.type === 'board' && it.data && it.data.childCanvasId) {
    const child = stmt.getCanvas.get(it.data.childCanvasId);
    const count = stmt.childCount.get(it.data.childCanvasId).c;
    Object.assign(it, {
      _childTitle: child ? child.title : 'Board',
      _childCount: count,
      _childColor: child ? child.color : 'slate',
      _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid'
    });
  }
  res.json(annotateOne(it));
});

router.patch('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  const b = req.body || {};
  if (it.type === 'panel' && b.data && b.data.shape !== undefined && !panels.SHAPES.includes(b.data.shape)) {
    return res.status(400).json({ error: 'panel shape must be one of ' + panels.SHAPES.join(', ') });
  }
  // Moving a panel carries everything inside it (unless moveMembers: false).
  // Membership is read from where things are *before* the move.
  let carried = [], dx = 0, dy = 0;
  const priorMembers = it.type === 'panel' ? new Set(panels.allMembers(it, itemsForCanvas(it.canvasId)).map(m => m.id)) : new Set();
  if (it.type === 'panel' && b.moveMembers !== false && (b.x != null || b.y != null)) {
    dx = b.x != null ? Math.round(b.x) - it.x : 0;
    dy = b.y != null ? Math.round(b.y) - it.y : 0;
    if (dx || dy) carried = panels.allMembers(it, itemsForCanvas(it.canvasId));
  }
  if (badStage(b.stage)) return res.status(400).json({ error: 'stage must be one of ' + STAGES.join(', ') + ' or null' });
  if (badLineKind(it.type, b.data)) return res.status(400).json({ error: 'line kind must be one of ' + LINE_KINDS.join(', ') });
  for (const k of ['x', 'y', 'w', 'h', 'z']) {
    if (b[k] != null) it[k] = Math.round(b[k]);
  }
  if (b.stage !== undefined) it.stage = b.stage || null;
  if (b.data !== undefined || b.stage !== undefined || b.color !== undefined) it.updatedAt = Date.now();
  if (b.color !== undefined) it.color = b.color;
  if (b.parentItemId !== undefined) it.parentItemId = b.parentItemId;
  if (b.canvasId && stmt.getCanvas.get(b.canvasId)) it.canvasId = b.canvasId;
  if (b.data && typeof b.data === 'object') it.data = Object.assign({}, it.data, b.data);

  const isBoard = it.type === 'board' && it.data && it.data.childCanvasId;
  db.transaction(() => {
    if (b.color !== undefined && isBoard) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) { c.color = b.color; stmt.updateCanvas.run(c); }
    }
    // keep nested board canvas title/icon in sync with the card
    if (isBoard && b.data && (b.data.title != null || b.data.icon != null)) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) {
        if (b.data.title != null) c.title = String(b.data.title).slice(0, 200);
        if (b.data.icon != null) c.icon = String(b.data.icon);
        stmt.updateCanvas.run(c);
      }
      // store title/icon only on the canvas; card reads them from there
      delete it.data.title;
      delete it.data.icon;
    }
    stmt.updateItemContent.run({
      id: it.id,
      canvasId: it.canvasId,
      parentItemId: it.parentItemId ?? null,
      x: it.x, y: it.y, w: it.w, h: it.h ?? null, z: it.z,
      color: it.color ?? null,
      data: JSON.stringify(it.data),
      stage: it.stage,
      updatedAt: it.updatedAt ?? it.createdAt
    });
    for (const m of carried) {
      stmt.updateItem.run({
        id: m.id, canvasId: m.canvasId, parentItemId: m.parentItemId ?? null,
        x: m.x + dx, y: m.y + dy, w: m.w, h: m.h ?? null, z: m.z,
        color: m.color ?? null, data: JSON.stringify(m.data)
      });
    }
  })();

  const out = it.type === 'panel' ? annotateOne(it) : it;
  if (carried.length) out._moved = carried.map(m => m.id);
  // After a move/resize, cards that weren't in the panel before but lie inside
  // it now (it slid over a neighbour) are members too -- flag that.
  if (it.type === 'panel' && (dx || dy || b.w != null || b.h != null)) {
    const before = new Set(carried.map(m => m.id));
    const fresh = (out._memberIds || []).filter(m => !before.has(m) && !priorMembers.has(m));
    if (fresh.length) out._warning = `${fresh.length} card(s) not previously in this panel now lie inside its area and count as members: ${fresh.join(', ')}. Move the panel elsewhere or move those cards out if that's unintended.`;
  }
  res.json(out);
});

// Bulk position update (used after multi-select drags / reflows)
router.patch('/api/items', (req, res) => {
  const updates = (req.body && req.body.updates) || [];
  db.transaction(() => {
    for (const u of updates) {
      const row = stmt.getItem.get(u.id);
      if (!row) continue;
      const it = rowToItem(row);
      for (const k of ['x', 'y', 'w', 'h', 'z']) if (u[k] != null) it[k] = Math.round(u[k]);
      if (u.parentItemId !== undefined) it.parentItemId = u.parentItemId;
      stmt.updateItem.run({
        id: it.id,
        canvasId: it.canvasId,
        parentItemId: it.parentItemId ?? null,
        x: it.x, y: it.y, w: it.w, h: it.h ?? null, z: it.z,
        color: it.color ?? null,
        data: JSON.stringify(it.data)
      });
    }
  })();
  res.json({ ok: true });
});

router.delete('/api/item/:id', (req, res) => {
  if (!stmt.getItem.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const batchTs = id('del_');
  db.transaction(() => deleteItemDeep(req.params.id, new Set(), batchTs))();
  res.json({ ok: true });
});

// Undoes a board deletion: a board (and everything nested under it, however
// deep) was soft-deleted as one batch keyed by its own item id's deletedAt
// marker, so restoring is just clearing deletedAt everywhere that marker was
// stamped. Non-board deletions don't go through here — those are undone
// client-side via plain recreate, since they're actually gone from the DB.
router.post('/api/item/:id/restore', (req, res) => {
  const row = stmt.getItemAny.get(req.params.id);
  if (!row || row.deletedAt == null) return res.status(404).json({ error: 'not found' });
  const batchTs = row.deletedAt;
  db.transaction(() => {
    stmt.restoreItemsByBatch.run(batchTs);
    stmt.restoreCanvasesByBatch.run(batchTs);
  })();
  const restored = rowToItem(stmt.getItem.get(req.params.id));
  if (restored.type === 'board' && restored.data.childCanvasId) {
    const child = stmt.getCanvas.get(restored.data.childCanvasId);
    const count = stmt.childCount.get(restored.data.childCanvasId).c;
    Object.assign(restored, {
      _childTitle: child ? child.title : 'Board',
      _childCount: count,
      _childColor: child ? child.color : 'slate',
      _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid'
    });
  }
  res.json(restored);
});

// ---- Panels ------------------------------------------------------------
// Panels are background regions that group the cards inside them -- see
// panels.js. These routes are the convenient way to work with them in bulk.
const previewOf = (it) => ({ id: it.id, type: it.type, preview: String(previewTextFor(it)).slice(0, 60) });

// Every panel on a board with its members (any depth of nesting is flattened
// to direct membership: a card lists under the smallest panel holding it).
router.get('/api/canvas/:id/panels', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = panels.annotate(itemsForCanvas(canvas.id));
  const byId = new Map(items.map(i => [i.id, i]));
  const list = items.filter(panels.isPanel).map(p => ({
    id: p.id, title: p.data.title || 'Panel', shape: p.data.shape || 'rounded', color: p.color,
    x: p.x, y: p.y, w: p.w, h: p.h, parentPanelId: p._panelId || null,
    members: p._memberIds.map(mid => previewOf(byId.get(mid)))
  }));
  const ungrouped = items.filter(i => !panels.isPanel(i) && i.type !== 'line' && !i.parentItemId && !i._panelId).map(previewOf);
  res.json({ canvasId: canvas.id, panels: list, ungrouped });
});

// Wraps existing cards in a new panel sized to fit them. Nothing moves.
router.post('/api/canvas/:id/panels/group', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const ids = Array.isArray(b.itemIds) ? b.itemIds : [];
  if (!ids.length) return res.status(400).json({ error: 'itemIds is required' });
  const items = ids.map(i => stmt.getItem.get(i)).filter(Boolean).map(rowToItem);
  if (items.length !== ids.length) return res.status(404).json({ error: 'some itemIds were not found' });
  const bad = items.find(i => i.canvasId !== canvas.id || i.parentItemId || i.type === 'line');
  if (bad) return res.status(400).json({ error: `item ${bad.id} must be a free card on this board (not a line, and not inside a column -- pass the column instead)` });
  const box = panels.boundsFor(items, { padding: Number.isFinite(b.padding) ? b.padding : 40 });
  const shape = panels.SHAPES.includes(b.shape) ? b.shape : 'rounded';
  const panel = {
    id: id('i_'), canvasId: canvas.id, parentItemId: null, type: 'panel',
    x: box.x, y: box.y, w: box.w, h: box.h, z: 0, color: b.color || 'slate',
    data: { title: String(b.title || 'Panel').slice(0, 200), shape }, stage: null, createdAt: Date.now()
  };
  panel.updatedAt = panel.createdAt;
  stmt.insertItem.run(Object.assign({}, panel, { data: JSON.stringify(panel.data) }));
  const all = itemsForCanvas(canvas.id);
  panels.annotate(all);
  const out = all.find(i => i.id === panel.id);
  // The box wraps a rectangle, so unrelated cards lying between the chosen
  // ones end up inside it too -- say so rather than grouping them silently.
  const extra = out._memberIds.filter(m => !ids.includes(m));
  if (extra.length) out._warning = `${extra.length} other card(s) also lie inside this panel's area and are now members: ${extra.join(', ')}. Move them out or use a tighter selection.`;
  res.json(out);
});

// Puts cards inside a panel. Cards already inside stay put; others are laid
// out in rows in the panel's free space (below the header), without resizing.
router.post('/api/panel/:id/members', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row || row.type !== 'panel') return res.status(404).json({ error: 'panel not found' });
  const panel = rowToItem(row);
  const ids = Array.isArray(req.body && req.body.itemIds) ? req.body.itemIds : [];
  if (!ids.length) return res.status(400).json({ error: 'itemIds is required' });
  const items = ids.map(i => stmt.getItem.get(i)).filter(Boolean).map(rowToItem);
  if (items.length !== ids.length) return res.status(404).json({ error: 'some itemIds were not found' });
  const bad = items.find(i => i.canvasId !== panel.canvasId || i.parentItemId || i.type === 'line' || i.id === panel.id);
  if (bad) return res.status(400).json({ error: `item ${bad.id} must be a free card on the same board as the panel` });
  const GAP = 20, pad = 20, rowH = 150;
  let cx = panel.x + pad, cy = panel.y + panels.HEADER_H + pad, rowBottom = cy;
  const moves = [];
  for (const it of items) {
    if (panels.isMemberOf(panel, it)) continue;
    const w = it.w || 240;
    if (cx + w > panel.x + panel.w - pad && cx > panel.x + pad) { cx = panel.x + pad; cy = rowBottom + GAP; }
    moves.push({ it, x: cx, y: cy });
    cx += w + GAP; rowBottom = Math.max(cy + (it.h || rowH), rowBottom);
  }
  db.transaction(() => {
    for (const m of moves) {
      stmt.updateItem.run({ id: m.it.id, canvasId: m.it.canvasId, parentItemId: null, x: Math.round(m.x), y: Math.round(m.y),
        w: m.it.w, h: m.it.h ?? null, z: m.it.z, color: m.it.color ?? null, data: JSON.stringify(m.it.data) });
    }
  })();
  const all = itemsForCanvas(panel.canvasId);
  panels.annotate(all);
  const out = all.find(i => i.id === panel.id);
  const overflow = moves.length && moves[moves.length - 1].y + rowH > panel.y + panel.h;
  res.json({ panel: out, moved: moves.map(m => m.it.id), ...(overflow ? { warning: 'panel is too small for everything; some cards extend past its edge -- resize the panel' } : {}) });
});

// ---- Duplicate & templates ------------------------------------------------
// duplicate: deep-copies a card (a column with its cards, a board with its
// whole subtree) onto the same or another board.
router.post('/api/item/:id/duplicate', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const src = rowToItem(row);
  if (src.type === 'line') return res.status(400).json({ error: 'a line cannot be duplicated on its own; duplicate the cards it joins' });
  const b = req.body || {};
  const target = b.canvasId || src.canvasId;
  if (!stmt.getCanvas.get(target)) return res.status(400).json({ error: 'bad canvasId' });
  let newId;
  db.transaction(() => {
    newId = copyItem(src, target, {
      x: Number.isFinite(b.x) ? b.x : src.x + (target === src.canvasId ? 30 : 0),
      y: Number.isFinite(b.y) ? b.y : src.y + (target === src.canvasId ? 30 : 0),
      parentItemId: src.parentItemId && target === src.canvasId ? src.parentItemId : null
    });
  })();
  res.json(boardInfo(rowToItem(stmt.getItem.get(newId))));
});

// Templates are boards inside a board titled "Templates" on Home (created on
// first save). Saving copies a board's contents in; using one copies it out as
// a fresh board card, so a template is never edited by being used.
const TEMPLATES_TITLE = 'Templates';
function templatesCanvas(create) {
  const rootId = rootCanvasId();
  const hit = stmt.boardItemsOnCanvas.all(rootId).map(rowToItem)
    .find(i => i.data.childCanvasId && (stmt.getCanvas.get(i.data.childCanvasId) || {}).title === TEMPLATES_TITLE);
  if (hit) return hit.data.childCanvasId;
  if (!create) return null;
  const cid = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: cid, title: TEMPLATES_TITLE, parentCanvasId: rootId, color: 'indigo', icon: 'layers', createdAt: Date.now() });
    stmt.insertItem.run({ id: id('i_'), canvasId: rootId, parentItemId: null, type: 'board', x: 80, y: 900, w: 152, h: null,
      z: Math.max(0, stmt.maxZ.get().m || 0) + 1, color: 'indigo', data: JSON.stringify({ childCanvasId: cid }), stage: null, createdAt: Date.now() });
  })();
  return cid;
}

function listTemplates() {
  const tc = templatesCanvas(false);
  if (!tc) return [];
  return stmt.boardItemsOnCanvas.all(tc).map(rowToItem).filter(i => i.data.childCanvasId).map(i => {
    const c = stmt.getCanvas.get(i.data.childCanvasId);
    if (!c) return null;
    const its = itemsForCanvas(c.id);
    const counts = {};
    for (const t of its) counts[t.type] = (counts[t.type] || 0) + 1;
    return { id: c.id, name: c.title, itemCount: its.length, panels: its.filter(panels.isPanel).map(p => p.data.title || 'Panel'), types: counts };
  }).filter(Boolean);
}

router.get('/api/templates', (req, res) => res.json({ templates: listTemplates() }));

router.post('/api/templates', (req, res) => {
  const b = req.body || {};
  const src = stmt.getCanvas.get(b.fromCanvasId);
  if (!src) return res.status(404).json({ error: 'fromCanvasId: board not found' });
  const name = String(b.name || src.title || 'Template').trim().slice(0, 200) || 'Template';
  if (listTemplates().some(t => t.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: `a template named "${name}" already exists` });
  const tc = templatesCanvas(true);
  if (src.id === tc) return res.status(400).json({ error: 'cannot template the Templates board itself' });
  const cid = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: cid, title: name, parentCanvasId: tc, color: src.color || 'slate', icon: src.icon, createdAt: Date.now() });
    stmt.insertItem.run({ id: id('i_'), canvasId: tc, parentItemId: null, type: 'board', x: 60 + (stmt.childCount.get(tc).c % 5) * 190, y: 60 + Math.floor(stmt.childCount.get(tc).c / 5) * 190, w: 152, h: null,
      z: Math.max(0, stmt.maxZ.get().m || 0) + 1, color: src.color || 'slate', data: JSON.stringify({ childCanvasId: cid }), stage: null, createdAt: Date.now() });
    copyCanvasContents(src.id, cid);
  })();
  res.json(listTemplates().find(t => t.id === cid));
});

router.post('/api/templates/:id/use', (req, res) => {
  const tc = templatesCanvas(false);
  const tpl = stmt.getCanvas.get(req.params.id);
  if (!tc || !tpl || tpl.parentCanvasId !== tc) return res.status(404).json({ error: 'template not found (see GET /api/templates)' });
  const b = req.body || {};
  const target = b.canvasId || rootCanvasId();
  if (!stmt.getCanvas.get(target)) return res.status(400).json({ error: 'bad canvasId' });
  const title = String(b.title || tpl.title).slice(0, 200);
  const itemId = id('i_'), cid = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: cid, title, parentCanvasId: target, color: tpl.color || 'slate', icon: tpl.icon, createdAt: Date.now() });
    copyCanvasContents(tpl.id, cid);
    stmt.insertItem.run({ id: itemId, canvasId: target, parentItemId: null, type: 'board',
      x: Math.round(Number.isFinite(b.x) ? b.x : 60), y: Math.round(Number.isFinite(b.y) ? b.y : 60), w: 152, h: null,
      z: Math.max(0, stmt.maxZ.get().m || 0) + 1, color: tpl.color || 'slate', data: JSON.stringify({ childCanvasId: cid }), stage: null, createdAt: Date.now() });
  })();
  res.json(boardInfo(rowToItem(stmt.getItem.get(itemId))));
});

// ---- Quick notes -----------------------------------------------------------
// Every `todo` card in the tree is a Quick-notes list, wherever it sits on the
// board. The mobile Quick-notes screens read them all in one go instead of
// walking canvases; writes go back through the normal PATCH /api/item route.
router.get('/api/todos', (req, res) => {
  const lists = stmt.todoItems.all().map(rowToItem).map(it => {
    const canvas = stmt.getCanvas.get(it.canvasId);
    return {
      id: it.id,
      canvasId: it.canvasId,
      canvasTitle: canvas ? canvas.title : '',
      title: it.data.title || 'To-do',
      color: it.color || null,
      tags: Array.isArray(it.data.tags) ? it.data.tags : [],
      tasks: Array.isArray(it.data.tasks) ? it.data.tasks : [],
      createdAt: it.createdAt
    };
  });
  res.json({ rootCanvasId: rootCanvasId(), lists });
});

// ---- Upload ----------------------------------------------------------------
router.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    src: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype
  });
});

// ---- Search ------------------------------------------------------------------
// Simple LIKE scan over item JSON blobs and board titles. Fine at
// personal-notes scale; swap for FTS5 if the board grows large.
router.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  if (!q) return res.json({ items: [], boards: [] });

  const pattern = '%' + likeEscape(q) + '%';

  const items = stmt.searchItems.all(pattern, limit).map(rowToItem).map(it => {
    const canvas = stmt.getCanvas.get(it.canvasId);
    return {
      id: it.id,
      type: it.type,
      canvasId: it.canvasId,
      canvasTitle: canvas ? canvas.title : '',
      color: it.color || null,
      data: it.data,
      createdAt: it.createdAt
    };
  });

  const boards = stmt.searchCanvases.all(pattern, limit).map(c => ({
    id: c.id,
    title: c.title,
    parentCanvasId: c.parentCanvasId,
    breadcrumb: breadcrumb(c.id)
  }));

  res.json({ items, boards });
});

// ---- Graph (mind map) -------------------------------------------------------
// Every board (for the nesting tree) and every cross-board `connect` badge
// (for the links drawn over that tree), in one round trip. Board titles/
// colors and connect targets only — full item data isn't needed for a graph
// node.
router.get('/api/graph', (req, res) => {
  const canvases = stmt.allCanvases.all();
  const connects = stmt.connectItems.all().map(rowToItem).map(it => ({
    id: it.id,
    canvasId: it.canvasId,
    sourceItemId: it.data.sourceItemId || null,
    targetCanvasId: it.data.targetCanvasId,
    targetItemId: it.data.targetItemId || null,
    label: liveConnectLabel(it) || '',
    note: it.data.note || ''
  })).filter(c => c.targetCanvasId);
  res.json({ rootCanvasId: rootCanvasId(), canvases, connects });
});

// ---- Tags --------------------------------------------------------------
// Union of every item's data.tags, for the tag picker's autocomplete list.
router.get('/api/tags', (req, res) => {
  const rows = db.prepare('SELECT data FROM items WHERE deletedAt IS NULL').all();
  const seen = new Set();
  for (const r of rows) {
    try { for (const t of JSON.parse(r.data).tags || []) seen.add(t); } catch (e) { /* skip malformed row */ }
  }
  res.json({ tags: [...seen].sort() });
});

// ---- Pipeline ----------------------------------------------------------
// Every card with a stage, anywhere in the tree, newest change first. The
// Pipeline view groups them into Thought / Design / Code columns.
function boardInfo(it) {
  if (it.type !== 'board' || !it.data || !it.data.childCanvasId) return it;
  const child = stmt.getCanvas.get(it.data.childCanvasId);
  if (!child) return it;
  return Object.assign(it, {
    _childTitle: child.title,
    _childCount: stmt.childCount.get(child.id).c,
    _childColor: child.color,
    _childIcon: child.icon || 'layout-grid'
  });
}

function titleOf(it) {
  if (it.type === 'board') return it._childTitle || 'Board';
  return previewTextFor(it);
}

router.get('/api/pipeline', (req, res) => {
  const canvasTitles = new Map(stmt.allCanvases.all().map(c => [c.id, c.title]));
  const items = stmt.stagedItems.all().map(rowToItem)
    .filter(it => canvasTitles.has(it.canvasId))
    .map(boardInfo)
    .map(it => Object.assign(it, { _title: titleOf(it), _canvasTitle: canvasTitles.get(it.canvasId) }));
  res.json({ stages: STAGES, items });
});

// ---- Promote to Orb ------------------------------------------------------
// A Code-stage idea becomes a project in Pondering Orb. The browser only
// talks to this route; ORB_TOKEN stays on the server.
function orbConfig() {
  const url = (process.env.ORB_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.ORB_TOKEN || '').trim();
  return { url, token };
}

// Orb's project name is also its wiki note's file name and [[link]], so it
// refuses / \ [ ] | # ^ : * ? " < > and line breaks. Turn them into
// something readable instead of failing: "Argos: scheduler" -> "Argos - scheduler".
function orbName(title) {
  const n = String(title || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/|]/g, '-')
    .replace(/[\[\]#^*?"<>\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[.\s-]+/, '').trim().slice(0, 200);
  return n || 'Untitled idea';
}

router.get('/api/orb', (req, res) => {
  const { url, token } = orbConfig();
  res.json({ configured: !!url, url: url || null, tokenSet: !!token });
});

router.post('/api/item/:id/promote', async (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = boardInfo(rowToItem(row));
  const { url, token } = orbConfig();
  if (!url) return res.status(409).json({ error: 'ORB_URL is not set on the Miladash server, so there is no Orb to promote to.' });
  if (it.stage !== 'code') return res.status(409).json({ error: 'Only ideas at the Code stage can be promoted.' });
  if (it.data.promoted) return res.status(409).json({ error: 'Already promoted.', promoted: it.data.promoted });

  const name = orbName(titleOf(it));
  const body = it.type === 'note' ? (it.data.body || '') : (it.data.pitch || '');
  const next = String((req.body && req.body.next) || body.split('\n').find(l => l.trim()) || '').trim().slice(0, 300);

  let resp, doc;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    resp = await fetch(url + '/api/c/projects', {
      method: 'POST', headers, body: JSON.stringify({ name, next, status: 'next' }),
      signal: AbortSignal.timeout(10000)
    });
    doc = await resp.json().catch(() => ({}));
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Orb: ' + (e.message || e) });
  }
  if (!resp.ok) {
    return res.status(502).json({ error: `Orb answered ${resp.status}: ${(doc && doc.error) || 'error'}` });
  }

  // Re-read in case the card changed while Orb was answering.
  const fresh = rowToItem(stmt.getItem.get(it.id) || row);
  fresh.data = Object.assign({}, fresh.data, {
    promoted: { at: Date.now(), projectId: doc && doc.id ? String(doc.id) : null, name }
  });
  fresh.updatedAt = Date.now();
  stmt.updateItemContent.run({
    id: fresh.id, canvasId: fresh.canvasId, parentItemId: fresh.parentItemId ?? null,
    x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h ?? null, z: fresh.z,
    color: fresh.color ?? null, data: JSON.stringify(fresh.data), stage: fresh.stage, updatedAt: fresh.updatedAt
  });
  res.json({ item: boardInfo(fresh), project: doc });
});

// ---- JSON Canvas ---------------------------------------------------------
router.get('/api/canvas/:id/export', (req, res) => {
  const nested = req.query.nested === '1' || req.query.nested === 'true';
  const out = canvasFile.exportCanvas(req.params.id, { nested });
  if (!out) return res.status(404).json({ error: 'not found' });
  const canvas = stmt.getCanvas.get(req.params.id);
  const file = (canvas.title || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'board';
  res.set('Content-Disposition', `attachment; filename="${file}.canvas"`);
  res.json(out);
});

router.post('/api/canvas/:id/import', (req, res) => {
  if (!stmt.getCanvas.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const doc = b.canvas || b;
  const problem = canvasFile.validate(doc);
  if (problem) return res.status(400).json({ error: 'Not a JSON Canvas file: ' + problem });
  const item = canvasFile.importCanvas(doc, {
    parentCanvasId: req.params.id,
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : 'Imported board',
    x: Number.isFinite(b.x) ? b.x : 60,
    y: Number.isFinite(b.y) ? b.y : 60
  });
  res.json(boardInfo(rowToItem(stmt.getItem.get(item.id))));
});

router.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = router;
module.exports.orbName = orbName;
