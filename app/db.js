'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'board.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Storage: a SQLite database queried directly on every request.
// ---------------------------------------------------------------------------
const id = (p = '') => p + crypto.randomBytes(9).toString('base64url');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
    x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT,
    data TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_items_canvas ON items(canvasId);
  CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentItemId);
`);

// Additive columns for existing DBs
const cols = db.prepare("PRAGMA table_info(canvases)").all().map(c => c.name);
if (!cols.includes('icon')) db.exec('ALTER TABLE canvases ADD COLUMN icon TEXT');
if (!cols.includes('deletedAt')) db.exec('ALTER TABLE canvases ADD COLUMN deletedAt TEXT');
const itemCols = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
if (!itemCols.includes('deletedAt')) db.exec('ALTER TABLE items ADD COLUMN deletedAt TEXT');

// Prepared statements (created once, reused per request).
const stmt = {
  getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getCanvas: db.prepare(`SELECT * FROM canvases WHERE id = ? AND deletedAt IS NULL`),
  getCanvasAny: db.prepare(`SELECT * FROM canvases WHERE id = ?`),
  allCanvases: db.prepare(`SELECT id, title, parentCanvasId, color, icon FROM canvases WHERE deletedAt IS NULL`),
  insertCanvas: db.prepare(`INSERT INTO canvases (id, title, parentCanvasId, color, icon, createdAt)
                            VALUES (@id, @title, @parentCanvasId, @color, @icon, @createdAt)`),
  updateCanvas: db.prepare(`UPDATE canvases SET title = @title, color = @color, icon = @icon WHERE id = @id`),
  deleteCanvas: db.prepare(`DELETE FROM canvases WHERE id = ?`),
  softDeleteCanvas: db.prepare(`UPDATE canvases SET deletedAt = ? WHERE id = ?`),
  boardItemsOnCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'board' AND deletedAt IS NULL`),
  getItem: db.prepare(`SELECT * FROM items WHERE id = ? AND deletedAt IS NULL`),
  getItemAny: db.prepare(`SELECT * FROM items WHERE id = ?`),
  itemsForCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND deletedAt IS NULL ORDER BY COALESCE(z, 0), createdAt, id`),
  itemsByParent: db.prepare(`SELECT * FROM items WHERE parentItemId = ? AND deletedAt IS NULL`),
  todoItems: db.prepare(`SELECT * FROM items WHERE type = 'todo' AND deletedAt IS NULL ORDER BY createdAt, id`),
  itemsByCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND deletedAt IS NULL`),
  maxZ: db.prepare(`SELECT MAX(z) AS m FROM items`),
  childCount: db.prepare(`SELECT COUNT(*) AS c FROM items WHERE canvasId = ? AND parentItemId IS NULL AND deletedAt IS NULL`),
  insertItem: db.prepare(`INSERT INTO items (id, canvasId, parentItemId, type, x, y, w, h, z, color, data, createdAt)
                          VALUES (@id, @canvasId, @parentItemId, @type, @x, @y, @w, @h, @z, @color, @data, @createdAt)`),
  updateItem: db.prepare(`UPDATE items SET canvasId=@canvasId, parentItemId=@parentItemId, x=@x, y=@y, w=@w, h=@h,
                          z=@z, color=@color, data=@data WHERE id=@id`),
  deleteItem: db.prepare(`DELETE FROM items WHERE id = ?`),
  softDeleteItem: db.prepare(`UPDATE items SET deletedAt = ? WHERE id = ?`),
  restoreItemsByBatch: db.prepare(`UPDATE items SET deletedAt = NULL WHERE deletedAt = ?`),
  restoreCanvasesByBatch: db.prepare(`UPDATE canvases SET deletedAt = NULL WHERE deletedAt = ?`),
  searchItems: db.prepare(`SELECT * FROM items WHERE data LIKE ? ESCAPE '\\' AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT ?`),
  searchCanvases: db.prepare(`SELECT * FROM canvases WHERE title LIKE ? ESCAPE '\\' AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT ?`)
};

