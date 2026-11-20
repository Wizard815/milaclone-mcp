#!/usr/bin/env node
'use strict';

// Fills a running board with made-up but coherent demo data: a small coffee
// roaster planning a spring launch, with panels grouping the work.
//   node scripts/seed-demo.js http://localhost:4321

const BASE = (process.argv[2] || 'http://localhost:4321').replace(/\/$/, '');
const H = { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {}) };
const call = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const item = (canvasId, type, x, y, data, extra = {}) => call('POST', '/api/item', { canvasId, type, x, y, data, ...extra });
const task = (text, done = false) => ({ id: Math.random().toString(36).slice(2, 10), text, done });
const panel = (c, title, x, y, w, h, color, shape = 'rounded') => item(c, 'panel', x, y, { title, shape }, { w, h, color });

(async () => {
  const { rootCanvasId: home } = await call('GET', '/api/root');
  const launch = await item(home, 'board', 80, 80, { title: 'Spring Launch', icon: 'sparkles' }, { color: 'orange' });
  const brand = await item(home, 'board', 280, 80, { title: 'Brand & Packaging', icon: 'palette' }, { color: 'pink' });
  const ops = await item(home, 'board', 480, 80, { title: 'Roastery Ops', icon: 'cpu' }, { color: 'teal' });
  await item(home, 'heading', 80, 260, { text: 'Lantern Coffee Roasters — 2027 plan' });
  await item(home, 'note', 80, 320, { title: 'Where things stand', body: 'Spring Launch is the priority. Seasonal single-origin line ships 14 April. Packaging refresh is in review; roastery ops tracks equipment and suppliers.' });
  const L = launch.data.childCanvasId, B = brand.data.childCanvasId, O = ops.data.childCanvasId;

  // ---- Spring Launch: four panels + some loose cards -----------------------
  await panel(L, 'Research', 40, 40, 520, 440, 'blue');
  await panel(L, 'Product', 620, 40, 580, 600, 'green');
  await panel(L, 'Marketing', 40, 540, 560, 520, 'purple');
  await panel(L, 'Launch Day', 660, 700, 520, 520, 'orange', 'ellipse');

  const n1 = await item(L, 'note', 70, 100, { title: 'Customer interviews', body: '12 cafe owners interviewed. Top ask: a washed Ethiopian that holds up as espresso. Price ceiling ~$19 per 12oz bag.' }, { w: 240 });
  const n2 = await item(L, 'note', 320, 100, { title: 'Competitor scan', body: 'Three local roasters launched spring lines last year. None offered subscriptions with a seasonal swap.' }, { w: 220 });
  await item(L, 'link', 70, 290, { title: 'SCA flavor wheel', url: 'https://sca.coffee/research/coffee-tasters-flavor-wheel' }, { w: 240 });
  await item(L, 'link', 320, 290, { title: 'Green coffee price index', url: 'https://www.ico.org/new_historical.asp' }, { w: 220 });

  const lots = await item(L, 'table', 650, 100, { rows: [['Lot', 'Origin', 'Cost/lb', 'Status'], ['Yirgacheffe G1', 'Ethiopia', '$7.40', 'Sampled'], ['Huila Washed', 'Colombia', '$5.95', 'Approved'], ['Kirinyaga AA', 'Kenya', '$8.20', 'Pending']] }, { w: 380 });
  const pt = await item(L, 'todo', 650, 290, { title: 'Product tasks', tasks: [task('Finalize roast profile for Yirgacheffe', true), task('Cup three batches blind'), task('Lock bag size at 12oz'), task('Order 2,000 valve bags')] }, { w: 260, stage: 'design' });
  await item(L, 'color', 940, 290, { hex: '#c4733a' }, { w: 120 });

  const col = await item(L, 'column', 70, 600, { title: 'Campaign ideas' }, { w: 252 });
  await item(L, 'note', 0, 0, { title: 'Subscription swap', body: 'Let subscribers swap one bag per quarter for the seasonal lot.' }, { parentItemId: col.id });
  await item(L, 'note', 0, 1, { title: 'Cafe takeover day', body: 'Partner cafes pull shots of the new lot for one day.' }, { parentItemId: col.id });
  const mt = await item(L, 'todo', 350, 600, { title: 'Marketing checklist', tasks: [task('Draft launch email', true), task('Shoot product photos'), task('Brief two micro-influencers'), task('Schedule social posts')] }, { w: 230, stage: 'thought' });

  const ld = await item(L, 'todo', 790, 830, { title: 'Launch day run-sheet', tasks: [task('6:00 roast first batch'), task('9:00 publish store page'), task('10:00 send announcement'), task('Noon: ship first 50 orders')] }, { w: 250 });

  // loose cards (deliberately not in any panel) + connectors
  const idea = await item(L, 'note', 1250, 100, { title: 'Open question', body: 'Do we offer a decaf option at launch? Revisit after the cupping.' }, { w: 220 });
  await item(L, 'comment', 1250, 280, { body: 'Ask the Huila supplier about a second lot for summer.' }, { w: 220 });
  await item(L, 'line', 0, 0, { fromId: n1.id, toId: lots.id, label: 'informs', kind: 'relates' });
  await item(L, 'line', 0, 0, { fromId: pt.id, toId: ld.id, label: 'must finish first', kind: 'depends' });

  // ---- Brand & Packaging ------------------------------------------------------
  await panel(B, 'Packaging', 40, 40, 560, 380, 'pink');
  await item(B, 'note', 70, 100, { title: 'Bag design brief', body: 'Matte kraft bag, one-color print, a hand-drawn lantern mark on the front. Tasting notes on a removable sticker so the bag lasts across seasons.' }, { w: 250 });
  await item(B, 'todo', 340, 100, { title: 'Packaging tasks', tasks: [task('Get three printer quotes', true), task('Approve dieline'), task('Order sticker proofs')] }, { w: 230 });
  await item(B, 'color', 70, 300, { hex: '#c4733a' }, { w: 120 });
  await item(B, 'color', 210, 300, { hex: '#2b2118' }, { w: 120 });
  await item(B, 'heading', 650, 60, { text: 'Voice & tone' });
  await item(B, 'note', 650, 120, { title: 'Writing style', body: 'Warm, plain, a little dry. Say what is in the bag; skip the poetry about mountains.' }, { w: 260 });

  // ---- Roastery Ops -------------------------------------------------------------
  await item(O, 'todo', 60, 60, { title: 'Equipment', tasks: [task('Descale the 5kg roaster', true), task('Replace afterburner thermocouple'), task('Calibrate the scale')] }, { w: 250 });
  const sup = await item(O, 'board', 340, 60, { title: 'Supplier contacts', icon: 'briefcase' }, { color: 'teal' });
  await item(sup.data.childCanvasId, 'note', 60, 60, { title: 'Huila Direct', body: 'Contact: Marisol Vega. Lead time 5 weeks. Net 30.' }, { w: 240 });
  await item(sup.data.childCanvasId, 'note', 320, 60, { title: 'Highland Imports', body: 'Contact: Daniel Okoro. Ethiopian and Kenyan lots. Prepay on first order.' }, { w: 240 });
  await item(O, 'note', 60, 280, { title: 'Weekly roast schedule', body: 'Mon/Thu: house blend. Tue: single origins. Wed: wholesale. Fri: packing and shipping.' }, { w: 280 });

  console.log(JSON.stringify({ home, launch: L, brand: B, ops: O, suppliers: sup.data.childCanvasId, idea: idea.id }));
})().catch(e => { console.error(e); process.exit(1); });
