'use strict';

// Miladash additions: stage field (and its migration), arrow kinds, the
// promote-to-Orb route against a fake Orb, and JSON Canvas export/import.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

// Build a pre-Miladash database (no stage/updatedAt columns) before db.js
// opens it, so requiring db.js runs the migration on real old data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miladash-test-'));
{
  const old = new Database(path.join(TMP, 'board.db'));
  old.exec(`
    CREATE TABLE canvases (id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER, icon TEXT, deletedAt TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
      x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT, data TEXT, createdAt INTEGER, deletedAt TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO canvases VALUES ('c_old', 'Home', NULL, 'slate', 1000, NULL, NULL);
    INSERT INTO meta VALUES ('rootCanvasId', 'c_old');
    INSERT INTO items VALUES ('i_old', 'c_old', NULL, 'note', 10, 20, 240, NULL, 1, 'blue', '{"title":"Old idea","body":"kept"}', 1234, NULL);
  `);
  old.close();
}
process.env.DATA_DIR = TMP;

const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(require('../routes'));

let base, server, orb, orbBase;
const orbRequests = [];
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  // Fake Orb: records every request, answers like Orb's POST /api/c/:coll.
  orb = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      orbRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      if (req.headers.authorization !== 'Bearer orb-secret') { res.writeHead(401); res.end('{"error":"Sign in first"}'); return; }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.assign({ id: 'p_42' }, JSON.parse(raw))));
    });
  });
  await new Promise(r => orb.listen(0, '127.0.0.1', r));
  orbBase = 'http://127.0.0.1:' + orb.address().port;
});
test.after(() => { server.close(); orb.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const send = (m, p, b) => fetch(base + p, {
  method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
}).then(async r => ({ status: r.status, body: await r.json() }));

test('TestStage_migration keeps existing data and adds stage/updatedAt', async () => {
  const { body } = await get('/api/item/i_old');
  assert.equal(body.data.title, 'Old idea');
  assert.equal(body.color, 'blue');
  assert.equal(body.stage, null);
  assert.equal(body.updatedAt, 1234);
});

test('TestStage_create, update, clear and validate', async () => {
  const c = await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', stage: 'thought', data: { title: 'A' } });
  assert.equal(c.status, 200);
  assert.equal(c.body.stage, 'thought');
  assert.equal((await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', stage: 'nope' })).status, 400);

  const before = c.body.updatedAt;
  await new Promise(r => setTimeout(r, 5));
  const p = await send('PATCH', '/api/item/' + c.body.id, { stage: 'design' });
  assert.equal(p.body.stage, 'design');
  assert.ok(p.body.updatedAt > before);
  // a plain move leaves updatedAt alone
  const moved = await send('PATCH', '/api/item/' + c.body.id, { x: 500 });
  assert.equal(moved.body.updatedAt, p.body.updatedAt);
  assert.equal((await send('PATCH', '/api/item/' + c.body.id, { stage: 'later' })).status, 400);
  assert.equal((await send('PATCH', '/api/item/' + c.body.id, { stage: null })).body.stage, null);
});

test('TestPipeline_lists staged cards newest first', async () => {
  const a = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', stage: 'code', data: { title: 'first' } })).body;
  await new Promise(r => setTimeout(r, 5));
  const b = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'board', stage: 'code', data: { title: 'second' } })).body;
  const { body } = await get('/api/pipeline');
  assert.deepEqual(body.stages, ['thought', 'design', 'code']);
  const ids = body.items.map(i => i.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
  const board = body.items.find(i => i.id === b.id);
  assert.equal(board._title, 'second');
  assert.equal(board._canvasTitle, 'Home');
  assert.ok(!ids.includes('i_old'));
});

test('TestLines_kind is stored and validated', async () => {
  const a = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', data: {} })).body;
  const b = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', data: {} })).body;
  const l = await send('POST', '/api/item', { canvasId: 'c_old', type: 'line', data: { fromId: a.id, toId: b.id, kind: 'depends', label: 'needs' } });
  assert.equal(l.status, 200);
  assert.equal(l.body.data.kind, 'depends');
  assert.equal((await send('POST', '/api/item', { canvasId: 'c_old', type: 'line', data: { fromId: a.id, toId: b.id, kind: 'hates' } })).status, 400);
  const p = await send('PATCH', '/api/item/' + l.body.id, { data: { kind: 'became' } });
  assert.equal(p.body.data.kind, 'became');
  assert.equal(p.body.data.label, 'needs');
  assert.equal((await send('PATCH', '/api/item/' + l.body.id, { data: { kind: 'x' } })).status, 400);
});

test('TestPromote_posts to Orb and marks the card', async () => {
  delete process.env.ORB_URL;
  assert.equal((await get('/api/orb')).body.configured, false);
  const idea = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', stage: 'design', data: { title: 'Plex dashboard', body: 'Wire up the Plex widget\nmore notes' } })).body;
  const noUrl = await send('POST', `/api/item/${idea.id}/promote`, {});
  assert.equal(noUrl.status, 409);
  assert.match(noUrl.body.error, /ORB_URL/);

  process.env.ORB_URL = orbBase + '/';
  process.env.ORB_TOKEN = 'orb-secret';
  assert.equal((await get('/api/orb')).body.configured, true);
  assert.equal((await get('/api/orb')).body.token, undefined);
  assert.equal((await send('POST', `/api/item/${idea.id}/promote`, {})).status, 409, 'design stage is refused');

  await send('PATCH', '/api/item/' + idea.id, { stage: 'code' });
  const r = await send('POST', `/api/item/${idea.id}/promote`, {});
  assert.equal(r.status, 200);
  assert.equal(orbRequests.length, 1);
  assert.deepEqual(orbRequests[0], {
    method: 'POST', url: '/api/c/projects', auth: 'Bearer orb-secret',
    body: { name: 'Plex dashboard', next: 'Wire up the Plex widget', status: 'next' }
  });
  assert.equal(r.body.item.data.promoted.projectId, 'p_42');
  assert.equal((await get('/api/item/' + idea.id)).body.data.promoted.name, 'Plex dashboard');
  assert.equal((await send('POST', `/api/item/${idea.id}/promote`, {})).status, 409, 'no double promote');

  // Orb refusing (bad token) surfaces as 502 and leaves the card alone
  process.env.ORB_TOKEN = 'wrong';
  const other = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'note', stage: 'code', data: { title: 'B' } })).body;
  const bad = await send('POST', `/api/item/${other.id}/promote`, {});
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /401/);
  assert.equal((await get('/api/item/' + other.id)).body.data.promoted, undefined);
  delete process.env.ORB_URL; delete process.env.ORB_TOKEN;
});