// Seed a root 'Home' canvas on first run.
if (!stmt.getMeta.get('rootCanvasId')) {
  const rootId = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: rootId, title: 'Home', parentCanvasId: null, color: 'slate', icon: null, createdAt: Date.now() });
    stmt.setMeta.run('rootCanvasId', rootId);
  })();
}
function rootCanvasId() {
  return stmt.getMeta.get('rootCanvasId')?.value;
}

// App-wide settings (theme default, accent color, CalDAV credentials) live as
// one JSON blob under a single meta key -- there's only ever one settings
// object for the whole (personal, single-user) app.
const DEFAULT_SETTINGS = { theme: 'system', accent: null, starColor: null, caldav: null };
function getSettings() {
  const row = stmt.getMeta.get('settings');
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  stmt.setMeta.run('settings', JSON.stringify(next));
  return next;
}

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

// ---------------------------------------------------------------------------
// Mapping helpers: rows <-> API objects. `data` is stored as a JSON string but
// the API (and the frontend) always work with it as an object.
// ---------------------------------------------------------------------------
// `deletedAt` is internal soft-delete bookkeeping (see deleteItemDeep) —
// every row reaching here already passed a `deletedAt IS NULL` filter, so
// it'd only ever show up as a stray always-null field in API responses.
function rowToItem(row) {
  const { deletedAt, ...rest } = row;
  return Object.assign(rest, { data: row.data ? JSON.parse(row.data) : {} });
}

function rowToCanvas(row) {
  if (!row) return row;
  const { deletedAt, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function breadcrumb(canvasId) {
  const trail = [];
  let cur = stmt.getCanvas.get(canvasId);
  let guard = 0;
  while (cur && guard++ < 100) {
    trail.unshift({ id: cur.id, title: cur.title });
    cur = cur.parentCanvasId ? stmt.getCanvas.get(cur.parentCanvasId) : null;
  }
  return trail;
}

function itemsForCanvas(canvasId) {
  return stmt.itemsForCanvas.all(canvasId).map(rowToItem);
}

// Recursively collect a canvas and all canvases nested beneath it.
function collectDescendantCanvases(canvasId, acc) {
  acc.add(canvasId);
  for (const row of stmt.boardItemsOnCanvas.all(canvasId)) {
    const data = row.data ? JSON.parse(row.data) : {};
    if (data.childCanvasId && !acc.has(data.childCanvasId)) {
      collectDescendantCanvases(data.childCanvasId, acc);
    }
  }
  return acc;
}

// Recursively delete an item, its parented children, and any nested board
// subtree. Assumes it runs inside a transaction. `visited` guards against
// parent cycles. `batchTs` is an opaque per-call marker (not a real
// timestamp) — a board and everything nested under it get soft-deleted
// (deletedAt = batchTs) rather than actually removed, so the whole subtree
// can be brought back in one shot later by clearing deletedAt everywhere it
// was stamped with that marker. Everything else is still hard-deleted, same
// as before; the client's plain snapshot-and-recreate undo handles that.
function deleteItemDeep(itemId, visited, batchTs) {
  if (visited.has(itemId)) return;
  visited.add(itemId);
  const it = stmt.getItem.get(itemId);
  if (!it) return;
  // delete children parented to this item (e.g. cards inside a column)
  for (const child of stmt.itemsByParent.all(itemId)) {
    deleteItemDeep(child.id, visited, batchTs);
  }
  const data = it.data ? JSON.parse(it.data) : {};
  if (it.type === 'board' && data.childCanvasId) {
    const canvases = collectDescendantCanvases(data.childCanvasId, new Set());
    for (const cid of canvases) {
      for (const sub of stmt.itemsByCanvas.all(cid)) {
        stmt.softDeleteItem.run(batchTs, sub.id);
      }
      stmt.softDeleteCanvas.run(batchTs, cid);
    }
    stmt.softDeleteItem.run(batchTs, itemId);
    return;
  }
  stmt.deleteItem.run(itemId);
}

// Escapes %, _ and \ for a LIKE pattern using '\' as the ESCAPE character.
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

module.exports = {
  DB_FILE, db, stmt, id, rootCanvasId, getSettings, setSettings,
  rowToItem, rowToCanvas, breadcrumb, itemsForCanvas, deleteItemDeep, likeEscape
};
