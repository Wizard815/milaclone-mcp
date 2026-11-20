'use strict';

// Panels: named floating background regions; membership is positional.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const app = express();
app.use(express.json());
app.use(require('../routes'));
const panels = require('../panels');

let base, server;
test.before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const call = (m, p, b) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  .then(async r => ({ status: r.status, body: await r.json() }));
const root = async () => (await call('GET', '/api/root')).body.rootCanvasId;
const mk = async (canvasId, type, x, y, extra = {}) =>
  (await call('POST', '/api/item', { canvasId, type, x, y, data: {}, ...extra })).body;
const board = async (c) => (await call('GET', '/api/canvas/' + c)).body.items;

test('panel defaults, any size, shape validation', async () => {
  const c = await root();
  const p = await mk(c, 'panel', 0, 0);
  assert.equal(p.type, 'panel');
  assert.deepEqual([p.w, p.h, p.data.title, p.data.shape], [480, 320, 'Panel', 'rounded']);
  const big = await mk(c, 'panel', 0, 0, { w: 900, h: 90, data: { title: 'Wide', shape: 'ellipse' } });
  assert.deepEqual([big.w, big.h], [900, 90]);
  const bad = await call('POST', '/api/item', { canvasId: c, type: 'panel', data: { shape: 'blob' } });
  assert.equal(bad.status, 400);
  const bad2 = await call('PATCH', '/api/item/' + p.id, { data: { shape: 'blob' } });
  assert.equal(bad2.status, 400);
});

test('membership is positional and logged on both sides', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T1' } })).body.data.childCanvasId;
  const p = await mk(c, 'panel', 100, 100, { w: 400, h: 300, data: { title: 'Research' } });
  const inside = await mk(c, 'note', 150, 160);          // anchor (270, 184)
  const outside = await mk(c, 'note', 700, 160);
  const edge = await mk(c, 'note', 500, 160, { w: 240 }); // anchor x = 620 -> outside
  const items = await board(c);
  const get = (id) => items.find(i => i.id === id);
  assert.equal(get(inside.id)._panelId, p.id);
  assert.equal(get(inside.id)._panelTitle, 'Research');
  assert.equal(get(outside.id)._panelId, undefined);
  assert.equal(get(edge.id)._panelId, undefined);
  assert.deepEqual(get(p.id)._memberIds, [inside.id]);
  assert.equal(get(p.id)._memberCount, 1);
  // single-item read agrees
  assert.equal((await call('GET', '/api/item/' + inside.id)).body._panelId, p.id);
  assert.deepEqual((await call('GET', '/api/item/' + p.id)).body._memberIds, [inside.id]);
});

test('moving a card in/out changes membership; renaming a panel renames the log', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T2' } })).body.data.childCanvasId;
  const p = await mk(c, 'panel', 0, 0, { w: 300, h: 300, data: { title: 'A' } });
  const n = await mk(c, 'note', 600, 600);
  await call('PATCH', '/api/item/' + n.id, { x: 50, y: 60 });
  assert.equal((await call('GET', '/api/item/' + n.id)).body._panelId, p.id);
  await call('PATCH', '/api/item/' + p.id, { data: { title: 'Renamed' } });
  assert.equal((await call('GET', '/api/item/' + n.id)).body._panelTitle, 'Renamed');
  await call('PATCH', '/api/item/' + n.id, { x: 900 });
  assert.equal((await call('GET', '/api/item/' + n.id)).body._panelId, undefined);
});

test('moving a panel carries members (any depth); moveMembers:false leaves them', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T3' } })).body.data.childCanvasId;
  const outer = await mk(c, 'panel', 0, 0, { w: 600, h: 500, data: { title: 'Outer' } });
  const inner = await mk(c, 'panel', 50, 60, { w: 250, h: 200, data: { title: 'Inner' } });
  const a = await mk(c, 'note', 60, 100);   // in inner (and outer)
  const b = await mk(c, 'note', 350, 200);  // outer only
  const r = (await call('PATCH', '/api/item/' + outer.id, { x: 1000, y: 500 })).body;
  assert.deepEqual(new Set(r._moved), new Set([inner.id, a.id, b.id]));
  const items = await board(c);
  const g = (id) => items.find(i => i.id === id);
  assert.deepEqual([g(inner.id).x, g(inner.id).y], [1050, 560]);
  assert.deepEqual([g(a.id).x, g(a.id).y], [1060, 600]);
  assert.deepEqual([g(b.id).x, g(b.id).y], [1350, 700]);
  // nesting: smallest panel wins
  assert.equal(g(a.id)._panelId, inner.id);
  assert.equal(g(b.id)._panelId, outer.id);
  assert.equal(g(inner.id)._panelId, outer.id);
  // resize-only patch moves nothing
  await call('PATCH', '/api/item/' + outer.id, { w: 700 });
  assert.equal((await board(c)).find(i => i.id === a.id).x, 1060);
  // moveMembers:false
  await call('PATCH', '/api/item/' + outer.id, { x: 0, y: 0, moveMembers: false });
  assert.equal((await board(c)).find(i => i.id === a.id).x, 1060);
});

