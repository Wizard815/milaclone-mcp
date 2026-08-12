'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { toast, lucideEl, refreshIcons } from './util.js';
import { applyCam } from './viewport.js';
import { render } from './cards.js';
import { select } from './editing.js';
import { openCanvas } from './main.js';

// Cross-board "connect" badges: a card that jumps straight to another card
// (possibly several boards deep) elsewhere in the workspace. Creating one
// goes through a small board-browser picker instead of the usual
// place-immediately flow, since the target lives outside the current board
// entirely and has to be found first.

let pendingWorld = null;
let browseCanvasId = null;

const ICONS = {
  note: 'file-text', todo: 'list-checks', link: 'link-2', heading: 'heading-1',
  document: 'file-text', table: 'table', color: 'palette', draw: 'pencil',
  comment: 'message-circle', column: 'columns-3', file: 'file', image: 'image', connect: 'radar'
};

function refs() {
  return {
    root: document.getElementById('connectPicker'),
    close: document.getElementById('cpClose'),
    crumbs: document.getElementById('cpCrumbs'),
    linkHere: document.getElementById('cpLinkHere'),
    list: document.getElementById('cpList')
  };
}

function previewText(it) {
  const d = it.data || {};
  return d.title || d.text || (d.body && d.body.slice(0, 40)) || d.url || it.type;
}

export function isConnectPickerOpen() { return !!pendingWorld; }

export function openConnectPicker(worldPos) {
  pendingWorld = worldPos;
  browseCanvasId = state.view.canvas.id;
  refs().root.hidden = false;
  renderPicker();
}

function closePicker() {
  refs().root.hidden = true;
  pendingWorld = null;
}

async function renderPicker() {
  const r = refs();
  const data = await api.canvas(browseCanvasId);
  const crumbs = data.breadcrumb || [];

  r.crumbs.innerHTML = '';
  crumbs.forEach((c, i) => {
    const b = document.createElement('button');
    b.textContent = c.title;
    b.className = 'cp-crumb' + (i === crumbs.length - 1 ? ' current' : '');
    b.onclick = () => { browseCanvasId = c.id; renderPicker(); };
    r.crumbs.appendChild(b);
    if (i < crumbs.length - 1) {
      const sep = document.createElement('span'); sep.className = 'cp-sep'; sep.textContent = '/';
      r.crumbs.appendChild(sep);
    }
  });

  r.linkHere.textContent = `Link to "${data.canvas.title}"`;
  r.linkHere.onclick = () => confirmTarget(browseCanvasId, null, data.canvas.title);

  r.list.innerHTML = '';
  const boards = data.items.filter(it => it.type === 'board' && it.data.childCanvasId);
  const others = data.items.filter(it => !['board', 'line', 'connect'].includes(it.type) && !it.parentItemId);
  for (const b of boards) {
    const row = document.createElement('button'); row.className = 'cp-row cp-row-board';
    row.appendChild(lucideEl(b._childIcon || 'layout-grid'));
    const span = document.createElement('span'); span.textContent = b._childTitle || 'Board'; row.appendChild(span);
    row.appendChild(lucideEl('chevron-right'));
    row.onclick = () => { browseCanvasId = b.data.childCanvasId; renderPicker(); };
    r.list.appendChild(row);
  }
  for (const it of others) {
    const row = document.createElement('button'); row.className = 'cp-row';
    row.appendChild(lucideEl(ICONS[it.type] || 'square'));
    const span = document.createElement('span'); span.textContent = previewText(it); row.appendChild(span);
    row.onclick = () => confirmTarget(browseCanvasId, it.id, `${data.canvas.title} → ${previewText(it)}`);
    r.list.appendChild(row);
  }
  refreshIcons(r.list);
  refreshIcons(r.crumbs);
}

async function confirmTarget(targetCanvasId, targetItemId, label) {
  if (!pendingWorld) return;
  const body = {
    canvasId: state.view.canvas.id, type: 'connect',
    x: Math.round(pendingWorld.x - 110), y: Math.round(pendingWorld.y - 30), w: 220,
    data: { targetCanvasId, targetItemId, targetLabel: label, note: '' }
  };
  const it = await api.create(body);
  state.view.items.push(it);
  render();
  select(it.id);
  closePicker();
  toast('Connected');
}

// Centers the camera on a world point — used instead of scrollIntoView()
// since items live inside #world's pan/zoom transform, which the DOM's own
// scroll machinery knows nothing about.
function centerCameraOn(x, y) {
  const vw = dom.stage.clientWidth, vh = dom.stage.clientHeight;
  state.cam.x = vw / 2 - x * state.cam.scale;
  state.cam.y = vh / 2 - y * state.cam.scale;
  applyCam();
}

export async function navigateToConnect(it) {
  const { targetCanvasId, targetItemId } = it.data;
  if (!targetCanvasId) { toast('This link has no target'); return; }
  await openCanvas(targetCanvasId);
  if (targetItemId) {
    const target = state.view.items.find(x => x.id === targetItemId);
    if (target) {
      select(target.id);
      centerCameraOn((target.x || 0) + (target.w || 240) / 2, (target.y || 0) + 60);
    } else {
      toast('That card no longer exists');
    }
  }
}

export function initConnectPicker() {
  const r = refs();
  r.close.addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (!pendingWorld) return;
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  });
}
