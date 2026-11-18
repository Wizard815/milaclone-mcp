'use strict';

import { state, dom, elMap, COLORS, BOARD_ICONS, SHAPES, SHAPE_ICONS } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons, isLocked, zRange, toast } from './util.js';
import { refreshItem, render } from './cards.js';
import { select, renameSelected, deleteSelection, selectedItems, saveData } from './editing.js';
import { copySelected, pasteClipboard, duplicateSelected, toggleLock } from './clipboard.js';
import { openConnectPicker, previewText } from './connect.js';
import { STAGE_LABELS, setStage, promoteItem } from './stages.js';

function positionPopup(anchor, w) {
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + 220 > window.innerHeight) top = Math.max(8, r.top - 228);
  dom.palette.style.left = Math.max(8, left) + 'px';
  dom.palette.style.top = top + 'px';
}

// Multi-select tag checklist + an "add new tag" field. Reuses dom.palette
// (same popup element/positioning/outside-click-to-dismiss as openPalette)
// but with its own content, since a tag checklist doesn't fit the
// swatch/icon-grid shapes that mode already handles.
//
// `items` is always an array -- a single card's tag button passes a
// 1-element array (see cards.js); a multi-selection's "Tag N items" context
// menu row (openCtx below) passes every selected item, so applying a tag
// applies it to all of them at once. A tag reads "on" only when *every*
// item in the batch already has it; clicking then removes it from all of
// them, otherwise adds it to whichever ones are missing it -- so one click
// always ends with the whole batch uniformly tagged or untagged.
export async function openTagPicker(items, anchor) {
  const known = new Set((await api.tags().catch(() => ({ tags: [] }))).tags || []);
  for (const it of items) for (const t of it.data.tags || []) known.add(t);
  const all = [...known].sort();

  const draw = () => {
    while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
    dom.palette.className = 'open tag-picker';

    if (items.length > 1) {
      const hdr = document.createElement('div');
      hdr.className = 'tag-picker-empty';
      hdr.textContent = `Tagging ${items.length} items`;
      dom.palette.appendChild(hdr);
    }

    const list = document.createElement('div');
    list.className = 'tag-picker-list';
    if (!all.length)
      list.appendChild(
        (() => {
          const e = document.createElement('div');
          e.className = 'tag-picker-empty';
          e.textContent = 'No tags yet';
          return e;
        })()
      );
    for (const tag of all) {
      const onAll = items.every(it => (it.data.tags || []).includes(tag));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tag-picker-item' + (onAll ? ' on' : '');
      row.appendChild(lucideEl(onAll ? 'check' : 'tag'));
      const label = document.createElement('span');
      label.textContent = tag;
      row.appendChild(label);
      row.onclick = () => {
        for (const it of items) {
          const tags = it.data.tags || [];
          const has = tags.includes(tag);
          if (onAll && has) saveData(it, { tags: tags.filter(t => t !== tag) });
          else if (!onAll && !has) saveData(it, { tags: tags.concat([tag]) });
          else continue;
          refreshItem(it);
        }
        draw();
      };
      list.appendChild(row);
    }
    dom.palette.appendChild(list);

    const field = document.createElement('div');
    field.className = 'tag-picker-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = all.length ? 'New tag' : 'First tag';
    input.setAttribute('aria-label', 'New tag');
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const tag = input.value.trim().replace(/^#/, '').toLowerCase();
      if (!tag) return;
      if (!all.includes(tag)) {
        all.push(tag);
        all.sort();
      }
      for (const it of items) {
        if (!(it.data.tags || []).includes(tag)) saveData(it, { tags: (it.data.tags || []).concat([tag]) });
        refreshItem(it);
      }
      input.value = '';
      draw();
    };
    field.appendChild(input);
    dom.palette.appendChild(field);

    positionPopup(anchor, 220);
    refreshIcons(dom.palette);
    if (!all.length) setTimeout(() => input.focus(), 0);
  };
  draw();
}