test('ellipse membership uses the ellipse, not its bounding box', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T4' } })).body.data.childCanvasId;
  const p = await mk(c, 'panel', 0, 0, { w: 400, h: 400, data: { title: 'Round', shape: 'ellipse' } });
  const corner = await mk(c, 'note', -100, 0, { w: 240 });   // anchor (20, 24): in bbox, outside circle
  const mid = await mk(c, 'note', 80, 150, { w: 240 });       // anchor (200, 174)
  const items = await board(c);
  assert.equal(items.find(i => i.id === corner.id)._panelId, undefined);
  assert.equal(items.find(i => i.id === mid.id)._panelId, p.id);
});

test('group wraps cards without moving them; panel contains them all', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T5' } })).body.data.childCanvasId;
  const a = await mk(c, 'note', 100, 100), b = await mk(c, 'todo', 500, 400), z = await mk(c, 'note', 2000, 2000);
  const g = await call('POST', `/api/canvas/${c}/panels/group`, { itemIds: [a.id, b.id], title: 'Cluster', color: 'teal' });
  assert.equal(g.status, 200);
  assert.deepEqual(new Set(g.body._memberIds), new Set([a.id, b.id]));
  assert.equal(g.body.data.title, 'Cluster');
  const items = await board(c);
  assert.equal(items.find(i => i.id === a.id).x, 100);
  assert.equal(items.find(i => i.id === z.id)._panelId, undefined);
  const lp = (await call('GET', `/api/canvas/${c}/panels`)).body;
  assert.equal(lp.panels.length, 1);
  assert.equal(lp.panels[0].members.length, 2);
  assert.deepEqual(lp.ungrouped.map(u => u.id), [z.id]);
});

test('group edge cases: empty, unknown, other board, column child, line', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T6' } })).body.data.childCanvasId;
  const other = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T6b' } })).body.data.childCanvasId;
  const col = await mk(c, 'column', 10, 10), child = await mk(c, 'note', 0, 0, { parentItemId: col.id });
  const foreign = await mk(other, 'note', 0, 0), a = await mk(c, 'note', 400, 10), b = await mk(c, 'note', 700, 10);
  const line = await mk(c, 'line', 0, 0, { data: { fromId: a.id, toId: b.id } });
  const grp = (ids) => call('POST', `/api/canvas/${c}/panels/group`, { itemIds: ids, title: 'x' });
  assert.equal((await grp([])).status, 400);
  assert.equal((await grp(['nope'])).status, 404);
  assert.equal((await grp([foreign.id])).status, 400);
  assert.equal((await grp([child.id])).status, 400);
  assert.equal((await grp([line.id])).status, 400);
  assert.equal((await call('POST', '/api/canvas/nope/panels/group', { itemIds: [a.id] })).status, 404);
  // a column child is excluded from membership; the column itself counts
  const p = await mk(c, 'panel', -50, -50, { w: 300, h: 300 });
  const items = await board(c);
  assert.equal(items.find(i => i.id === child.id)._panelId, undefined);
  assert.equal(items.find(i => i.id === col.id)._panelId, p.id);
  // line is never a member
  assert.equal(items.find(i => i.id === line.id)._panelId, undefined);
});