test('TestJsonCanvas_export/import round trip with nested boards', async () => {
  // Source board: a note with a stage, a link, a column with two cards, a
  // nested board with its own card, and a labelled depends line.
  const src = (await send('POST', '/api/item', { canvasId: 'c_old', type: 'board', data: { title: 'Source' } })).body.data.childCanvasId;
  const mk = (b) => send('POST', '/api/item', Object.assign({ canvasId: src }, b)).then(r => r.body);
  const note = await mk({ type: 'note', x: 100, y: 100, w: 240, color: 'red', stage: 'design', data: { title: 'Idea', body: 'Pitch line' } });
  const link = await mk({ type: 'link', x: 500, y: 100, data: { url: 'https://jsoncanvas.org', title: 'Spec' } });
  const col = await mk({ type: 'column', x: 100, y: 400, w: 280, data: { title: 'Box' } });
  await mk({ type: 'todo', parentItemId: col.id, y: 1, data: { title: 'Steps', tasks: [{ id: 't1', text: 'one', done: true }, { id: 't2', text: 'two', done: false }] } });
  await mk({ type: 'comment', parentItemId: col.id, y: 2, data: { body: 'hmm' } });
  const sub = await mk({ type: 'board', x: 800, y: 400, data: { title: 'Inner' } });
  await send('POST', '/api/item', { canvasId: sub.data.childCanvasId, type: 'note', x: 30, y: 40, data: { title: 'Deep', body: '' } });
  await mk({ type: 'line', data: { fromId: note.id, toId: link.id, kind: 'depends', label: 'needs spec' } });

  // Flat export: the nested board is a text node, not a group.
  const flat = await get(`/api/canvas/${src}/export`);
  assert.equal(flat.status, 200);
  assert.equal(flat.body.nodes.filter(n => n.type === 'group').length, 1); // just the column
  const flatBoard = flat.body.nodes.find(n => n.id === sub.id);
  assert.equal(flatBoard.type, 'text');

  const { body: doc } = await get(`/api/canvas/${src}/export?nested=1`);
  for (const n of doc.nodes) for (const k of ['id', 'type', 'x', 'y', 'width', 'height']) assert.ok(n[k] !== undefined, `${n.id} has ${k}`);
  const nNote = doc.nodes.find(n => n.id === note.id);
  assert.equal(nNote.type, 'text');
  assert.equal(nNote.text, '# Idea\n\nPitch line');
  assert.equal(nNote.color, '1');
  assert.equal(doc.nodes.find(n => n.id === link.id).url, 'https://jsoncanvas.org');
  const inner = doc.nodes.find(n => n.id === sub.id);
  assert.equal(inner.type, 'group');
  assert.equal(inner.label, 'Inner');
  const deep = doc.nodes.find(n => n.text === '# Deep');
  assert.ok(deep.x >= inner.x && deep.y >= inner.y && deep.x + deep.width <= inner.x + inner.width && deep.y + deep.height <= inner.y + inner.height);
  assert.equal(doc.edges.length, 1);
  assert.deepEqual({ from: doc.edges[0].fromNode, to: doc.edges[0].toNode, label: doc.edges[0].label },
    { from: note.id, to: link.id, label: 'needs spec' });

  // Import into a new board and compare.
  assert.equal((await send('POST', '/api/canvas/c_old/import', { canvas: { nodes: [{ id: 'x' }] } })).status, 400);
  const imp = await send('POST', '/api/canvas/c_old/import', { canvas: doc, title: 'Copy', x: 10, y: 10 });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.type, 'board');
  assert.equal(imp.body._childTitle, 'Copy');
  const copy = (await get('/api/canvas/' + imp.body.data.childCanvasId)).body.items;
  const byType = (t) => copy.filter(i => i.type === t);
  const cNote = byType('note')[0];
  assert.deepEqual([cNote.data.title, cNote.data.body, cNote.color, cNote.stage, cNote.x, cNote.y], ['Idea', 'Pitch line', 'red', 'design', 100, 100]);
  assert.equal(byType('link')[0].data.url, 'https://jsoncanvas.org');
  const cCol = byType('column')[0];
  assert.equal(cCol.data.title, 'Box');
  const kids = copy.filter(i => i.parentItemId === cCol.id).sort((a, b) => a.y - b.y);
  assert.deepEqual(kids.map(k => k.type), ['todo', 'comment']);
  assert.deepEqual(kids[0].data.tasks.map(t => [t.text, t.done]), [['one', true], ['two', false]]);
  const cLine = byType('line')[0];
  assert.deepEqual([cLine.data.kind, cLine.data.label, cLine.data.fromId, cLine.data.toId], ['depends', 'needs spec', cNote.id, byType('link')[0].id]);
  const cSub = byType('board')[0];
  assert.equal(cSub._childTitle, 'Inner');
  assert.deepEqual([cSub.x, cSub.y], [800, 400]);
  const deepCopy = (await get('/api/canvas/' + cSub.data.childCanvasId)).body.items;
  assert.equal(deepCopy.length, 1);
  assert.deepEqual([deepCopy[0].data.title, deepCopy[0].x, deepCopy[0].y], ['Deep', 30, 40]);
});