// Single date input + a clear button when a due date is already set. Reuses
// dom.palette the same way openTagPicker does.
export function openDueEditor(it, anchor) {
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
  dom.palette.className = 'open due-editor';

  const row = document.createElement('div');
  row.className = 'due-editor-row';
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'due-editor-input';
  input.value = it.data.due || '';
  input.setAttribute('aria-label', 'Due date');
  input.onchange = () => {
    saveData(it, { due: input.value || null });
    refreshItem(it);
    closePalette();
  };
  row.appendChild(input);
  dom.palette.appendChild(row);

  if (it.data.due) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'due-editor-clear';
    clear.appendChild(lucideEl('x'));
    clear.appendChild(document.createTextNode('Clear due date'));
    clear.onclick = () => {
      saveData(it, { due: null });
      refreshItem(it);
      closePalette();
    };
    dom.palette.appendChild(clear);
  }

  positionPopup(anchor, 200);
  refreshIcons(dom.palette);
}

// The floating color/icon palette and the right-click context menu.

// mode: 'color' | 'icon' | 'auto' (auto = colors, plus icons for boards — legacy badge path) | 'shape'
export function openPalette(it, anchor, mode = 'auto') {
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
  const showColor = mode === 'color' || mode === 'auto' || mode === 'shape';
  const showIcon = mode === 'icon' || (mode === 'auto' && it.type === 'board');
  const showShape = mode === 'shape';
  dom.palette.className =
    'open' + (showIcon || showShape ? ' board-palette' : '') + (mode === 'icon' ? ' icon-only' : '');

  if (showColor) {
    // The 12 colours, then None (null clears the colour) — except on cards that
    // fall back to a default colour, where None would look like a swatch.
    const none = ['todo', 'board', 'column'].includes(it.type) ? [] : [null];
    [...COLORS, ...none].forEach(c => {
      const sw = document.createElement('div');
      sw.className = 'sw' + (c ? '' : ' sw-none') + ((it.color || it._childColor || null) === c ? ' sel' : '');
      if (c) sw.style.background = colorVar(c);
      else sw.title = 'None';
      // Recolours the whole selection when this card is part of it.
      sw.onclick = () => {
        const targets = state.selection.has(it.id) && state.selection.size > 1 ? selectedItems() : [it];
        for (const t of targets) {
          t.color = c;
          if (t.type === 'board') t._childColor = c;
          api.patch(t.id, { color: c });
          refreshItem(t);
        }
        closePalette();
      };
      dom.palette.appendChild(sw);
    });
  }

  if (showIcon) {
    if (showColor) {
      const sep = document.createElement('div');
      sep.className = 'pal-sep';
      dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    const current = it._childIcon || 'layout-grid';
    BOARD_ICONS.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-pick' + (name === current ? ' sel' : '');
      btn.title = name;
      btn.appendChild(lucideEl(name));
      btn.onclick = () => {
        it._childIcon = name;
        api.patch(it.id, { data: { icon: name } });
        refreshItem(it);
        closePalette();
      };
      grid.appendChild(btn);
    });
    dom.palette.appendChild(grid);
  }

  if (showShape) {
    if (showColor) {
      const sep = document.createElement('div');
      sep.className = 'pal-sep';
      dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    const currentShape = it.data.shape || 'circle';
    SHAPES.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-pick' + (name === currentShape ? ' sel' : '');
      btn.title = name;
      btn.appendChild(lucideEl(SHAPE_ICONS[name] || 'circle'));
      btn.onclick = () => {
        saveData(it, { shape: name });
        refreshItem(it);
        closePalette();
      };
      grid.appendChild(btn);
    });
    dom.palette.appendChild(grid);

    const sep2 = document.createElement('div');
    sep2.className = 'pal-sep';
    dom.palette.appendChild(sep2);
    const fillRow = document.createElement('div');
    fillRow.className = 'pal-fill-row';
    [
      ['Hollow', false],
      ['Filled', true],
    ].forEach(([label, val]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pal-fill-btn' + (!!it.data.filled === val ? ' sel' : '');
      btn.textContent = label;
      btn.onclick = () => {
        saveData(it, { filled: val });
        refreshItem(it);
        closePalette();
      };
      fillRow.appendChild(btn);
    });
    dom.palette.appendChild(fillRow);

    const sep3 = document.createElement('div');
    sep3.className = 'pal-sep';
    dom.palette.appendChild(sep3);
    const thickRow = document.createElement('div');
    thickRow.className = 'pal-thick-row';
    const thickLabel = document.createElement('span');
    thickLabel.className = 'pal-thick-label';
    thickLabel.textContent = 'Thickness';
    const thickInput = document.createElement('input');
    thickInput.type = 'range';
    thickInput.min = '1';
    thickInput.max = '20';
    thickInput.step = '1';
    thickInput.value = it.data.thickness ?? 4;
    thickInput.className = 'pal-thick-input';
    // A slider mid-drag has no single "done" moment, so — unlike the
    // shape/fill buttons above — this one doesn't closePalette() on change.
    thickInput.addEventListener('input', () => {
      saveData(it, { thickness: Number(thickInput.value) });
      refreshItem(it);
    });
    thickRow.appendChild(thickLabel);
    thickRow.appendChild(thickInput);
    dom.palette.appendChild(thickRow);
  }

  const r = anchor.getBoundingClientRect();
  const w = showIcon || showShape ? 280 : 210;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + 220 > window.innerHeight) top = Math.max(8, r.top - 228);
  dom.palette.style.left = Math.max(8, left) + 'px';
  dom.palette.style.top = top + 'px';
  refreshIcons(dom.palette);
}