test('add members lays out outside cards inside, leaves inside ones, warns when full', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T7' } })).body.data.childCanvasId;
  const p = await mk(c, 'panel', 0, 0, { w: 560, h: 400, data: { title: 'Bin' } });
  const keep = await mk(c, 'note', 20, 60);
  const ns = [];
  for (let i = 0; i < 3; i++) ns.push(await mk(c, 'note', 3000 + i * 300, 3000));
  const r = await call('POST', `/api/panel/${p.id}/members`, { itemIds: [keep.id, ...ns.map(n => n.id)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.moved.sort(), ns.map(n => n.id).sort());
  assert.equal(r.body.panel._memberCount, 4);
  assert.equal(r.body.warning, undefined);
  const items = await board(c);
  assert.equal(items.find(i => i.id === keep.id).x, 20);
  // a tiny panel can't fit: warns, doesn't resize
  const tiny = await mk(c, 'panel', 5000, 5000, { w: 150, h: 120 });
  const n2 = await mk(c, 'note', 0, 4000);
  const r2 = await call('POST', `/api/panel/${tiny.id}/members`, { itemIds: [n2.id] });
  assert.ok(r2.body.warning);
  assert.equal(r2.body.panel.w, 150);
  assert.equal((await call('POST', '/api/panel/nope/members', { itemIds: [n2.id] })).status, 404);
  assert.equal((await call('POST', `/api/panel/${p.id}/members`, { itemIds: [] })).status, 400);
  assert.equal((await call('POST', `/api/panel/${p.id}/members`, { itemIds: [p.id] })).status, 400);
});

test('deleting a panel keeps its cards; shape/nesting rules', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T8' } })).body.data.childCanvasId;
  const p = await mk(c, 'panel', 0, 0), n = await mk(c, 'note', 30, 60);
  await call('DELETE', '/api/item/' + p.id);
  const items = await board(c);
  assert.ok(items.find(i => i.id === n.id));
  assert.equal(items.find(i => i.id === n.id)._panelId, undefined);
  // equal-sized panels never contain each other
  const a = await mk(c, 'panel', 0, 0, { w: 300, h: 300 }), b = await mk(c, 'panel', 0, 0, { w: 300, h: 300 });
  const it = await board(c);
  assert.equal(it.find(i => i.id === a.id)._panelId, undefined);
  assert.equal(it.find(i => i.id === b.id)._panelId, undefined);
});

test('panels.js geometry helpers', () => {
  const p = { id: 'p', x: 0, y: 0, w: 100, h: 100, data: {} };
  assert.ok(panels.containsPoint(p, { x: 100, y: 100 }));
  assert.ok(!panels.containsPoint(p, { x: 101, y: 50 }));
  const box = panels.boundsFor([{ x: 100, y: 100, w: 200, h: 50 }], { padding: 10 });
  assert.deepEqual(box, { x: 90, y: 100 - 10 - panels.HEADER_H, w: 220, h: 50 + 20 + panels.HEADER_H });
});

test('group warns about bystander cards inside the box and sizes tall todos', async () => {
  const c = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T9' } })).body.data.childCanvasId;
  const a = await mk(c, 'note', 0, 0), b = await mk(c, 'note', 800, 0);
  const bystander = await mk(c, 'note', 400, 20);
  const g = (await call('POST', `/api/canvas/${c}/panels/group`, { itemIds: [a.id, b.id], title: 'Wide' })).body;
  assert.ok(g._warning.includes(bystander.id));
  assert.equal(g._memberCount, 3);
  const c2 = (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title: 'T9b' } })).body.data.childCanvasId;
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: 't' + i, text: 'task ' + i, done: false }));
  const t = await mk(c2, 'todo', 100, 100, { data: { title: 'Long', tasks } });
  const g2 = (await call('POST', `/api/canvas/${c2}/panels/group`, { itemIds: [t.id], title: 'Solo' })).body;
  assert.ok(g2.y + g2.h >= 100 + 70 + 36 * 8, 'panel reaches below the 8-task todo');
  assert.equal(g2._warning, undefined);
});

// ---- duplicate + templates ---------------------------------------------------
const newBoard = async (title) => (await call('POST', '/api/item', { canvasId: await root(), type: 'board', data: { title } })).body;