test('TestJsonCanvas_imports a plain Obsidian canvas', async () => {
  const doc = {
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Homelab' },
      { id: 'a', type: 'text', x: 20, y: 50, width: 200, height: 80, text: 'Just text', color: '4' },
      { id: 'b', type: 'text', x: 700, y: 50, width: 200, height: 80, text: '# Outside\nbody' },
      { id: 'f', type: 'file', x: 700, y: 300, width: 200, height: 80, file: 'Notes/x.md' }
    ],
    edges: [{ id: 'e', fromNode: 'b', toNode: 'f', label: 'see' }]
  };
  const imp = await send('POST', '/api/canvas/c_old/import', { canvas: doc });
  assert.equal(imp.status, 200);
  const items = (await get('/api/canvas/' + imp.body.data.childCanvasId)).body.items;
  const group = items.find(i => i.type === 'board');
  assert.equal(group._childTitle, 'Homelab');
  const inside = (await get('/api/canvas/' + group.data.childCanvasId)).body.items;
  assert.deepEqual([inside[0].data.body, inside[0].color], ['Just text', 'green']);
  assert.equal(items.find(i => i.type === 'note' && i.data.title === 'Outside').data.body, 'body');
  assert.equal(items.filter(i => i.type === 'line').length, 1);
});

test('promote cleans a card title into a name Orb accepts', () => {
  const { orbName } = require('../routes.js');
  assert.equal(orbName('Argos: scheduler'), 'Argos - scheduler');
  assert.equal(orbName('a/b [x] #tag'), 'a-b x tag');
  assert.equal(orbName('Line\nbreak'), 'Line break');
  assert.equal(orbName('  ..'), 'Untitled idea');
});