export function closePalette() {
  dom.palette.classList.remove('open', 'board-palette', 'icon-only', 'tag-picker', 'due-editor');
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
}

export function openCtx(e, it) {
  e.preventDefault();
  e.stopPropagation();
  // Right-clicking a card that's already part of a multi-selection keeps
  // the whole group selected (so batch actions below act on all of them)
  // instead of collapsing down to just this one.
  if (!state.selection.has(it.id)) select(it.id);
  const many = state.selection.size > 1;
  const targets = many ? selectedItems() : [it];
  const locked = isLocked(it);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';
  const rows = [
    { label: 'Cut', hint: mod + 'X', fn: () => copySelected(true) },
    { label: 'Copy', hint: mod + 'C', fn: () => copySelected(false) },
    { label: 'Paste', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !state.clipboard },
    { label: 'Duplicate', hint: mod + 'D', fn: () => duplicateSelected() },
    { sep: true },
  ];
  if (!it.parentItemId) {
    rows.push({ label: 'Bring to Front', fn: () => restack(it, 'front') });
    rows.push({ label: 'Send to Back', fn: () => restack(it, 'back') });
    rows.push({ sep: true });
  }
  if (!many && elMap.get(it.id)?.querySelector('[data-edit]')) {
    rows.push({ label: 'Rename', hint: 'Return', fn: () => renameSelected() });
  }
  rows.push({ label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() });
  if (it.type === 'board' && !many) rows.push({ label: 'Create Shortcut', fn: () => createShortcut(it) });
  if (it.type === 'image') {
    rows.push({
      label: it.data.transparent ? 'Show Background' : 'Transparent Background',
      fn: () => toggleTransparent(it),
    });
  }
  rows.push({ sep: true });
  const stageable = targets.filter(x => x.type !== 'line');
  if (stageable.length) {
    rows.push({ stages: stageable });
    if (!many && it.stage === 'code') rows.push(promoteRow(it));
    rows.push({ sep: true });
  }
  rows.push({
    label: many ? `Tag ${targets.length} items` : 'Tags',
    fn: () => openCtxTags(targets, e),
  });
  if (!many) rows.push({ label: 'Connect from here', fn: () => openConnectFrom(it) });
  rows.push({ sep: true });
  rows.push({
    label: many ? `Move ${state.selection.size} to Trash` : 'Move to Trash',
    hint: 'Delete',
    danger: true,
    fn: () => deleteSelection(),
  });
  dom.ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      dom.ctxmenu.appendChild(s);
      return;
    }
    if (r.stages) {
      dom.ctxmenu.appendChild(stageRow(r.stages));
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span');
    lab.textContent = r.label;
    b.appendChild(lab);
    if (r.hint) {
      const k = document.createElement('kbd');
      k.textContent = r.hint;
      b.appendChild(k);
    }
    if (r.note) {
      const n = document.createElement('small');
      n.className = 'ctx-note';
      n.textContent = r.note;
      b.appendChild(n);
      b.classList.add('has-note');
    }
    if (r.id) b.dataset.act = r.id;
    b.onclick = () => {
      closeCtx(); // every row, not just the ones whose action re-renders
      r.fn();
    };
    dom.ctxmenu.appendChild(b);
  });
  dom.ctxmenu.classList.add('open');
  const mw = 220,
    mh = dom.ctxmenu.offsetHeight || 280;
  let left = e.clientX,
    top = e.clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  dom.ctxmenu.style.left = left + 'px';
  dom.ctxmenu.style.top = top + 'px';
}

