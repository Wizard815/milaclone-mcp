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
