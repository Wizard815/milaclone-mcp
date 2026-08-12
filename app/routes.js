'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  db, stmt, id, rootCanvasId,
  rowToItem, breadcrumb, itemsForCanvas, deleteItemDeep, likeEscape
} = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BOARD_ICONS = [
  'layout-grid', 'book-open', 'monitor', 'clock', 'heart', 'house', 'lightbulb',
  'palette', 'briefcase', 'sparkles', 'glasses', 'landmark', 'compass', 'camera',
  'music', 'pen-tool', 'layers', 'folder', 'star', 'zap', 'globe', 'cpu', 'leaf', 'target'
];
const randomBoardIcon = () => BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];

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
    return it;
  });
  res.json({ canvas, items, breadcrumb: breadcrumb(canvas.id) });
});

router.patch('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const { title, color, icon } = req.body || {};
  if (typeof title === 'string') canvas.title = title.slice(0, 200);
  if (typeof color === 'string') canvas.color = color;
  if (typeof icon === 'string') canvas.icon = icon;
  stmt.updateCanvas.run(canvas);
  res.json(canvas);
});

// ---- Items -----------------------------------------------------------------
router.post('/api/item', (req, res) => {
  const b = req.body || {};
  if (!stmt.getCanvas.get(b.canvasId)) return res.status(400).json({ error: 'bad canvasId' });

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
    createdAt: Date.now()
  };

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

router.patch('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  const b = req.body || {};
  for (const k of ['x', 'y', 'w', 'h', 'z']) {
    if (b[k] != null) it[k] = Math.round(b[k]);
  }
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
    stmt.updateItem.run({
      id: it.id,
      canvasId: it.canvasId,
      parentItemId: it.parentItemId ?? null,
      x: it.x, y: it.y, w: it.w, h: it.h ?? null, z: it.z,
      color: it.color ?? null,
      data: JSON.stringify(it.data)
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
  db.transaction(() => deleteItemDeep(req.params.id, new Set()))();
  res.json({ ok: true });
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
// Every board, for the nesting tree the mind-map view draws. Titles/colors
// only — full item data isn't needed for a graph node.
router.get('/api/graph', (req, res) => {
  const canvases = stmt.allCanvases.all();
  res.json({ rootCanvasId: rootCanvasId(), canvases });
});

router.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = router;
