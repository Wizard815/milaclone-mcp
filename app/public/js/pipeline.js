'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast, refreshIcons, colorVar } from './util.js';
import { STAGE_LABELS } from './stages.js';
import { navigateToTarget } from './connect.js';
import { render } from './cards.js';

// Pipeline view: every card with a stage, across the whole workspace, in
// Thought / Design / Code columns ordered by last change. Dragging a card
// to another column changes its stage. This is the only place where a
// card's position means its stage; the board itself is a free canvas.

const el = (id) => document.getElementById(id);
let items = [];

export function isPipelineOpen() { return !el('pipelineView').hidden; }

async function openPipeline() {
  el('pipelineView').hidden = false;
  await load();
}

function closePipeline() {
  el('pipelineView').hidden = true;
  // The current board may hold cards whose stage changed here.
  if (state.view.canvas) {
    const changed = new Map(items.map(i => [i.id, i.stage]));
    let dirty = false;
    for (const it of state.view.items) {
      if (changed.has(it.id) && changed.get(it.id) !== it.stage) { it.stage = changed.get(it.id); dirty = true; }
    }
    if (dirty) render();
  }
}

async function load() {
  const res = await api.pipeline();
  items = res.items || [];
  draw();
}

function cardFor(it) {
  const c = document.createElement('div');
  c.className = 'pl-card' + (it.data && it.data.promoted ? ' promoted' : '');
  c.dataset.id = it.id;
  c.style.setProperty('--pl-accent', colorVar(it.color || it._childColor || 'slate'));
  const t = document.createElement('div'); t.className = 'pl-title'; t.textContent = it._title || 'Untitled';
  c.appendChild(t);
  const pitch = it.type === 'note' ? (it.data.body || '').split('\n').find(l => l.trim()) : '';
  if (pitch) { const p = document.createElement('div'); p.className = 'pl-pitch'; p.textContent = pitch; c.appendChild(p); }
  const meta = document.createElement('div'); meta.className = 'pl-meta';
  const where = document.createElement('span'); where.textContent = it._canvasTitle || ''; meta.appendChild(where);
  const when = document.createElement('span'); when.textContent = ago(it.updatedAt || it.createdAt); meta.appendChild(when);
  if (it.data && it.data.promoted) { const p = document.createElement('span'); p.className = 'promoted-chip'; p.textContent = 'Project'; meta.appendChild(p); }
  c.appendChild(meta);
  c.addEventListener('pointerdown', (e) => startDrag(e, it, c));
  return c;
}

function draw() {
  const cols = el('plCols');
  cols.innerHTML = '';
  for (const [stage, label] of Object.entries(STAGE_LABELS)) {
    const col = document.createElement('section');
    col.className = 'pl-col stage-' + stage;
    col.dataset.stage = stage;
    const mine = items.filter(i => i.stage === stage).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const h = document.createElement('h4');
    h.innerHTML = `<span class="stage-chip stage-${stage}"></span><span class="pl-count"></span>`;
    h.firstChild.textContent = label;
    h.lastChild.textContent = String(mine.length);
    col.appendChild(h);
    const body = document.createElement('div'); body.className = 'pl-body';
    if (!mine.length) { const e = document.createElement('div'); e.className = 'pl-empty'; e.textContent = 'Nothing here yet'; body.appendChild(e); }
    mine.forEach(it => body.appendChild(cardFor(it)));
    col.appendChild(body);
    cols.appendChild(col);
  }
  if (!items.length) {
    const hint = document.createElement('p'); hint.className = 'pl-hint-empty';
    hint.textContent = 'No staged ideas yet. Right-click a card on the board and pick Thought, Design or Code.';
    cols.appendChild(hint);
  }
  refreshIcons(cols);
}

// Pointer drag (not HTML5 drag and drop) so it behaves the same with mouse,
// pen and touch. A plain click opens the card on its board instead.
function startDrag(e, it, card) {
  if (e.button !== 0) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  const r = card.getBoundingClientRect();
  let ghost = null;
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest('.pl-col');
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = card.cloneNode(true);
      ghost.classList.add('pl-ghost');
      ghost.style.width = r.width + 'px';
      document.body.appendChild(ghost);
      card.classList.add('pl-dragging');
    }
    ghost.style.left = (r.left + ev.clientX - sx) + 'px';
    ghost.style.top = (r.top + ev.clientY - sy) + 'px';
    ghost.style.pointerEvents = 'none';
    document.querySelectorAll('.pl-col.drop').forEach(c => c.classList.remove('drop'));
    const col = colAt(ev.clientX, ev.clientY);
    if (col && col.dataset.stage !== it.stage) col.classList.add('drop');
  };
  const up = async (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.querySelectorAll('.pl-col.drop').forEach(c => c.classList.remove('drop'));
    if (!ghost) {
      closePipeline();
      await navigateToTarget(it.canvasId, it.id);
      return;
    }
    ghost.remove();
    card.classList.remove('pl-dragging');
    const col = colAt(ev.clientX, ev.clientY);
    if (!col || col.dataset.stage === it.stage) return;
    const stage = col.dataset.stage;
    it.stage = stage;
    it.updatedAt = Date.now();
    draw();
    const res = await api.patch(it.id, { stage });
    if (res && res.updatedAt) it.updatedAt = res.updatedAt;
    toast(`Moved to ${STAGE_LABELS[stage]}`);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

export function initPipeline() {
  el('pipelineBtn').addEventListener('click', openPipeline);
  el('plClose').addEventListener('click', closePipeline);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPipelineOpen()) { e.preventDefault(); closePipeline(); }
  });
}
