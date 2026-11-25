'use strict';

// Agents on boards (agent.js): plans laid out as boards, reading a board back,
// adding/connecting/grouping/moving cards, status marks, the Orb link and the
// Orb task bridge (against a fake Orb), and the activity log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
process.env.DATA_DIR = TMP;

const express = require('express');
const app = express();
app.use(require('../routes'));

let base, server, orb;
const orbData = {
  projects: [{ id: 'p_1', name: 'Argos', status: 'active' }],
  tasks: [
    { id: 't_1', title: 'Write the scheduler', list: 'Argos', done: false },
    { id: 't_2', title: 'Pick a queue', list: 'Argos', done: false, started: true },
    { id: 't_3', title: 'Old spike', list: 'Argos', done: true },
    { id: 't_x', title: 'Elsewhere', list: 'Inbox', done: false },
  ],
};
const orbSeen = [];
test.before(async () => {
  await new Promise(r => (server = app.listen(0, '127.0.0.1', r)));
  base = 'http://127.0.0.1:' + server.address().port;
  orb = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      orbSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const coll = req.url.split('/')[3];
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify(orbData[coll] || []));
      const doc = { id: (coll === 'tasks' ? 't_' : 'p_') + (orbSeen.length + 10), ...body };
      orbData[coll].push(doc);
      res.writeHead(201);
      res.end(JSON.stringify(doc));
    });
  });
  await new Promise(r => orb.listen(0, '127.0.0.1', r));
});
test.after(() => {
  server.close();
  orb.close();
  delete process.env.ORB_URL;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = async (method, p, body, agent = 'Hermes') => {
  const headers = { 'Content-Type': 'application/json' };
  if (agent) headers['X-Milaclone-Agent'] = agent;
  const r = await fetch(base + p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
};
const activity = async (q = '') => (await call('GET', '/api/activity' + q)).body;

test('a plan becomes a columns board, read back as JSON and text', async () => {
  const made = await call('POST', '/api/agent/boards', {
    title: 'Garage plan',
    layout: 'columns',
    sections: [
      {
        title: 'Clear out',
        cards: ['Sort the boxes', { text: 'Book a skip', body: 'Friday or Saturday', ref: 'skip' }],
      },
      { title: 'Build', cards: [{ text: 'Bike hooks', status: 'doing', color: 'teal' }] },
    ],
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.layout, 'columns');
  assert.equal(made.body.sections.length, 2);
  assert.equal(made.body.cards.length, 3);
  assert.ok(made.body.refs.skip);

  const read = await call('GET', '/api/agent/board?board=garage');
  assert.equal(read.status, 200);
  assert.equal(read.body.title, 'Garage plan');
  assert.equal(read.body.layout, 'columns');
  assert.equal(read.body.boardCard, made.body.boardCard);
  assert.equal(read.body.parent, made.body.parent);
  assert.deepEqual(
    read.body.sections.map(s => [s.kind, s.title, s.cards.map(c => c.title)]),
    [
      ['column', 'Clear out', ['Sort the boxes', 'Book a skip']],
      ['column', 'Build', ['Bike hooks']],
    ]
  );
  assert.equal(read.body.sections[0].cards[1].text, 'Friday or Saturday');
  assert.equal(read.body.sections[1].cards[0].status.state, 'doing');
  assert.match(read.body.note, /not instructions/);

  const text = await call('GET', `/api/agent/board?board=${made.body.board}&format=text`);
  assert.match(text.body, /^Board "Garage plan" \[c_/);
  assert.match(text.body, /## Column "Clear out"/);
  assert.match(text.body, /Book a skip — Friday or Saturday/);
  assert.match(text.body, /\{doing\}/);

  const log = await activity();
  assert.equal(log.items[0].actor, 'Hermes');
  assert.equal(log.items[0].action, 'create');
  assert.match(log.items[0].summary, /laid out "Garage plan" as columns: 2 columns, 3 cards/);
  assert.equal(log.items[0].boardTitle, 'Garage plan');
});

test('route and map layouts connect their parts', async () => {
  const route = await call('POST', '/api/agent/boards', {
    title: 'Trip',
    layout: 'route',
    sections: [{ title: 'Pack' }, { title: 'Drive', cards: ['Fuel'] }, { title: 'Arrive' }],
  });
  assert.equal(route.status, 201);
  const r = (await call('GET', '/api/agent/board?board=' + route.body.board)).body;
  assert.equal(r.connections.length, 2);
  assert.equal(r.connections[1].label, 'step 3');

  const map = await call('POST', '/api/agent/boards', {
    title: 'Blog ideas',
    layout: 'map',
    center: 'What to write',
    sections: [
      { title: 'Homelab', cards: ['Unraid tips', 'Backups'] },
      { title: 'Cooking', cards: ['Bread'] },
    ],
  });
  assert.equal(map.status, 201);
  assert.ok(map.body.center);
  const m = (await call('GET', '/api/agent/board?board=' + map.body.board + '&format=text')).body;
  // centre -> 2 branches, each branch -> its cards
  assert.equal((m.match(/ -> /g) || []).length, 5);
  assert.match(m, /"What to write" \[i_[^\]]+\] -> "Homelab"/);
});

test('plans are checked', async () => {
  assert.equal((await call('POST', '/api/agent/boards', { title: 'x', layout: 'spiral', sections: [{}] })).status, 400);
  assert.equal((await call('POST', '/api/agent/boards', { layout: 'columns', sections: [{}] })).status, 400);
  assert.equal((await call('POST', '/api/agent/boards', { title: 'x', sections: [] })).status, 400);
  const bad = await call('POST', '/api/agent/boards', {
    title: 'x',
    sections: [{ title: 'a', cards: [{ text: '' }] }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /needs text/);
  const colour = await call('POST', '/api/agent/boards', {
    title: 'x',
    sections: [{ cards: [{ text: 'a', color: 'neon' }] }],
  });
  assert.match(colour.body.error, /color must be/);
  const st = await call('POST', '/api/agent/boards', {
    title: 'x',
    sections: [{ cards: [{ text: 'a', status: 'meh' }] }],
  });
  assert.match(st.body.error, /status must be/);
  const many = Array.from({ length: 13 }, () => ({ title: 's' }));
  assert.equal((await call('POST', '/api/agent/boards', { title: 'x', sections: many })).status, 400);
  const big = [{ cards: Array.from({ length: 201 }, (_, i) => 'c' + i) }];
  assert.equal((await call('POST', '/api/agent/boards', { title: 'x', sections: big })).status, 400);
  const nb = await call('GET', '/api/agent/board?board=nothing-like-this');
  assert.equal(nb.status, 404);
  assert.ok(Array.isArray(nb.body.boards));
});

test('cards go into columns, sections, new columns or loose, and connect by ref', async () => {
  const board = (await call('GET', '/api/agent/board?board=Garage plan')).body;
  // a section (panel) to drop into
  const panel = await call('POST', '/api/item', {
    canvasId: board.board,
    type: 'panel',
    x: 2000,
    y: 0,
    w: 300,
    h: 120,
    data: { title: 'Ideas' },
  });
  assert.equal(panel.status, 200);
  const added = await call('POST', '/api/agent/board/cards', {
    board: board.board,
    cards: [
      { text: 'Recycle paint', section: 'Clear out', ref: 'paint' },
      { text: 'Pegboard', section: 'Ideas', ref: 'peg' },
      { text: 'Second pegboard', section: 'ideas' },
      { text: 'Buy screws', section: 'Shopping', ref: 'screws' },
      { text: 'Loose thought' },
    ],
    connect: [{ from: 'peg', to: 'screws', label: 'needs', kind: 'depends' }],
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.cards.length, 5);
  assert.deepEqual(
    added.body.newColumns.map(c => c.title),
    ['Shopping']
  );
  const read = (await call('GET', '/api/agent/board?board=' + board.board)).body;
  const sec = t => read.sections.find(s => s.title === t);
  assert.deepEqual(
    sec('Clear out').cards.map(c => c.title),
    ['Sort the boxes', 'Book a skip', 'Recycle paint']
  );
  assert.deepEqual(
    sec('Ideas')
      .cards.map(c => c.title)
      .sort(),
    ['Pegboard', 'Second pegboard']
  );
  assert.equal(sec('Ideas').kind, 'section');
  assert.deepEqual(
    sec('Shopping').cards.map(c => c.title),
    ['Buy screws']
  );
  assert.ok(read.loose.some(c => c.title === 'Loose thought'));
  const link = read.connections.find(c => c.label === 'needs');
  assert.equal(link.kind, 'depends');
  assert.equal(link.from, added.body.refs.peg);

  assert.equal((await call('POST', '/api/agent/board/cards', { board: board.board, cards: [] })).status, 400);
  const tooMany = Array.from({ length: 51 }, () => 'x');
  assert.equal((await call('POST', '/api/agent/board/cards', { board: board.board, cards: tooMany })).status, 400);
  const log = await activity('?canvasId=' + board.board);
  assert.ok(log.items.some(a => /added 5 card/.test(a.summary)));
});

test('connections, groups, moves and status marks', async () => {
  const id = (await call('GET', '/api/agent/board?board=Garage plan')).body.board;
  const c = await call('POST', '/api/agent/board/connect', {
    board: id,
    links: [{ from: 'Sort the boxes', to: 'book a skip', label: 'then' }],
  });
  assert.equal(c.status, 201);
  assert.equal((await activity()).items[0].summary, 'connected "Sort the boxes" to "Book a skip"');
  const two = await call('POST', '/api/agent/board/connect', {
    board: id,
    links: [
      { from: 'Pegboard', to: 'Bike hooks' },
      { from: 'Loose thought', to: 'Pegboard' },
    ],
  });
  assert.equal(two.body.connections.length, 2);
  assert.equal((await call('POST', '/api/agent/board/connect', { board: id, links: [] })).status, 400);
  const same = await call('POST', '/api/agent/board/connect', {
    board: id,
    links: [{ from: 'Pegboard', to: 'Pegboard' }],
  });
  assert.equal(same.status, 400);
  const miss = await call('POST', '/api/agent/board/connect', { board: id, links: [{ from: 'Nope', to: 'Pegboard' }] });
  assert.equal(miss.status, 404);
  const noName = await call('POST', '/api/agent/board/connect', { board: id, links: [{ to: 'Pegboard' }] });
  assert.equal(noName.status, 400);

  // group into a new column, then a section
  const g = await call('POST', '/api/agent/board/group', {
    board: id,
    title: 'Later',
    cards: ['Loose thought', 'Bike hooks'],
  });
  assert.equal(g.status, 200);
  let read = (await call('GET', '/api/agent/board?board=' + id)).body;
  assert.deepEqual(
    read.sections.find(s => s.title === 'Later').cards.map(x => x.title),
    ['Loose thought', 'Bike hooks']
  );
  const s = await call('POST', '/api/agent/board/group', {
    board: id,
    title: 'Paint',
    as: 'section',
    cards: ['Recycle paint', 'Buy screws', 'Sort the boxes'],
  });
  assert.equal(s.status, 200);
  read = (await call('GET', '/api/agent/board?board=' + id)).body;
  const paint = read.sections.find(x => x.title === 'Paint');
  assert.equal(paint.kind, 'section');
  assert.deepEqual(paint.cards.map(x => x.title).sort(), ['Buy screws', 'Recycle paint', 'Sort the boxes']);
  assert.equal(
    (await call('POST', '/api/agent/board/group', { board: id, title: 'x', as: 'pile', cards: ['Pegboard'] })).status,
    400
  );
  assert.equal((await call('POST', '/api/agent/board/group', { board: id, cards: ['Pegboard'] })).status, 400);
  assert.equal((await call('POST', '/api/agent/board/group', { board: id, title: 'x', cards: [] })).status, 400);
  const col = await call('POST', '/api/agent/board/group', { board: id, title: 'x', cards: ['Later'] });
  assert.match(col.body.error, /only cards can be grouped/);

  // moves: into a column, loose, to a spot
  const m = await call('POST', '/api/agent/board/move', {
    board: id,
    moves: [
      { card: 'Pegboard', to: 'Later' },
      { card: 'Second pegboard', to: 'loose' },
      { card: 'Book a skip', x: 5000, y: 10 },
    ],
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  read = (await call('GET', '/api/agent/board?board=' + id)).body;
  assert.deepEqual(
    read.sections.find(x => x.title === 'Later').cards.map(x => x.title),
    ['Loose thought', 'Bike hooks', 'Pegboard']
  );
  assert.ok(read.loose.some(x => x.title === 'Second pegboard'));
  assert.ok(read.loose.some(x => x.title === 'Book a skip'));
  const one = await call('POST', '/api/agent/board/move', { board: id, moves: [{ card: 'Pegboard', to: 'Ideas' }] });
  assert.equal(one.status, 200);
  assert.equal((await activity()).items[0].summary, 'moved "Pegboard" to Ideas');
  assert.equal((await call('POST', '/api/agent/board/move', { board: id, moves: [] })).status, 400);
  assert.equal(
    (await call('POST', '/api/agent/board/move', { board: id, moves: [{ card: 'Pegboard', to: 'Nowhere' }] })).status,
    404
  );
  assert.equal(
    (await call('POST', '/api/agent/board/move', { board: id, moves: [{ card: 'Later', to: 'Ideas' }] })).status,
    400
  );
  assert.equal(
    (await call('POST', '/api/agent/board/move', { board: id, moves: [{ card: 'Ideas', x: 1, y: 1 }] })).status,
    400
  );
  const lineId = read.connections[0].id;
  assert.equal(
    (await call('POST', '/api/agent/board/move', { board: id, moves: [{ card: lineId, to: 'loose' }] })).status,
    400
  );

  // status marks
  const st = await call('POST', '/api/agent/board/status', {
    board: id,
    marks: [{ card: 'Pegboard', state: 'blocked', detail: 'no wall plugs' }],
  });
  assert.equal(st.status, 200);
  read = (await call('GET', '/api/agent/board?board=' + id)).body;
  const peg = read.sections.flatMap(x => x.cards).find(x => x.title === 'Pegboard');
  assert.deepEqual([peg.status.state, peg.status.by, peg.status.detail], ['blocked', 'Hermes', 'no wall plugs']);
  await call('POST', '/api/agent/board/status', {
    board: id,
    marks: [
      { card: 'Pegboard', state: 'clear' },
      { card: 'Bike hooks', state: 'done' },
    ],
  });
  read = (await call('GET', '/api/agent/board?board=' + id)).body;
  assert.equal(read.sections.flatMap(x => x.cards).find(x => x.title === 'Pegboard').status, undefined);
  assert.equal((await activity()).items[0].summary, 'marked 2 cards');
  assert.equal(
    (await call('POST', '/api/agent/board/status', { board: id, marks: [{ card: 'Pegboard', state: 'meh' }] })).status,
    400
  );
  assert.equal((await call('POST', '/api/agent/board/status', { board: id, marks: [] })).status, 400);
});

test('ambiguous names say which ids to use', async () => {
  const b = await call('POST', '/api/agent/boards', { title: 'Twins', sections: [{ cards: ['Same', 'Same'] }] });
  const r = await call('POST', '/api/agent/board/status', {
    board: b.body.board,
    marks: [{ card: 'Same', state: 'done' }],
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /2 cards are titled "Same"/);
  await call('POST', '/api/agent/boards', { title: 'Twins', sections: [{ cards: ['x'] }] });
  const two = await call('GET', '/api/agent/board?board=Twins');
  assert.equal(two.status, 409);
  assert.equal(two.body.boards.length, 2);
  const list = await call('GET', '/api/agent/boards?q=twin');
  assert.equal(list.body.boards.length, 2);
  assert.match(list.body.boards[0].path, /^Home › Twins$/);
  assert.equal((await call('GET', '/api/agent/boards')).body.boards[0].title, 'Home');
});

test('a board links to an Orb project and can be unlinked', async () => {
  const id = (await call('GET', '/api/agent/board?board=Trip')).body.board;
  const l = await call('POST', '/api/agent/board/link', { board: id, project: 'Argos', projectId: 'p_1' });
  assert.equal(l.body.orb.project, 'Argos');
  assert.equal(l.body.orb.by, 'Hermes');
  assert.match(
    (await call('GET', `/api/agent/board?board=${id}&format=text`)).body,
    /Linked to Orb project "Argos" \(p_1\)/
  );
  assert.deepEqual(
    (await call('GET', '/api/agent/links')).body.links.map(x => x.title),
    ['Trip']
  );
  assert.equal((await call('POST', '/api/agent/board/link', { board: id, project: '   ' })).status, 400);
  const u = await call('POST', '/api/agent/board/link', { board: id, project: null });
  assert.equal(u.body.orb, null);
  assert.equal((await activity()).items[0].summary, 'unlinked the board from Orb');
});

test('cards become Orb tasks once; the Orb bridge needs ORB_URL', async () => {
  const id = (await call('GET', '/api/agent/board?board=Garage plan')).body.board;
  const off = await call('POST', '/api/agent/board/to-orb', { board: id, cards: ['Pegboard'] });
  assert.equal(off.status, 409);
  assert.match(off.body.error, /ORB_URL is not set/);

  process.env.ORB_URL = 'http://127.0.0.1:' + orb.address().port + '/';
  process.env.ORB_TOKEN = 'tok';
  await call('POST', '/api/agent/board/link', { board: id, project: 'Garage' });
  const r = await call('POST', '/api/agent/board/to-orb', { board: id, cards: ['Pegboard', 'Bike hooks'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created.length, 2);
  assert.equal(r.body.created[0].orb.list, 'Garage');
  const posted = orbSeen.filter(x => x.method === 'POST');
  assert.deepEqual(
    posted.map(x => [x.url, x.body.title, x.body.list, x.auth]),
    [
      ['/api/c/tasks', 'Pegboard', 'Garage', 'Bearer tok'],
      ['/api/c/tasks', 'Bike hooks', 'Garage', 'Bearer tok'],
    ]
  );
  const again = await call('POST', '/api/agent/board/to-orb', { board: id, cards: ['Pegboard'] });
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.already.length, 1);
  assert.equal(orbSeen.filter(x => x.method === 'POST').length, 2);
  assert.match((await call('GET', `/api/agent/board?board=${id}&format=text`)).body, /Pegboard.*<Orb task t_/);

  const p = await call('POST', '/api/agent/board/to-orb', { board: id, as: 'projects', cards: ['Book a skip'] });
  assert.equal(p.body.created[0].orb.kind, 'project');
  assert.equal(orbSeen.at(-1).body.next, 'Friday or Saturday');
  assert.equal((await call('POST', '/api/agent/board/to-orb', { board: id, as: 'goals', cards: ['x'] })).status, 400);
  assert.equal((await call('POST', '/api/agent/board/to-orb', { board: id, cards: [] })).status, 400);

  // Orb made them itself: only stamp the cards
  const made = await call('POST', '/api/agent/board/to-orb', {
    board: id,
    made: [{ card: 'Second pegboard', orb: { kind: 'task', id: 'orb-9', list: 'Inbox' } }],
  });
  assert.equal(made.body.created[0].orb.id, 'orb-9');
  assert.equal(orbSeen.filter(x => x.method === 'POST').length, 3);
  assert.match((await activity()).items[0].summary, /turned 1 card\(s\) into Orb tasks/);
});

test('an Orb project becomes a board, and the board follows it', async () => {
  const r = await call('POST', '/api/agent/boards/from-orb', { project: 'argos' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const read = (await call('GET', '/api/agent/board?board=' + r.body.board)).body;
  assert.equal(read.orb.project, 'Argos');
  assert.deepEqual(
    read.sections.map(s => [s.title, s.cards.map(c => c.title)]),
    [
      ['To do', ['Write the scheduler']],
      ['In progress', ['Pick a queue']],
      ['Done', ['Old spike']],
    ]
  );
  assert.equal(read.sections[1].cards[0].status.state, 'doing');

  // Orb moves on: t_1 started, t_2 done, t_3 deleted, t_4 new
  orbData.tasks = [
    { id: 't_1', title: 'Write the scheduler', list: 'Argos', started: true },
    { id: 't_2', title: 'Pick a queue', list: 'Argos', done: true },
    { id: 't_4', title: 'Load test', list: 'Argos' },
  ];
  const s = await call('POST', '/api/agent/board/sync-orb', { board: r.body.board });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.added, ['Load test']);
  assert.deepEqual(s.body.gone, ['Old spike']);
  const after = (await call('GET', '/api/agent/board?board=' + r.body.board)).body;
  assert.deepEqual(
    after.sections.map(x => [x.title, x.cards.map(c => c.title)]),
    [
      ['To do', ['Load test']],
      ['In progress', ['Write the scheduler']],
      ['Done', ['Old spike', 'Pick a queue']],
    ]
  );
  assert.equal(after.sections[2].cards[0].status.detail, 'task gone from Orb');

  // Orb can send its own tasks; a board with no "Done" column gets one
  const tiny = await call('POST', '/api/agent/boards', { title: 'Tiny', sections: [{ title: 'To do', cards: [] }] });
  const own = await call('POST', '/api/agent/board/sync-orb', {
    board: tiny.body.board,
    project: { id: 'p_7', name: 'Tiny' },
    tasks: [{ id: 'z1', title: 'Shipped it', list: 'Tiny', done: true }],
  });
  assert.deepEqual(own.body.added, ['Shipped it']);
  assert.ok(
    (await call('GET', '/api/agent/board?board=' + tiny.body.board)).body.sections.some(x => x.title === 'Done')
  );

  const unlinked = await call('POST', '/api/agent/board/sync-orb', { board: tiny.body.board });
  assert.equal(unlinked.status, 409);
  assert.equal((await call('POST', '/api/agent/boards/from-orb', { project: 'Nope' })).status, 404);
  assert.equal((await call('POST', '/api/agent/boards/from-orb', {})).status, 400);
  const given = await call('POST', '/api/agent/boards/from-orb', {
    project: { id: 'p_9', name: 'Given' },
    tasks: [{ id: 'g1', title: 'One' }],
  });
  assert.equal(given.body.cards, 1);
});

test('Orb being down is reported, not thrown', async () => {
  process.env.ORB_URL = 'http://127.0.0.1:1';
  const r = await call('POST', '/api/agent/boards/from-orb', { project: 'Argos' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Could not reach Orb/);
  process.env.ORB_URL = 'http://127.0.0.1:' + server.address().port + '/missing';
  const bad = await call('POST', '/api/agent/boards/from-orb', { project: 'Argos' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /Orb answered 404/);
  delete process.env.ORB_URL;
});

test("the activity log records an agent's ordinary writes, and only an agent's", async () => {
  const root = (await call('GET', '/api/root')).body.rootCanvasId;
  const before = (await activity()).latest;
  const made = await call(
    'POST',
    '/api/item',
    { canvasId: root, type: 'note', data: { body: 'Hello from Ekko' } },
    'Ekko'
  );
  await call('PATCH', '/api/item/' + made.body.id, { x: 400 }, 'Ekko');
  await call('PATCH', '/api/item/' + made.body.id, { data: { body: 'Edited' } }, 'Ekko');
  await call('POST', `/api/item/${made.body.id}/copy`, { canvasId: root, x: 900, y: 900 }, 'Ekko');
  await call('DELETE', '/api/item/' + made.body.id, undefined, 'Ekko');
  await call('POST', `/api/item/${made.body.id}/restore`, {}, 'Ekko');
  await call('PATCH', '/api/canvas/' + root, { title: 'Home' }, 'Ekko');
  await call('PATCH', '/api/items', { updates: [{ id: made.body.id, x: 10 }] }, 'Ekko');
  await call('POST', '/api/item', { canvasId: root, data: { body: 'person' } }, null); // the UI: not logged
  await call('PATCH', '/api/item/nope', { x: 1 }, 'Ekko'); // failed: not logged
  await call('POST', '/api/agent/board/link', { board: root, project: 'Home base' }, null); // no header: "agent"
  const log = await activity('?since=' + before + '&limit=20');
  assert.deepEqual(log.items.map(a => [a.actor, a.summary]).reverse(), [
    ['Ekko', 'added card "Hello from Ekko"'],
    ['Ekko', 'moved card "Hello from Ekko"'],
    ['Ekko', 'edited card "Hello from Ekko"'],
    ['Ekko', 'copied card "Edited"'],
    ['Ekko', 'deleted card "Edited"'],
    ['Ekko', 'restored card "Edited"'],
    ['Ekko', 'changed the board'],
    ['Ekko', 'moved 1 card(s)'],
    ['agent', 'linked the board to Orb project "Home base"'],
  ]);
  assert.equal((await call('GET', '/api/activity?canvasId=nothing')).body.items.length, 0);
});

test('helpers read every card type the board can hold', () => {
  const { readBoard, boardText, cardTitle } = require('../agent');
  const { stmt, rootCanvasId, db } = require('../db');
  const root = stmt.getCanvas.get(rootCanvasId());
  const ins = (type, data, extra = {}) =>
    stmt.insertItem.run({
      id: 'i_t' + type,
      canvasId: root.id,
      parentItemId: null,
      type,
      x: 0,
      y: 9000,
      w: 240,
      h: null,
      z: 1,
      color: null,
      data: JSON.stringify(data),
      createdAt: Date.now(),
      ...extra,
    });
  ins('todo', {
    title: 'Chores',
    tasks: [
      { id: 'a', text: 'Mop', done: true },
      { id: 'b', text: 'Dust' },
      { id: 'c', text: '' },
    ],
  });
  ins('link', { url: 'https://example.org' });
  ins('swatch', { hex: '#ff0000', text: '#ff0000' });
  db.prepare(
    "UPDATE items SET stage = 'design', data = json_set(data, '$.labels', json('[\"home\"]')) WHERE id = 'i_tlink'"
  ).run();
  const out = readBoard(root);
  const todo = out.loose.find(c => c.id === 'i_ttodo');
  assert.deepEqual(
    todo.tasks.map(t => t.text),
    ['Mop', 'Dust']
  );
  const text = boardText(out);
  assert.match(text, /todo: Chores \(1\/2 done\)/);
  assert.match(text, /link: https:\/\/example.org #home \[stage design\]/);
  assert.equal(cardTitle({ type: 'line', data: {} }), 'connection');
  assert.equal(cardTitle({ type: 'board', data: {} }), 'Board');
  assert.equal(cardTitle({ type: 'image', data: {} }), 'image');
});
