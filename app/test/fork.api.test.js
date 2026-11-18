'use strict';

// This fork's own server pieces on top of upstream milaclone: the pre-Trash
// board soft-delete migration, API_KEY auth, app-wide settings, and the
// MCP server's search shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// A database from before the Trash: board B (with a nested board C and a note
// on each) was deleted as one `deletedAt` batch.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-fork-'));
{
  const old = new Database(path.join(TMP, 'board.db'));
  old.exec(`
    CREATE TABLE canvases (id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER, icon TEXT, deletedAt TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
      x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT, data TEXT, createdAt INTEGER, deletedAt TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('rootCanvasId', 'c_home');
    INSERT INTO canvases VALUES ('c_home', 'Home', NULL, 'slate', 1, NULL, NULL);
    INSERT INTO canvases VALUES ('c_b', 'Old board', 'c_home', 'slate', 2, NULL, 'del_x');
    INSERT INTO canvases VALUES ('c_c', 'Inner', 'c_b', 'slate', 3, NULL, 'del_x');
    INSERT INTO items VALUES ('i_b', 'c_home', NULL, 'board', 0, 0, 152, NULL, 1, NULL, '{"childCanvasId":"c_b"}', 2, 'del_x');
    INSERT INTO items VALUES ('i_c', 'c_b', NULL, 'board', 0, 0, 152, NULL, 1, NULL, '{"childCanvasId":"c_c"}', 3, 'del_x');
    INSERT INTO items VALUES ('i_n', 'c_c', NULL, 'note', 0, 0, 240, NULL, 1, NULL, '{"title":"deep"}', 4, 'del_x');
    INSERT INTO items VALUES ('i_live', 'c_home', NULL, 'note', 0, 0, 240, NULL, 1, NULL, '{"body":"alive"}', 5, NULL);
  `);
  old.close();
}
process.env.DATA_DIR = TMP;
process.env.API_KEY = 'sekrit';

const express = require('express');
const app = express();
app.use(require('../routes'));

let base, server;
test.before(async () => {
  await new Promise(r => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = async (method, p, body, key = 'sekrit') => {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  // oxlint-disable-next-line no-invalid-fetch-options -- GET calls pass no body
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('API_KEY guards the API (header or bearer), but not the health check', async () => {
  assert.equal((await call('GET', '/api/root', null, null)).status, 401);
  assert.equal((await call('GET', '/api/root', null, 'wrong')).status, 401);
  assert.equal((await call('GET', '/api/health', null, null)).status, 200);
  assert.equal((await call('GET', '/api/root')).body.rootCanvasId, 'c_home');
  const bearer = await fetch(base + '/api/root', { headers: { Authorization: 'Bearer sekrit' } });
  assert.equal(bearer.status, 200);
});

test('a board soft-deleted before the Trash shows up in it and restores whole', async () => {
  const trash = (await call('GET', '/api/trash')).body.items;
  assert.deepEqual(
    trash.map(t => [t.id, t.title]),
    [['i_b', 'Old board']]
  );
  assert.equal((await call('GET', '/api/canvas/c_c')).status, 404);
  assert.equal((await call('POST', '/api/item/i_b/restore')).status, 200);
  const inner = (await call('GET', '/api/canvas/c_c')).body.items;
  assert.deepEqual(
    inner.map(i => [i.id, i.data.text]),
    [['i_n', 'deep']]
  );
  // trash bookkeeping never reaches API responses
  assert.equal('trashedBy' in inner[0] || 'deletedAt' in inner[0], false);
});

test('settings: defaults, patch, and the CalDAV password is never echoed', async () => {
  const s = (await call('GET', '/api/settings')).body;
  assert.equal(s.theme, 'system');
  assert.equal(s.caldav, null);
  const p = (
    await call('PATCH', '/api/settings', {
      theme: 'dark',
      look: 'bogus',
      accent: '#123456',
      caldav: { url: 'https://dav.example', username: 'me', password: 'pw' },
    })
  ).body;
  assert.deepEqual([p.theme, p.look, p.accent], ['dark', 'classic', '#123456']);
  assert.deepEqual(p.caldav, { url: 'https://dav.example', username: 'me', passwordSet: true });
  // an empty password keeps the stored one
  const q = (await call('PATCH', '/api/settings', { look: 'night', caldav: { password: '' } })).body;
  assert.equal(q.look, 'night');
  assert.equal(q.caldav.passwordSet, true);
  assert.equal(q.caldav.url, 'https://dav.example');
  assert.equal((await call('PATCH', '/api/settings', { caldav: null })).body.caldav, null);
});

test("search answers the UI's results and the MCP server's items/boards", async () => {
  const r = (await call('GET', '/api/search?q=alive&limit=5')).body;
  assert.equal(r.results[0].id, 'i_live');
  assert.equal(r.items[0].id, 'i_live');
  assert.equal(r.items[0].canvasTitle, 'Home');
  const b = (await call('GET', '/api/search?q=Inner')).body;
  assert.equal(b.boards[0].id, 'c_c');
  assert.deepEqual((await call('GET', '/api/search?q=')).body, { results: [], items: [], boards: [] });
});

test('tags lists every live tag once, sorted', async () => {
  await call('POST', '/api/item', { canvasId: 'c_home', type: 'note', data: { body: 'x', tags: ['b', 'a'] } });
  await call('POST', '/api/item', { canvasId: 'c_home', type: 'todo', data: { title: 't', tags: ['a'] } });
  assert.deepEqual((await call('GET', '/api/tags')).body.tags, ['a', 'b']);
});

test('graph: boards and live connect badges', async () => {
  const note = (await call('POST', '/api/item', { canvasId: 'c_home', type: 'note', data: { body: 'Source card' } }))
    .body;
  await call('POST', '/api/item', {
    canvasId: 'c_home',
    type: 'connect',
    data: { sourceItemId: note.id, targetCanvasId: 'c_c', targetLabel: 'old' },
  });
  const g = (await call('GET', '/api/graph')).body;
  assert.ok(g.canvases.some(c => c.id === 'c_c'));
  assert.equal(g.connects[0].label, 'Source card → Inner');
  const canvas = (await call('GET', '/api/canvas/c_home')).body.items.find(i => i.type === 'connect');
  assert.equal(canvas._liveLabel, 'Source card → Inner');
});
