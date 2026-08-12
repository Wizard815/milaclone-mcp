'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { toast, imageSize } from './util.js';
import { screenToWorld, applyCam } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { select, deselect } from './editing.js';
import { render } from './cards.js';
import { cancelLine } from './lines.js';
import { openConnectPicker } from './connect.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

export function arm(tool, btn) {
  disarm();
  state.armed = tool; dom.stage.classList.add('armed');
  btn.classList.add('armed');
  let msg = 'Tap the canvas to place your ' + tool;
  if (tool === 'line') msg = 'Click a card, then another to connect them';
  else if (tool === 'connect') msg = 'Tap the canvas to link somewhere else';
  toast(msg);
}

export function disarm() {
  state.armed = null; state.lineFrom = null; dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed, .mtool.armed').forEach(b => b.classList.remove('armed'));
}

function placeAt(type, clientX, clientY) {
  const w = screenToWorld(clientX, clientY);
  if (type === 'image') { state.pendingImageWorld = w; dom.fileInput.click(); }
  else if (type === 'upload') { state.pendingUploadWorld = w; dom.uploadInput.click(); }
  else if (type === 'connect') { openConnectPicker(w); }
  else createAt(type, w.x - defaultsFor(type).w / 2, w.y - 20);
}

// Press-and-hold-then-drag placement: mirrors the tap-to-arm flow below, but
// lets a tool button be dragged straight onto the canvas in one gesture.
// Delegated on document so it also covers the mobile tray's cloned buttons.
function initDragPlace() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest('.tool[data-tool], .mtool[data-tool]');
    if (!btn || btn.dataset.tool === 'line') return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, ghost = null;

    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        disarm();
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.innerHTML = btn.innerHTML;
        document.body.appendChild(ghost);
        dom.stage.classList.add('armed');
      }
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    };

    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      dom.stage.classList.remove('armed');
      if (ghost) ghost.remove();
      if (!dragging) return; // no movement: let the click event arm the tool as usual
      state.suppressNextClick = true;
      const overStage = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#stage');
      if (overStage) placeAt(btn.dataset.tool, ev.clientX, ev.clientY);
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

// Wire up the rail buttons, canvas pan/place, and the upload inputs. Called once at boot.
export function initTools() {
  document.querySelectorAll('#railCreate .tool').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.suppressNextClick) { state.suppressNextClick = false; return; }
      const t = btn.dataset.tool;
      if (state.armed === t) { disarm(); return; }
      arm(t, btn);
    });
  });
  initDragPlace();

  dom.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (state.pinching) return;
    if (state.armed === 'line') { cancelLine(); return; }
    if (state.armed) {
      const t = state.armed; disarm();
      placeAt(t, e.clientX, e.clientY);
      return;
    }
    deselect();
    state.pan = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
    dom.stage.classList.add('panning');
    const move = (ev) => { if (state.pinching || !state.pan) return; state.cam.x = state.pan.cx + (ev.clientX - state.pan.sx); state.cam.y = state.pan.cy + (ev.clientY - state.pan.sy); applyCam(); };
    const up = () => { state.pan = null; dom.stage.classList.remove('panning'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  dom.fileInput.addEventListener('change', async () => {
    const file = dom.fileInput.files[0]; dom.fileInput.value = '';
    if (!file) return;
    toast('Uploading image…');
    const res = await api.upload(file);
    if (res.error) { toast('Upload failed'); return; }
    const dim = await imageSize(res.src);
    const w = state.pendingImageWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const it = await api.create({
      canvasId: state.view.canvas.id, type: 'image',
      x: Math.round(w.x - 130), y: Math.round(w.y - 90), w: 260,
      data: { src: res.src, name: res.name, naturalW: dim.w, naturalH: dim.h }
    });
    state.view.items.push(it); render(); select(it.id); toast('Image added');
    state.pendingImageWorld = null;
  });

  dom.uploadInput.addEventListener('change', async () => {
    const file = dom.uploadInput.files[0]; dom.uploadInput.value = '';
    if (!file) return;
    toast('Uploading file…');
    const res = await api.upload(file);
    if (res.error) { toast('Upload failed'); return; }
    const w = state.pendingUploadWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const it = await api.create({
      canvasId: state.view.canvas.id, type: 'file',
      x: Math.round(w.x - 110), y: Math.round(w.y - 40), w: 220,
      data: { src: res.src, name: res.name, mime: res.mime || file.type }
    });
    state.view.items.push(it); render(); select(it.id); toast('File added');
    state.pendingUploadWorld = null;
  });
}
