'use strict';

// Miladash: the idea pipeline (stage chips, Pipeline view), promote-to-Orb and
// JSON Canvas import/export. Stage and updatedAt live on `items` (see db.js);
// create/update validation is in routes.js next to the other item routes.

const express = require('express');
const { stmt, rowToItem, richParts, STAGES } = require('./db');
const canvasFile = require('./canvasfile');

const router = express.Router();

// What a card is called in lists: its title, else the first line of its text.
function previewTextFor(it) {
  const d = it.data || {};
  const text = typeof d.text === 'string' ? d.text.split('\n').find(l => l.trim()) : '';
  return d.title || text || (d.body && d.body.slice(0, 40)) || d.url || it.type;
}

function boardInfo(it) {
  if (it.type !== 'board' || !it.data || !it.data.childCanvasId) return it;
  const child = stmt.getCanvas.get(it.data.childCanvasId);
  if (!child) return it;
  return Object.assign(it, {
    _childTitle: child.title,
    _childCount: stmt.cardCount.get(child.id).c,
    _childColor: child.color,
    _childIcon: child.icon || 'layout-grid',
  });
}

const titleOf = it => (it.type === 'board' ? it._childTitle || 'Board' : previewTextFor(it));

// ---- Pipeline ------------------------------------------------------------------
// Every card with a stage, anywhere in the tree, newest change first.
router.get('/api/pipeline', (req, res) => {
  const canvasTitles = new Map(stmt.allCanvases.all().map(c => [c.id, c.title]));
  const items = stmt.stagedItems
    .all()
    .map(rowToItem)
    .filter(it => canvasTitles.has(it.canvasId))
    .map(boardInfo)
    .map(it => Object.assign(it, { _title: titleOf(it), _canvasTitle: canvasTitles.get(it.canvasId) }));
  res.json({ stages: STAGES, items });
});

// ---- Promote to Orb --------------------------------------------------------------
// A Code-stage idea becomes a project in Pondering Orb. The browser only talks to
// this route; ORB_TOKEN stays on the server.
function orbConfig() {
  const url = (process.env.ORB_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.ORB_TOKEN || '').trim();
  return { url, token };
}

// Orb's project name is also its wiki note's file name and [[link]], so it refuses
// / \ [ ] | # ^ : * ? " < > and line breaks. Turn them into something readable:
// "Argos: scheduler" -> "Argos - scheduler".
function orbName(title) {
  const n = String(title || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[[\]#^*?"<>\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .trim()
    .slice(0, 200);
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
  if (!url)
    return res
      .status(409)
      .json({ error: 'ORB_URL is not set on the Miladash server, so there is no Orb to promote to.' });
  if (it.stage !== 'code') return res.status(409).json({ error: 'Only ideas at the Code stage can be promoted.' });
  if (it.data.promoted) return res.status(409).json({ error: 'Already promoted.', promoted: it.data.promoted });

  const name = orbName(titleOf(it));
  const body = it.type === 'note' ? richParts(it.data).body : it.data.pitch || '';
  const next = String((req.body && req.body.next) || body.split('\n').find(l => l.trim()) || '')
    .trim()
    .slice(0, 300);

  let resp, doc;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    resp = await fetch(url + '/api/c/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, next, status: 'next' }),
      signal: AbortSignal.timeout(10000),
    });
    doc = await resp.json().catch(() => ({}));
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Orb: ' + (e.message || e) });
  }
  if (!resp.ok) return res.status(502).json({ error: `Orb answered ${resp.status}: ${(doc && doc.error) || 'error'}` });

  // Re-read in case the card changed while Orb was answering.
  const fresh = rowToItem(stmt.getItem.get(it.id) || row);
  fresh.data = Object.assign({}, fresh.data, {
    promoted: { at: Date.now(), projectId: doc && doc.id ? String(doc.id) : null, name },
  });
  stmt.updateItem.run({
    id: fresh.id,
    canvasId: fresh.canvasId,
    parentItemId: fresh.parentItemId ?? null,
    type: fresh.type,
    x: fresh.x,
    y: fresh.y,
    w: fresh.w,
    h: fresh.h ?? null,
    z: fresh.z,
    color: fresh.color ?? null,
    data: JSON.stringify(fresh.data),
  });
  stmt.setStage.run({ id: fresh.id, stage: fresh.stage, updatedAt: Date.now() });
  res.json({ item: boardInfo(rowToItem(stmt.getItem.get(fresh.id))), project: doc });
});

// ---- JSON Canvas -------------------------------------------------------------------
router.get('/api/canvas/:id/export', (req, res) => {
  const nested = req.query.nested === '1' || req.query.nested === 'true';
  const out = canvasFile.exportCanvas(req.params.id, { nested });
  if (!out) return res.status(404).json({ error: 'not found' });
  const canvas = stmt.getCanvas.get(req.params.id);
  const file =
    (canvas.title || 'board')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'board';
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
    y: Number.isFinite(b.y) ? b.y : 60,
  });
  res.json(boardInfo(rowToItem(stmt.getItem.get(item.id))));
});

module.exports = router;
module.exports.orbName = orbName;