test('duplicate deep-copies a column with its cards, and a board with its subtree', async () => {
  const c = (await newBoard('D1')).data.childCanvasId;
  const col = await mk(c, 'column', 10, 10, { data: { title: 'Col' } });
  await mk(c, 'note', 0, 0, { parentItemId: col.id, data: { title: 'in col' } });
  const d = (await call('POST', `/api/item/${col.id}/duplicate`, {})).body;
  assert.notEqual(d.id, col.id);
  assert.deepEqual([d.x, d.y], [40, 40]);
  const items = await board(c);
  assert.equal(items.filter(i => i.parentItemId === d.id).length, 1);
  assert.equal(items.filter(i => i.parentItemId === col.id).length, 1, 'original keeps its card');

  const sub = await newBoard('Outer');
  const inner = (await call('POST', '/api/item', { canvasId: sub.data.childCanvasId, type: 'board', data: { title: 'Inner' } })).body;
  await mk(inner.data.childCanvasId, 'note', 5, 5, { data: { title: 'deep' } });
  const dup = (await call('POST', `/api/item/${sub.id}/duplicate`, { canvasId: c, x: 500, y: 500 })).body;
  assert.equal(dup._childTitle, 'Outer');
  assert.notEqual(dup.data.childCanvasId, sub.data.childCanvasId);
  const innerCopy = (await board(dup.data.childCanvasId)).find(i => i.type === 'board');
  assert.notEqual(innerCopy.data.childCanvasId, inner.data.childCanvasId);
  assert.equal((await board(innerCopy.data.childCanvasId))[0].data.title, 'deep');
  // errors
  assert.equal((await call('POST', '/api/item/nope/duplicate', {})).status, 404);
  const ln = await mk(c, 'line', 0, 0, { data: { fromId: col.id, toId: d.id } });
  assert.equal((await call('POST', `/api/item/${ln.id}/duplicate`, {})).status, 400);
  assert.equal((await call('POST', `/api/item/${col.id}/duplicate`, { canvasId: 'nope' })).status, 400);
});

test('templates: save a board with panels + lines, list, use it twice independently', async () => {
  assert.deepEqual((await call('GET', '/api/templates')).body.templates, []);
  const src = (await newBoard('Kickoff')).data.childCanvasId;
  await mk(src, 'panel', 0, 0, { w: 400, h: 300, data: { title: 'Goals' } });
  const a = await mk(src, 'note', 40, 80, { data: { title: 'North star' } });
  const b = await mk(src, 'note', 700, 80, { data: { title: 'Far away' } });
  await mk(src, 'line', 0, 0, { data: { fromId: a.id, toId: b.id, label: 'leads to' } });
  const t = await call('POST', '/api/templates', { fromCanvasId: src, name: 'Kickoff kit' });
  assert.equal(t.status, 200);
  assert.deepEqual([t.body.name, t.body.itemCount, t.body.panels], ['Kickoff kit', 4, ['Goals']]);
  assert.equal((await call('POST', '/api/templates', { fromCanvasId: src, name: 'kickoff KIT' })).status, 409);
  assert.equal((await call('POST', '/api/templates', { fromCanvasId: 'nope' })).status, 404);
  assert.equal((await call('GET', '/api/templates')).body.templates.length, 1);

  const target = (await newBoard('Project X')).data.childCanvasId;
  const u1 = (await call('POST', `/api/templates/${t.body.id}/use`, { canvasId: target, title: 'Plan A', x: 10, y: 10 })).body;
  const u2 = (await call('POST', `/api/templates/${t.body.id}/use`, { canvasId: target, title: 'Plan B' })).body;
  assert.equal(u1._childTitle, 'Plan A');
  const items = await board(u1.data.childCanvasId);
  assert.equal(items.length, 4);
  assert.equal(items.find(i => i.type === 'note' && i.data.title === 'North star')._panelTitle, 'Goals');
  const ln = items.find(i => i.type === 'line');
  assert.ok(items.some(i => i.id === ln.data.fromId) && items.some(i => i.id === ln.data.toId), 'line remapped to the copies');
  // independence: editing the use leaves the template and the other use alone
  const nid = items.find(i => i.data.title === 'North star').id;
  await call('PATCH', '/api/item/' + nid, { data: { title: 'changed' } });
  assert.equal((await board(u2.data.childCanvasId)).find(i => i.type === 'note').data.title, 'North star');
  assert.equal((await board(t.body.id)).find(i => i.type === 'note').data.title, 'North star');
  assert.equal((await call('POST', '/api/templates/c_nope/use', {})).status, 404);
  assert.equal((await call('POST', `/api/templates/${src}/use`, {})).status, 404, 'only boards inside Templates are templates');
});

test('moving a panel over neighbours warns about newly captured cards', async () => {
  const c = (await newBoard('W1')).data.childCanvasId;
  const p = await mk(c, 'panel', 0, 0, { w: 300, h: 300 });
  await mk(c, 'note', 20, 60);
  const bystander = await mk(c, 'note', 800, 60);
  const r = (await call('PATCH', '/api/item/' + p.id, { x: 700, y: 0 })).body;
  assert.ok(r._warning && r._warning.includes(bystander.id));
  const calm = (await call('PATCH', '/api/item/' + p.id, { x: 0, y: 0 })).body;
  assert.equal(calm._warning, undefined);
});
