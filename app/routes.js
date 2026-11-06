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

  const item = {
    id: id('i_'),
    canvasId: b.canvasId,
    parentItemId: b.parentItemId || null,
    type: b.type || 'note',
    x: Math.round(b.x || 60),
    y: Math.round(b.y || 60),
    w: Math.round(b.w || 240),
    h: b.h != null ? Math.round(b.h) : null,
    z: Math.max(0, stmt.maxZ.get().m || 0) + 1,
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

  res.json(item);
});

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
  res.json(it);
});

router.patch('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  const b = req.body || {};
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
  })();

  res.json(it);
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
