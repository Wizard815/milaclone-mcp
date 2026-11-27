'use strict';

// API_KEY: when set, every /api/* request needs it -- except the health check
// and the task API, which has its own bearer token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY = 'sekret-key';
process.env.TASK_API_TOKEN = 'task-token';

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

const status = (p, headers = {}) => fetch(base + p, { headers }).then(r => r.status);

test('no key: 401 on the API, health stays open', async () => {
  assert.equal(await status('/api/root'), 401);
  assert.equal(await status('/api/health'), 200);
});

test('the key is accepted as X-API-Key or as a bearer token; a wrong or short one is not', async () => {
  assert.equal(await status('/api/root', { 'X-API-Key': 'sekret-key' }), 200);
  assert.equal(await status('/api/root', { Authorization: 'Bearer sekret-key' }), 200);
  assert.equal(await status('/api/root', { Authorization: 'bearer sekret-key' }), 200);
  assert.equal(await status('/api/root', { 'X-API-Key': 'wrong-key!' }), 401);
  assert.equal(await status('/api/root', { 'X-API-Key': 'x' }), 401, 'different length');
  assert.equal(await status('/api/root', { Authorization: 'Basic sekret-key' }), 401);
});

test('the task API uses its own token, not API_KEY', async () => {
  assert.equal(await status('/api/tasks'), 401);
  assert.equal(await status('/api/tasks', { 'X-API-Key': 'sekret-key' }), 401);
  assert.equal(await status('/api/tasks', { Authorization: 'Bearer task-token' }), 200);
});

test('panel and template routes are behind the key too', async () => {
  const root = await fetch(base + '/api/root', { headers: { 'X-API-Key': 'sekret-key' } }).then(r => r.json());
  assert.equal(await status(`/api/canvas/${root.rootCanvasId}/panels`), 401);
  assert.equal(await status('/api/templates'), 401);
  assert.equal(await status('/api/pipeline'), 401);
  assert.equal(await status(`/api/canvas/${root.rootCanvasId}/panels`, { 'X-API-Key': 'sekret-key' }), 200);
});

// ---- signing in from the web page: the key is typed once and traded for a cookie ----
const post = (p, body, headers = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('the page is never sent the key', async () => {
  const main = express();
  main.use(require('../routes'));
  main.use(express.static(path.join(__dirname, '..', 'public')));
  const s = await new Promise(r => {
    const l = main.listen(0, '127.0.0.1', () => r(l));
  });
  try {
    const html = await fetch(`http://127.0.0.1:${s.address().port}/`).then(r => r.text());
    assert.ok(html.includes('<html'), 'the page itself loads without the key');
    assert.ok(!html.includes('sekret-key') && !html.includes('milaclone-key'));
  } finally {
    s.close();
  }
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('milaclone-key'));
});

test('login: the right key sets an HttpOnly cookie that opens the API; a wrong one does not', async () => {
  assert.deepEqual(await fetch(base + '/api/session').then(r => r.json()), { required: true, signedIn: false });
  const bad = await post('/api/login', { key: 'wrong-key!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.equal((await post('/api/login', {})).status, 401);
  const ok = await post('/api/login', { key: 'sekret-key' });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /^milaclone_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
  assert.ok(!set.includes('sekret-key'), 'the cookie is not the key');
  const cookie = set.split(';')[0];
  assert.equal(await status('/api/root', { cookie }), 200);
  assert.equal(await status('/api/root', { cookie: 'other=1; ' + cookie }), 200);
  assert.equal(await status('/api/root', { cookie: 'milaclone_session=' + '0'.repeat(64) }), 401);
  assert.equal(await status('/api/root', { cookie: 'milaclone_session=' }), 401);
  assert.deepEqual(await fetch(base + '/api/session', { headers: { cookie } }).then(r => r.json()), {
    required: true,
    signedIn: true,
  });
  const out = await post('/api/logout', {});
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('uploads need the key or the cookie, however the path is spelled', async () => {
  const cookie = (await post('/api/login', { key: 'sekret-key' })).headers.get('set-cookie').split(';')[0];
  for (const p of ['/uploads/nope.png', '/Uploads/nope.png', '/%75ploads/nope.png', '//uploads/nope.png', '/uploads']) {
    assert.equal(await status(p), 401, p);
  }
  assert.equal(await status('/uploads/%E0%A4%A'), 400, 'a path that cannot be decoded');
  assert.equal(await status('/uploads/nope.png', { cookie }), 404, 'signed in: past the gate');
  assert.equal(await status('/uploads/nope.png', { 'X-API-Key': 'sekret-key' }), 404);
});

test('ten wrong keys lock the address out, the right key included', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post('/api/login', { key: 'guess-' + i })).status, 401);
  const locked = await post('/api/login', { key: 'sekret-key' });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.equal(await status('/api/root', { 'X-API-Key': 'sekret-key' }), 200, 'apps with the key are not held up');
});