// Anchors the tag picker at the click point rather than a specific toolbar
// button, since this is opened from a context-menu row, not a card's own
// .card-tools -- closeCtx() below clears dom.ctxmenu's content before the
// picker reads any position from it, so a plain point is simpler than
// trying to reuse the (by-then-empty) menu element as the anchor.
function openCtxTags(items, e) {
  const anchor = {
    getBoundingClientRect: () => ({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY }),
  };
  closeCtx();
  openTagPicker(items, anchor);
}

// "Connect from here": places the new connect badge just to the right of
// the card that was right-clicked, so the resulting link reads as coming
// from that specific card rather than a bare drop-anywhere-on-the-board
// badge. openConnectPicker's placement math centers the badge on the world
// point it's given (offsetting by -w/2, -30), so we back that out here.
function openConnectFrom(it) {
  const w = 220;
  const worldPos = { x: (it.x || 0) + (it.w || 240) + 20 + w / 2, y: (it.y || 0) + 30 };
  openConnectPicker(worldPos, state.view.canvas.id, it.id, previewText(it));
}

// "Stage" row: Thought / Design / Code / none, as one segmented control.
// Applies to every card in a multi-selection at once.
function stageRow(items) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-stages';
  const lab = document.createElement('span');
  lab.className = 'ctx-stages-label';
  lab.textContent = 'Stage';
  wrap.appendChild(lab);
  const current = items.every(x => x.stage === items[0].stage) ? items[0].stage : undefined;
  for (const [val, text] of [...Object.entries(STAGE_LABELS), [null, 'None']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-stage' + (current === val ? ' on' : '') + (val ? ' stage-' + val : '');
    b.dataset.stage = val || 'none';
    b.textContent = text;
    b.onclick = () => {
      closeCtx();
      setStage(items, val);
    };
    wrap.appendChild(b);
  }
  return wrap;
}

function promoteRow(it) {
  if (it.data.promoted)
    return {
      label: 'Promoted to Orb',
      id: 'promote',
      disabled: true,
      note: it.data.promoted.name ? 'as "' + it.data.promoted.name + '"' : '',
    };
  if (!state.orb || !state.orb.configured) {
    return {
      label: 'Promote to a project',
      id: 'promote',
      disabled: true,
      note: 'Set ORB_URL (and ORB_TOKEN) on the Miladash server to enable this.',
    };
  }
  return {
    label: 'Promote to a project',
    id: 'promote',
    fn: () => {
      closeCtx();
      promoteItem(it);
    },
  };
}

// Stacking order: the selection (or just this card) goes above or below every
// other free card on the board, keeping its own internal order.
function restack(it, where) {
  const group = (state.selection.has(it.id) ? selectedItems() : [it]).filter(i => !i.parentItemId);
  const [lo, hi] = zRange(state.view.items);
  const ordered = group.sort((a, b) => (a.z || 0) - (b.z || 0));
  let z = where === 'front' ? hi : lo - ordered.length - 1;
  for (const g of ordered) g.z = ++z;
  api.patchMany(ordered.map(g => ({ id: g.id, z: g.z })));
  for (const g of ordered) refreshItem(g);
}

function toggleTransparent(it) {
  const transparent = !it.data.transparent;
  it.data = Object.assign({}, it.data, { transparent });
  api.patch(it.id, { data: { transparent } });
  refreshItem(it);
}

export function closeCtx() {
  dom.ctxmenu.classList.remove('open');
  dom.ctxmenu.innerHTML = '';
}

// F7.5: an alias card for `board`, placed beside it; cut/paste it to any board.
async function createShortcut(board) {
  const it = await api.create({
    canvasId: state.view.canvas.id,
    type: 'shortcut',
    x: board.x + 180,
    y: board.y,
    w: 152,
    data: { targetCanvasId: board.data.childCanvasId },
  });
  if (!it || it.error) return;
  it._target = { title: board._childTitle, color: board._childColor, icon: board._childIcon };
  state.view.items.push(it);
  render();
  select(it.id);
  toast('Shortcut made — cut and paste it onto any board');
}
