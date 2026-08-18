'use strict';

import { state, dom, COLORS, BOARD_ICONS, SHAPES, SHAPE_ICONS } from './state.js';
import { api } from './api.js';
import { colorVar, lucideEl, refreshIcons, isLocked } from './util.js';
import { refreshItem } from './cards.js';
import { select, renameSelected, deleteItem, saveData } from './editing.js';
import { copySelected, pasteClipboard, duplicateSelected, toggleLock } from './clipboard.js';

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
export async function openTagPicker(it, anchor) {
  const known = new Set((await api.tags().catch(() => ({ tags: [] }))).tags || []);
  for (const t of it.data.tags || []) known.add(t);
  const all = [...known].sort();

  const draw = () => {
    while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
    dom.palette.className = 'open tag-picker';

    const list = document.createElement('div');
    list.className = 'tag-picker-list';
    if (!all.length) list.appendChild((() => {
      const e = document.createElement('div'); e.className = 'tag-picker-empty'; e.textContent = 'No tags yet';
      return e;
    })());
    for (const tag of all) {
      const on = (it.data.tags || []).includes(tag);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tag-picker-item' + (on ? ' on' : '');
      row.appendChild(lucideEl(on ? 'check' : 'tag'));
      const label = document.createElement('span'); label.textContent = tag; row.appendChild(label);
      row.onclick = () => {
        const tags = it.data.tags || [];
        saveData(it, { tags: on ? tags.filter(t => t !== tag) : tags.concat([tag]) });
        refreshItem(it);
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
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const tag = input.value.trim().replace(/^#/, '').toLowerCase();
      if (!tag) return;
      if (!all.includes(tag)) { all.push(tag); all.sort(); }
      if (!(it.data.tags || []).includes(tag)) saveData(it, { tags: (it.data.tags || []).concat([tag]) });
      refreshItem(it);
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
  input.onchange = () => { saveData(it, { due: input.value || null }); refreshItem(it); closePalette(); };
  row.appendChild(input);
  dom.palette.appendChild(row);

  if (it.data.due) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'due-editor-clear';
    clear.appendChild(lucideEl('x'));
    clear.appendChild(document.createTextNode('Clear due date'));
    clear.onclick = () => { saveData(it, { due: null }); refreshItem(it); closePalette(); };
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
  dom.palette.className = 'open' + (showIcon || showShape ? ' board-palette' : '') + (mode === 'icon' ? ' icon-only' : '');

  if (showColor) {
    COLORS.forEach(c => {
      const sw = document.createElement('div'); sw.className = 'sw' + ((it.color || it._childColor) === c ? ' sel' : '');
      sw.style.background = colorVar(c);
      sw.onclick = () => { it.color = c; if (it.type === 'board') it._childColor = c; api.patch(it.id, { color: c }); refreshItem(it); closePalette(); };
      dom.palette.appendChild(sw);
    });
  }

  if (showIcon) {
    if (showColor) {
      const sep = document.createElement('div'); sep.className = 'pal-sep'; dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div'); grid.className = 'icon-grid';
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
      const sep = document.createElement('div'); sep.className = 'pal-sep'; dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div'); grid.className = 'icon-grid';
    const currentShape = it.data.shape || 'circle';
    SHAPES.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-pick' + (name === currentShape ? ' sel' : '');
      btn.title = name;
      btn.appendChild(lucideEl(SHAPE_ICONS[name] || 'circle'));
      btn.onclick = () => { saveData(it, { shape: name }); refreshItem(it); closePalette(); };
      grid.appendChild(btn);
    });
    dom.palette.appendChild(grid);

    const sep2 = document.createElement('div'); sep2.className = 'pal-sep'; dom.palette.appendChild(sep2);
    const fillRow = document.createElement('div'); fillRow.className = 'pal-fill-row';
    [['Hollow', false], ['Filled', true]].forEach(([label, val]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pal-fill-btn' + ((!!it.data.filled) === val ? ' sel' : '');
      btn.textContent = label;
      btn.onclick = () => { saveData(it, { filled: val }); refreshItem(it); closePalette(); };
      fillRow.appendChild(btn);
    });
    dom.palette.appendChild(fillRow);

    const sep3 = document.createElement('div'); sep3.className = 'pal-sep'; dom.palette.appendChild(sep3);
    const thickRow = document.createElement('div'); thickRow.className = 'pal-thick-row';
    const thickLabel = document.createElement('span'); thickLabel.className = 'pal-thick-label'; thickLabel.textContent = 'Thickness';
    const thickInput = document.createElement('input');
    thickInput.type = 'range'; thickInput.min = '1'; thickInput.max = '20'; thickInput.step = '1';
    thickInput.value = it.data.thickness ?? 4;
    thickInput.className = 'pal-thick-input';
    // A slider mid-drag has no single "done" moment, so — unlike the
    // shape/fill buttons above — this one doesn't closePalette() on change.
    thickInput.addEventListener('input', () => { saveData(it, { thickness: Number(thickInput.value) }); refreshItem(it); });
    thickRow.appendChild(thickLabel); thickRow.appendChild(thickInput);
    dom.palette.appendChild(thickRow);
  }

  const r = anchor.getBoundingClientRect();
  const w = (showIcon || showShape) ? 280 : 210;
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
  select(it.id);
  const locked = isLocked(it);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl+';
  const rows = [
    { label: 'Cut', hint: mod + 'X', fn: () => copySelected(true) },
    { label: 'Copy', hint: mod + 'C', fn: () => copySelected(false) },
    { label: 'Paste', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !state.clipboard },
    { label: 'Duplicate', hint: mod + 'D', fn: () => duplicateSelected() },
    { sep: true },
    { label: 'Rename', hint: 'Return', fn: () => renameSelected() },
    { label: locked ? 'Unlock Position' : 'Lock Position', fn: () => toggleLock() },
    { sep: true },
    { label: 'Move to Trash', hint: 'Delete', danger: true, fn: () => deleteItem(it.id) }
  ];
  dom.ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; dom.ctxmenu.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span'); lab.textContent = r.label; b.appendChild(lab);
    if (r.hint) { const k = document.createElement('kbd'); k.textContent = r.hint; b.appendChild(k); }
    b.onclick = () => r.fn();
    dom.ctxmenu.appendChild(b);
  });
  dom.ctxmenu.classList.add('open');
  const mw = 220, mh = dom.ctxmenu.offsetHeight || 280;
  let left = e.clientX, top = e.clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  dom.ctxmenu.style.left = left + 'px';
  dom.ctxmenu.style.top = top + 'px';
}

export function closeCtx() { dom.ctxmenu.classList.remove('open'); dom.ctxmenu.innerHTML = ''; }
