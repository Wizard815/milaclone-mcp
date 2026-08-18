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
let pendingSourceCanvasId = null;
let pendingSourceItemId = null;
let pendingSourcePreview = null; // e.g. "comment" -- the source card's own preview text, when known
let browseCanvasId = null;

// Not shared with mindmap.js's own icon map -- a couple of duplicated
// icon-name entries is cheaper than a circular import between the two
// modules (mindmap.js already imports from this file).
const ICONS = {
  note: 'file-text', todo: 'list-checks', link: 'link-2', heading: 'heading-1',
  document: 'file-text', table: 'table', color: 'palette', draw: 'pencil',
  comment: 'message-circle', column: 'columns-3', file: 'file', image: 'image'
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

export function previewText(it) {
  const d = it.data || {};
  return d.title || d.text || (d.body && d.body.slice(0, 40)) || d.url || it.type;
}

export function isConnectPickerOpen() { return !!pendingWorld; }

// sourceCanvasId: which board the new connect badge is created on. Defaults
// to whatever board is currently open (the normal arm-tool-and-click flow);
// callers outside the canvas (the mind map's right-click menu) pass it
// explicitly since there's no "current board" in that context.
// sourceItemId: the existing card (if any) this connection is "from" —
// set by "Connect from here" on a card's context menu, on the canvas or in
// the mind map. Lets the mind map draw the edge starting at that specific
// card's satellite node instead of just the board it lives on.
// sourcePreview: that source card's own preview text (e.g. "comment"),
// when the caller already has the item in hand -- used to label the badge
// "source → target" instead of the generic "target's board → target".
export function openConnectPicker(worldPos, sourceCanvasId, sourceItemId, sourcePreview) {
  pendingWorld = worldPos;
  pendingSourceCanvasId = sourceCanvasId || state.view.canvas.id;
  pendingSourceItemId = sourceItemId || null;
  pendingSourcePreview = sourceItemId ? (sourcePreview || null) : null;
  browseCanvasId = pendingSourceCanvasId;
  refs().root.hidden = false;
  renderPicker();
}

function closePicker() {
  refs().root.hidden = true;
  pendingWorld = null;
  pendingSourceItemId = null;
  pendingSourcePreview = null;
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
  r.linkHere.onclick = () => confirmTarget(browseCanvasId, null, data.canvas.title, data.canvas.title);

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
    row.onclick = () => confirmTarget(browseCanvasId, it.id, previewText(it), data.canvas.title);
    r.list.appendChild(row);
  }
  refreshIcons(r.list);
  refreshIcons(r.crumbs);
}

// targetPreview: the target's own preview text (item preview, or the board
// title when linking to a whole board). targetBoardTitle: the board the
// target lives on, used only as a fallback label when there's no known
// source card to name instead.
async function confirmTarget(targetCanvasId, targetItemId, targetPreview, targetBoardTitle) {
  if (!pendingWorld) return;
  const sourceCanvasId = pendingSourceCanvasId;
  const label = pendingSourcePreview
    ? `${pendingSourcePreview} → ${targetPreview}`
    : (targetItemId ? `${targetBoardTitle} → ${targetPreview}` : targetPreview);
  const body = {
    canvasId: sourceCanvasId, type: 'connect',
    x: Math.round(pendingWorld.x - 110), y: Math.round(pendingWorld.y - 30), w: 220,
    data: { sourceItemId: pendingSourceItemId, targetCanvasId, targetItemId, targetLabel: label, note: '' }
  };
  const it = await api.create(body);
  // Only touch the live board state (and select the new card) if we created
  // it on the board actually open right now — the mind map's "connect from
  // here" can target a board that isn't the one on screen.
  if (state.view.canvas && sourceCanvasId === state.view.canvas.id) {
    state.view.items.push(it);
    render();
    select(it.id);
  }
  closePicker();
  toast('Connected');
}

// Centers the *main canvas's* camera on a world point — used instead of
// scrollIntoView() since items live inside #world's pan/zoom transform,
// which the DOM's own scroll machinery knows nothing about.
function centerCameraOn(x, y) {
  const vw = dom.stage.clientWidth, vh = dom.stage.clientHeight;
  state.cam.x = vw / 2 - x * state.cam.scale;
  state.cam.y = vh / 2 - y * state.cam.scale;
  applyCam();
}

export async function navigateToTarget(targetCanvasId, targetItemId) {
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

export function navigateToConnect(it) {
  return navigateToTarget(it.data.targetCanvasId, it.data.targetItemId);
}

export function initConnectPicker() {
  const r = refs();
  r.close.addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (!pendingWorld) return;
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  });
}
