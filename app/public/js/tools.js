'use strict';

import { state, dom } from './state.js';
import { toast } from './util.js';
import { addFiles } from './capture.js';
import { screenToWorld, applyCam, cancelCamAnimation } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { deselect, selectIds } from './editing.js';
import { elMap } from './state.js';
import { cancelLine } from './lines.js';
import { openConnectPicker } from './connect.js';
import { pickTemplate } from './templates.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

export function arm(tool, btn) {
  disarm();
  state.armed = tool;
  dom.stage.classList.add('armed');
  btn.classList.add('armed');
  let msg = 'Tap the canvas to place your ' + tool;
  if (tool === 'line') msg = 'Click a card, then another to connect them';
  else if (tool === 'connect') msg = 'Tap the canvas to link somewhere else';
  else if (tool === 'template') msg = 'Tap where the copy should go';
  toast(msg);
}

export function disarm() {
  state.armed = null;
  state.lineFrom = null;
  dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed, .mtool.armed').forEach(b => b.classList.remove('armed'));
}

function placeAt(type, clientX, clientY) {
  const w = screenToWorld(clientX, clientY);
  if (type === 'image') {
    state.pendingImageWorld = w;
    dom.fileInput.click();
  } else if (type === 'upload') {
    state.pendingUploadWorld = w;
    dom.uploadInput.click();
  } else if (type === 'connect') {
    openConnectPicker(w);
  } else if (type === 'template') {
    pickTemplate(w);
  } else createAt(type, w.x - defaultsFor(type).w / 2, w.y - 20);
}

// Selection box: every free card it touches is selected (shift, ctrl or cmd adds
// to the current selection). The selection updates live while dragging. Card rects are
// measured once (nothing moves mid-box), and the stage captures the pointer so a
// release outside the window still ends the box.
function startMarquee(e) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const base = additive ? [...state.selection] : [];
  if (!additive) deselect();
  const box = document.createElement('div');
  box.className = 'marquee';
  dom.stage.appendChild(box);
  const sr = dom.stage.getBoundingClientRect();
  const cards = state.view.items
    .filter(i => !i.parentItemId && elMap.get(i.id))
    .map(i => ({ id: i.id, r: elMap.get(i.id).getBoundingClientRect() }));
  const sx = e.clientX,
    sy = e.clientY;
  let moved = false;
  let lastHit = '';
  dom.stage.setPointerCapture(e.pointerId);
  const move = ev => {
    const l = Math.min(sx, ev.clientX),
      t = Math.min(sy, ev.clientY),
      r = Math.max(sx, ev.clientX),
      b = Math.max(sy, ev.clientY);
    if (!moved && r - l < 3 && b - t < 3) return;
    moved = true;
    Object.assign(box.style, {
      left: l - sr.left + 'px',
      top: t - sr.top + 'px',
      width: r - l + 'px',
      height: b - t + 'px',
    });
    const hit = cards.filter(c => c.r.left < r && c.r.right > l && c.r.top < b && c.r.bottom > t).map(c => c.id);
    const key = hit.join(',');
    if (key !== lastHit) {
      lastHit = key;
      selectIds([...new Set([...base, ...hit])]);
    }
  };
  const end = () => {
    box.remove();
    dom.stage.removeEventListener('pointermove', move);
    dom.stage.removeEventListener('pointerup', end);
    dom.stage.removeEventListener('pointercancel', end);
  };
  dom.stage.addEventListener('pointermove', move);
  dom.stage.addEventListener('pointerup', end);
  dom.stage.addEventListener('pointercancel', end);
}

// Press-and-hold-then-drag placement: mirrors the tap-to-arm flow below, but
// lets a tool button be dragged straight onto the canvas in one gesture.
// Delegated on document so it also covers the mobile tray's cloned buttons.
function initDragPlace() {
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const btn = e.target.closest('.tool[data-tool], .mtool[data-tool]');
    if (!btn || btn.dataset.tool === 'line' || btn.dataset.tool === 'select') return;
    const startX = e.clientX,
      startY = e.clientY;
    let dragging = false,
      ghost = null;

    const move = ev => {
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
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
    };

    const up = ev => {
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
      if (state.suppressNextClick) {
        state.suppressNextClick = false;
        return;
      }
      const t = btn.dataset.tool;
      if (state.armed === t) {
        disarm();
        return;
      }
      arm(t, btn);
    });
  });
  initDragPlace();

  dom.stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (state.pinching) return;
    cancelCamAnimation();
    if (state.armed === 'line') {
      cancelLine();
      return;
    }
    // Box-select: the Select tool, or Shift+drag on empty canvas with any
    // tool disarmed. The selected cards then drag as one group.
    if (state.armed === 'select' || (!state.armed && e.shiftKey && e.button === 0 && !state.spaceDown)) {
      startMarquee(e);
      return;
    }
    if (state.armed) {
      const t = state.armed;
      disarm();
      placeAt(t, e.clientX, e.clientY);
      return;
    }
    // Anything else on empty canvas pans: left-drag, middle-drag, space-drag, touch.
    e.preventDefault(); // middle-click autoscroll
    deselect();
    state.pan = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
    dom.stage.classList.add('panning');
    const move = ev => {
      if (state.pinching || !state.pan) return;
      state.cam.x = state.pan.cx + (ev.clientX - state.pan.sx);
      state.cam.y = state.pan.cy + (ev.clientY - state.pan.sy);
      applyCam();
    };
    const up = () => {
      state.pan = null;
      dom.stage.classList.remove('panning');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  // Picked files land where the tool was clicked (several at once lay out in a grid).
  const onPicked = (input, key) =>
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      const at = state[key] || undefined;
      state[key] = null;
      if (files.length) addFiles(files, at);
    });
  onPicked(dom.fileInput, 'pendingImageWorld');
  onPicked(dom.uploadInput, 'pendingUploadWorld');
}
