'use strict';

import { state, dom, elMap, SHAPE_ICONS } from './state.js';
import { colorVar, lucideEl, refreshIcons, autoGrow, isLocked, rid, normalizeUrl, dueInfo } from './util.js';
import { select, enterEdit, exitEdit, saveData, deleteItem } from './editing.js';
import { openPalette, openCtx, openTagPicker, openDueEditor } from './menus.js';
import { updateSelectionChrome } from './boardchrome.js';
import { onItemPointerDown, startResize } from './drag.js';
import { openCanvas } from './main.js';
import { openDocument } from './docs.js';
import { openDrawEditor } from './draw-editor.js';
import { renderLines } from './lines.js';
import { navigateToConnect } from './connect.js';

// Rendering of the canvas and every card type. This module owns the DOM for
// items; other modules ask it to (re)render when data changes.

export function childrenOf(id) {
  return state.view.items.filter(it => it.parentItemId === id).sort((a, b) => (a.y || 0) - (b.y || 0));
}

export function render() {
  dom.world.innerHTML = '';
  elMap.clear();
  const free = state.view.items.filter(it => !it.parentItemId && it.type !== 'line');
  for (const it of free) {
    const el = renderItem(it);
    dom.world.appendChild(el);
    elMap.set(it.id, el);
  }
  renderLines();
  dom.hint.style.display = state.view.items.length ? 'none' : 'block';
  refreshIcons(dom.world);
}

export function renderCrumbs() {
  dom.crumbs.innerHTML = '';
  state.view.breadcrumb.forEach((c, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; dom.crumbs.appendChild(s); }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === state.view.breadcrumb.length - 1 ? ' current' : '');
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.style.background = colorVar((state.view.canvas && c.id === state.view.canvas.id) ? state.view.canvas.color : 'slate');
    b.appendChild(chip);
    const t = document.createElement('span'); t.textContent = c.title; b.appendChild(t);
    if (i !== state.view.breadcrumb.length - 1) b.onclick = () => openCanvas(c.id);
    dom.crumbs.appendChild(b);
  });
}

export function makeField(tag, cls, value, placeholder) {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  if (tag === 'area') f.rows = 1;
  f.className = cls; f.value = value || ''; f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true; f.tabIndex = -1;
  // autoGrow changes the card's own height as you type, which any connector
  // line attached to it needs to know about immediately — otherwise the
  // line stays anchored to the old, shorter box until something unrelated
  // forces a re-render, visually hanging above where the card's edge
  // actually is now.
  if (tag === 'area') { f.addEventListener('input', () => { autoGrow(f); renderLines(); }); }
  return f;
}

export function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (state.selectedIds.has(it.id)) el.classList.add('selected');
  if (isLocked(it)) el.classList.add('locked');
  if (it.type !== 'board' && it.data.starred) el.classList.add('starred');
  if (!it.parentItemId) {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    el.style.width = (it.w || 240) + 'px';
    // Shapes stay square (via CSS aspect-ratio) until stretched — once
    // stretched, it.h is real and wins over that (explicit width+height
    // always beats aspect-ratio).
    if (it.type === 'shape' && it.h) el.style.height = it.h + 'px';
    el.style.zIndex = it.z || 1;
  } else {
    el.classList.add('in-column');
  }

  if (it.type === 'note') buildNote(el, it);
  else if (it.type === 'todo') buildTodo(el, it);
  else if (it.type === 'link') buildLink(el, it);
  else if (it.type === 'image') buildImage(el, it);
  else if (it.type === 'file') buildFile(el, it);
  else if (it.type === 'comment') buildComment(el, it);
  else if (it.type === 'board') buildBoard(el, it);
  else if (it.type === 'column') buildColumn(el, it);
  else if (it.type === 'heading') buildHeading(el, it);
  else if (it.type === 'document') buildDocument(el, it);
  else if (it.type === 'table') buildTable(el, it);
  else if (it.type === 'color') buildColor(el, it);
  else if (it.type === 'draw') buildDraw(el, it);
  else if (it.type === 'shape') buildShape(el, it);
  else if (it.type === 'connect') buildConnect(el, it);

  // Boards use the rail / mobile footer for color·icon·rename·delete.
  // Other cards keep the floating properties badge.
  if (it.type !== 'board') {
    const tools = document.createElement('div');
    tools.className = 'card-tools';
    // Shapes pick color from their own on-card handle (bundled with shape
    // type + fill), so the swatch here would just be a second, redundant
    // way to do the same thing.
    if (it.type !== 'shape') {
      const colorBtn = document.createElement('div');
      colorBtn.className = 'swatch';
      colorBtn.style.background = colorVar(it.color || 'slate');
      colorBtn.title = 'Color';
      colorBtn.setAttribute('data-nodrag', '');
      colorBtn.onclick = (e) => { e.stopPropagation(); openPalette(it, colorBtn, 'color'); };
      tools.appendChild(colorBtn);
    }
    const tagBtn = document.createElement('button');
    tagBtn.setAttribute('data-nodrag', '');
    tagBtn.className = 'card-tool-btn';
    tagBtn.appendChild(lucideEl('tag'));
    tagBtn.title = 'Tags';
    tagBtn.onclick = (e) => { e.stopPropagation(); openTagPicker([it], tagBtn); };
    tools.appendChild(tagBtn);

    const starBtn = document.createElement('button');
    starBtn.setAttribute('data-nodrag', '');
    starBtn.className = 'card-tool-btn' + (it.data.starred ? ' on' : '');
    starBtn.appendChild(lucideEl('star'));
    starBtn.title = it.data.starred ? 'Unstar' : 'Star';
    starBtn.onclick = (e) => { e.stopPropagation(); saveData(it, { starred: !it.data.starred }); refreshItem(it); };
    tools.appendChild(starBtn);

    const dueBtn = document.createElement('button');
    dueBtn.setAttribute('data-nodrag', '');
    dueBtn.className = 'card-tool-btn' + (it.data.due ? ' on' : '');
    dueBtn.appendChild(lucideEl('calendar'));
    dueBtn.title = 'Due date';
    dueBtn.onclick = (e) => { e.stopPropagation(); openDueEditor(it, dueBtn); };
    tools.appendChild(dueBtn);

    if (it.type === 'heading') {
      const boldBtn = document.createElement('button');
      boldBtn.setAttribute('data-nodrag', '');
      boldBtn.className = 'htool-b' + (it.data.bold ? ' on' : '');
      boldBtn.textContent = 'B';
      boldBtn.title = 'Bold';
      boldBtn.onclick = (e) => { e.stopPropagation(); saveData(it, { bold: !it.data.bold }); refreshItem(it); };
      tools.appendChild(boldBtn);
      const underlineBtn = document.createElement('button');
      underlineBtn.setAttribute('data-nodrag', '');
      underlineBtn.className = 'htool-u' + (it.data.underline ? ' on' : '');
      underlineBtn.textContent = 'U';
      underlineBtn.title = 'Underline';
      underlineBtn.onclick = (e) => { e.stopPropagation(); saveData(it, { underline: !it.data.underline }); refreshItem(it); };
      tools.appendChild(underlineBtn);
      const fillBtn = document.createElement('button');
      fillBtn.setAttribute('data-nodrag', '');
      fillBtn.className = 'htool-fill' + (it.data.filled ? ' on' : '');
      fillBtn.appendChild(lucideEl('square'));
      fillBtn.title = 'Fill background';
      fillBtn.onclick = (e) => { e.stopPropagation(); saveData(it, { filled: !it.data.filled }); refreshItem(it); };
      tools.appendChild(fillBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.setAttribute('data-nodrag', '');
    delBtn.appendChild(lucideEl('trash-2'));
    delBtn.title = 'Delete';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(it.id); };
    tools.appendChild(delBtn);
    if (isLocked(it)) {
      const lockBadge = document.createElement('span');
      lockBadge.className = 'lock-badge';
      lockBadge.appendChild(lucideEl('lock'));
      lockBadge.title = 'Position locked';
      tools.appendChild(lockBadge);
    }
    el.appendChild(tools);

    // Always-visible badges (unlike .card-tools, not gated behind .selected)
    // so tags/star/due mean something at a glance, not just when editing.
    const due = it.data.due ? dueInfo(it.data.due) : null;
    if (due) {
      const dueBadge = document.createElement('span');
      dueBadge.className = 'due-badge' + (due.overdue ? ' overdue' : '');
      dueBadge.textContent = due.label;
      dueBadge.title = due.full;
      el.appendChild(dueBadge);
    }
    if (it.data.tags && it.data.tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'item-tags';
      tagRow.setAttribute('data-nodrag', '');
      for (const tag of it.data.tags) {
        const chip = document.createElement('span');
        chip.className = 'item-tag';
        chip.textContent = tag;
        tagRow.appendChild(chip);
      }
      tagRow.onclick = (e) => { e.stopPropagation(); openTagPicker([it], tagRow); };
      el.appendChild(tagRow);
    }
  } else if (isLocked(it)) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'lock-badge board-lock';
    lockBadge.appendChild(lucideEl('lock'));
    lockBadge.title = 'Position locked';
    el.appendChild(lockBadge);
  }

  if (it.type !== 'board' && it.type !== 'document' && it.type !== 'shape' && !it.parentItemId && !isLocked(it)) {
    const rz = document.createElement('div'); rz.className = 'resize'; rz.setAttribute('data-nodrag', '');
    rz.addEventListener('pointerdown', (e) => startResize(e, it, el));
    el.appendChild(rz);
  }

  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, it, el));
  el.addEventListener('contextmenu', (e) => {
    // Right-clicking actively-editable text (typing in a note/comment/etc.)
    // should show the browser's own menu — spellcheck suggestions on a
    // misspelled word, in particular — not our card-level actions. Those
    // stay available everywhere else on the card (background, read-only
    // fields before you've entered edit mode).
    const field = e.target.closest('[data-edit]');
    if (field && !field.readOnly) return;
    openCtx(e, it);
  });
  return el;
}

function buildNote(el, it) {
  el.classList.add('note');
  if (it.color) { const a = document.createElement('div'); a.className = 'accent'; a.style.background = colorVar(it.color); el.appendChild(a); }
  const t = makeField('area', 'ntitle', it.data.title, 'Title');
  const b = makeField('area', 'nbody', it.data.body, 'Write a note…');
  t.addEventListener('input', () => saveData(it, { title: t.value }));
  b.addEventListener('input', () => saveData(it, { body: b.value }));
  el.appendChild(t); el.appendChild(b);
  requestAnimationFrame(() => { autoGrow(t); autoGrow(b); renderLines(); });
}

function buildComment(el, it) {
  el.classList.add('comment');
  if (it.color) { el.classList.add('colored'); el.style.background = colorVar(it.color); } else { el.style.background = ''; }
  const mark = document.createElement('div');
  mark.className = 'cmark';
  mark.appendChild(lucideEl('message-circle'));
  el.appendChild(mark);
  const b = makeField('area', 'cbody', it.data.body, 'Add a comment…');
  b.addEventListener('input', () => saveData(it, { body: b.value }));
  el.appendChild(b);
  // Growing to fit existing body text happens one frame after this card is
  // first in the DOM (its initial height is the default single-row size
  // until then) — any connector line attached to it was already drawn
  // against that shorter box by the time this runs, so it needs to redraw.
  requestAnimationFrame(() => { autoGrow(b); renderLines(); });
}

function buildTodo(el, it) {
  el.classList.add('todo');
  const title = makeField('input', 'ttitle', it.data.title, 'To-do');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  el.appendChild(title);
  const list = document.createElement('div'); list.className = 'tasks';
  el.appendChild(list);
  const tasks = it.data.tasks || [];
  const renderTasks = () => {
    list.innerHTML = '';
    tasks.forEach((task) => {
      const row = document.createElement('div'); row.className = 'task' + (task.done ? ' done' : '') + (task.starred ? ' starred' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!task.done; cb.setAttribute('data-nodrag', '');
      cb.onclick = (e) => { e.stopPropagation(); task.done = cb.checked; row.classList.toggle('done', task.done); saveData(it, { tasks }); };
      const tx = makeField('area', 'txt', task.text, 'List item');
      tx.addEventListener('input', () => { task.text = tx.value; saveData(it, { tasks }); });
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const ni = { id: rid(), text: '', done: false }; tasks.splice(tasks.indexOf(task) + 1, 0, ni); saveData(it, { tasks }); renderTasks(); enterEdit(el); list.querySelectorAll('.txt')[tasks.indexOf(ni)].focus(); }
        if (e.key === 'Backspace' && tx.value === '' && tasks.length > 1) { e.preventDefault(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); }
      });
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.setAttribute('data-nodrag', '');
      del.onclick = (e) => { e.stopPropagation(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); };
      row.appendChild(cb); row.appendChild(tx); row.appendChild(del);
      list.appendChild(row);
      requestAnimationFrame(() => { autoGrow(tx); renderLines(); });
    });
  };
  renderTasks();
  const add = document.createElement('button'); add.className = 'add'; add.setAttribute('data-nodrag', '');
  add.textContent = '+ Add item';
  add.onclick = (e) => { e.stopPropagation(); tasks.push({ id: rid(), text: '', done: false }); saveData(it, { tasks }); renderTasks(); enterEdit(el); const f = list.querySelectorAll('.txt'); f[f.length - 1].focus(); };
  el.appendChild(add);
}

function buildLink(el, it) {
  el.classList.add('link');
  const bar = document.createElement('div'); bar.className = 'lbar'; bar.style.background = colorVar(it.color || 'blue'); el.appendChild(bar);
  const body = document.createElement('div'); body.className = 'lbody';
  const title = makeField('input', 'ltitle', it.data.title, 'Link title');
  const url = makeField('input', 'lurl', it.data.url, 'https://…');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  url.addEventListener('input', () => { saveData(it, { url: url.value }); open.href = normalizeUrl(url.value); });
  const open = document.createElement('a'); open.className = 'open'; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open ↗';
  open.href = normalizeUrl(it.data.url || '#'); open.setAttribute('data-nodrag', '');
  body.appendChild(title); body.appendChild(url); body.appendChild(open); el.appendChild(body);
}

function buildImage(el, it) {
  el.classList.add('image');
  const img = document.createElement('img'); img.src = it.data.src; img.alt = it.data.name || '';
  if (it.data.naturalW && it.data.naturalH) el.style.aspectRatio = it.data.naturalW + ' / ' + it.data.naturalH;
  el.appendChild(img);
}

function buildFile(el, it) {
  el.classList.add('file');
  const icon = document.createElement('div'); icon.className = 'ficon';
  icon.appendChild(lucideEl('file-text'));
  const name = document.createElement('div'); name.className = 'fname';
  name.textContent = it.data.name || 'File';
  name.title = it.data.name || '';
  const open = document.createElement('a'); open.className = 'fopen'; open.setAttribute('data-nodrag', '');
  open.href = it.data.src || '#'; open.target = '_blank'; open.rel = 'noopener'; open.download = it.data.name || '';
  open.textContent = 'Open ↗';
  el.appendChild(icon); el.appendChild(name); el.appendChild(open);
}

function buildHeading(el, it) {
  el.classList.add('heading');
  if (it.data.filled) el.classList.add('filled');
  const t = makeField('area', 'htext', it.data.text, 'Heading');
  if (it.color) t.style.color = colorVar(it.color);
  if (it.data.bold) t.style.fontWeight = '700';
  if (it.data.underline) t.style.textDecoration = 'underline';
  t.addEventListener('input', () => saveData(it, { text: t.value }));
  el.appendChild(t);
  requestAnimationFrame(() => { autoGrow(t); renderLines(); });
}

function buildDocument(el, it) {
  el.classList.add('document');
  const tile = document.createElement('div'); tile.className = 'tile';
  tile.style.background = colorVar(it.color || 'slate');
  tile.appendChild(lucideEl('file-text'));
  el.appendChild(tile);
  const title = makeField('input', 'dtitle', it.data.title, 'Untitled document');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.dataset.suppressTitleClick) { delete el.dataset.suppressTitleClick; return; }
    if (state.selectedId !== it.id) { select(it.id); return; }
    enterEdit(el); title.focus(); title.select();
  });
  el.appendChild(title);
  bindDocumentOpen(el, it);
}

// Mirrors bindBoardOpen: desktop gets dblclick, touch gets a double-tap
// detector since mobile Safari doesn't synthesize dblclick from taps.
function bindDocumentOpen(el, it) {
  let lastTap = -Infinity, lastX = 0, lastY = 0;
  const open = () => { exitEdit(); openDocument(it); };
  el.addEventListener('dblclick', (e) => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    open();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    if (state.drag && state.drag.moved) return;
    if (state.drag && state.drag.it && state.drag.it.id !== it.id) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 28) {
      lastTap = -Infinity;
      el.dataset.suppressTitleClick = '1';
      open();
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  });
}

function buildTable(el, it) {
  el.classList.add('table');
  const rows = (it.data.rows && it.data.rows.length) ? it.data.rows : [['', '']];
  const grid = document.createElement('div'); grid.className = 'tgrid';
  const actions = document.createElement('div'); actions.className = 'tactions';

  const renderGrid = () => {
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${rows[0].length}, 1fr)`;
    rows.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        const c = makeField('input', 'tcell', cell, '');
        c.addEventListener('input', () => { rows[ri][ci] = c.value; saveData(it, { rows }); });
        grid.appendChild(c);
      });
    });
  };
  renderGrid();

  const addRow = document.createElement('button'); addRow.className = 'tact'; addRow.setAttribute('data-nodrag', '');
  addRow.textContent = '+ Row';
  addRow.onclick = (e) => { e.stopPropagation(); rows.push(new Array(rows[0].length).fill('')); saveData(it, { rows }); renderGrid(); };
  const addCol = document.createElement('button'); addCol.className = 'tact'; addCol.setAttribute('data-nodrag', '');
  addCol.textContent = '+ Col';
  addCol.onclick = (e) => { e.stopPropagation(); rows.forEach(r => r.push('')); saveData(it, { rows }); renderGrid(); };
  actions.appendChild(addRow); actions.appendChild(addCol);

  el.appendChild(grid); el.appendChild(actions);
}

function buildColor(el, it) {
  el.classList.add('color');
  const swatch = document.createElement('div'); swatch.className = 'cswatch';
  swatch.style.background = it.data.hex || '#2f6df0';
  const picker = document.createElement('input'); picker.type = 'color'; picker.className = 'cpicker'; picker.setAttribute('data-nodrag', '');
  picker.value = /^#[0-9a-f]{6}$/i.test(it.data.hex || '') ? it.data.hex : '#2f6df0';
  const hex = makeField('input', 'chex', it.data.hex, '#000000');
  const commit = (val) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(val)) return;
    swatch.style.background = val; picker.value = val; saveData(it, { hex: val });
  };
  picker.addEventListener('input', () => { hex.value = picker.value; commit(picker.value); });
  hex.addEventListener('input', () => commit(hex.value));
  swatch.appendChild(picker);
  el.appendChild(swatch); el.appendChild(hex);
}

// Drawing itself happens in the full-page draw editor (draw-editor.js), not
// on the canvas — this card just renders a static, non-interactive preview
// of the actual strokes (pointer-events:none, so clicks/drags still hit the
// card underneath like any other card); double-click opens the editor.
const SVG_NS = 'http://www.w3.org/2000/svg';

function pointsToPath(points) {
  return points.length ? 'M' + points.map(p => p[0] + ',' + p[1]).join(' L') : '';
}

function drawPreview(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const [x, y] of s.points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const pad = 20;
  const w = Math.max(maxX - minX, 1) + pad * 2;
  const h = Math.max(maxY - minY, 1) + pad * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.classList.add('draw-canvas');
  for (const s of strokes) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', pointsToPath(s.points));
    p.setAttribute('stroke', s.color || '#565d6b');
    p.setAttribute('stroke-width', s.width || 3);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  }
  return svg;
}

// Geometry for each SHAPES entry (state.js), in a 0-100 square viewBox.
function shapeGeometry(name) {
  const el = document.createElementNS(SVG_NS, name === 'circle' ? 'circle' : 'polygon');
  if (name === 'circle') {
    el.setAttribute('cx', 50); el.setAttribute('cy', 50); el.setAttribute('r', 46);
  } else if (name === 'square') {
    el.setAttribute('points', '6,6 94,6 94,94 6,94');
  } else if (name === 'triangle') {
    el.setAttribute('points', '50,6 94,90 6,90');
  } else if (name === 'diamond') {
    el.setAttribute('points', '50,4 96,50 50,96 4,50');
  } else if (name === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 48 : 20;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push(`${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`);
    }
    el.setAttribute('points', pts.join(' '));
  }
  return el;
}

// A background decoration card — a single basic shape (line art or filled),
// always rendered behind every other card (see the forced z-index below)
// so it can sit under real content like colored paper. Its own color/shape/
// fill are all picked from one handle rather than the usual swatch, since
// "which color" and "which shape" are really one decision here.
function buildShape(el, it) {
  el.classList.add('shape');
  el.style.zIndex = '0'; // real cards start at z >= 1 (see maxZ in db.js) — this always loses
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  // "none" (not the default "meet") so a non-square card stretches the whole
  // coordinate system per-axis instead of letterboxing a square shape inside
  // it — a circle becomes an ellipse, a square a rectangle, etc., matching
  // the card's own w/h from a shift-stretch instead of staying square.
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('shape-svg');
  const shapeEl = shapeGeometry(it.data.shape || 'circle');
  const color = colorVar(it.color || 'slate');
  shapeEl.setAttribute('fill', it.data.filled ? color : 'none');
  shapeEl.setAttribute('stroke', color);
  shapeEl.setAttribute('stroke-width', it.data.thickness ?? 4);
  svg.appendChild(shapeEl);
  el.appendChild(svg);

  const handle = document.createElement('div');
  handle.className = 'shape-handle';
  handle.title = 'Shape, fill & color';
  handle.setAttribute('data-nodrag', '');
  handle.appendChild(lucideEl(SHAPE_ICONS[it.data.shape] || 'circle'));
  handle.addEventListener('click', (e) => { e.stopPropagation(); openPalette(it, handle, 'shape'); });
  el.appendChild(handle);
}

function buildDraw(el, it) {
  el.classList.add('draw');
  const strokes = it.data.strokes || [];
  if (strokes.length) {
    el.appendChild(drawPreview(strokes));
  } else {
    const empty = document.createElement('div'); empty.className = 'draw-empty';
    empty.appendChild(lucideEl('pencil'));
    const label = document.createElement('span');
    label.textContent = it.data.title ? it.data.title : 'Empty — double-click to draw';
    empty.appendChild(label);
    el.appendChild(empty);
  }
  bindDrawOpen(el, it);
}

// Mirrors bindBoardOpen/bindDocumentOpen: desktop dblclick, touch double-tap.
function bindDrawOpen(el, it) {
  let lastTap = -Infinity, lastX = 0, lastY = 0;
  const open = () => { exitEdit(); openDrawEditor(it); };
  el.addEventListener('dblclick', (e) => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    open();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    if (state.drag && state.drag.moved) return;
    if (state.drag && state.drag.it && state.drag.it.id !== it.id) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 28) {
      lastTap = -Infinity;
      el.dataset.suppressTitleClick = '1';
      open();
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  });
}

// A jump-link to a card elsewhere in the workspace (possibly boards deep).
// "Go there" is an explicit link (like the Link card's "Open ↗"); the card
// itself still just selects/drags like anything else on a plain click.
function buildConnect(el, it) {
  el.classList.add('connect');
  const bar = document.createElement('div'); bar.className = 'cn-bar'; el.appendChild(bar);
  const body = document.createElement('div'); body.className = 'cn-body';
  const head = document.createElement('div'); head.className = 'cn-head';
  head.appendChild(lucideEl('radar'));
  const label = document.createElement('span'); label.className = 'cn-label';
  // _liveLabel is resolved fresh by the server on every canvas read (the
  // source/target's *current* name), same pattern boards already use for
  // their own tile title -- data.targetLabel is just the fallback for a
  // stale local record or a dangling target that's since been deleted.
  label.textContent = it._liveLabel || it.data.targetLabel || 'Untitled link';
  head.appendChild(label);
  body.appendChild(head);
  const note = makeField('area', 'cn-note', it.data.note, 'Add a note…');
  note.addEventListener('input', () => saveData(it, { note: note.value }));
  body.appendChild(note);
  const go = document.createElement('a'); go.className = 'cn-go'; go.textContent = 'Go there ↗';
  go.setAttribute('data-nodrag', '');
  go.addEventListener('click', (e) => { e.stopPropagation(); navigateToConnect(it); });
  body.appendChild(go);
  el.appendChild(body);
  requestAnimationFrame(() => autoGrow(note));
}

function buildBoard(el, it) {
  el.classList.add('board');
  const tile = document.createElement('div'); tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  tile.appendChild(lucideEl(it._childIcon || 'layout-grid'));
  tile.title = 'Color & icon';
  tile.setAttribute('data-nodrag', '');
  tile.addEventListener('click', (e) => {
    e.stopPropagation();
    openPalette(it, tile, 'auto');
  });
  el.appendChild(tile);
  const title = makeField('input', 'btitle', it._childTitle || 'Untitled board', 'Board name');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    // A touch double-tap opens the board on pointerup; don't fall through into rename.
    if (el.dataset.suppressTitleClick) { delete el.dataset.suppressTitleClick; return; }
    if (state.selectedId !== it.id) { select(it.id); return; }
    enterEdit(el); title.focus(); title.select();
  });
  el.appendChild(title);
  const meta = document.createElement('div'); meta.className = 'bmeta';
  const n = it._childCount || 0; meta.textContent = n + (n === 1 ? ' card' : ' cards');
  el.appendChild(meta);
  bindBoardOpen(el, it);
}

// Desktop mouse gets a real dblclick; mobile Safari/WebKit does not synthesize
// one from a double-tap, so we also detect a second quick, unmoved pointerup.
function bindBoardOpen(el, it) {
  let lastTap = -Infinity, lastX = 0, lastY = 0;
  const open = () => {
    exitEdit();
    openCanvas(it.data.childCanvasId);
  };
  el.addEventListener('dblclick', (e) => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    open();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;          // mouse keeps using dblclick
    if (state.drag && state.drag.moved) return;      // was a drag, not a tap
    if (state.drag && state.drag.it && state.drag.it.id !== it.id) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 28) {
      lastTap = -Infinity;
      el.dataset.suppressTitleClick = '1';
      open();
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  });
}

function buildColumn(el, it) {
  el.classList.add('column');
  const head = document.createElement('div'); head.className = 'col-head';
  const chip = document.createElement('div'); chip.className = 'col-chip'; chip.style.background = colorVar(it.color || 'slate');
  const title = makeField('input', 'col-title', it.data.title, 'Column');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  head.appendChild(chip); head.appendChild(title); el.appendChild(head);
  const body = document.createElement('div'); body.className = 'col-body'; body.dataset.colbody = it.id; el.appendChild(body);
  const kids = childrenOf(it.id);
  if (!kids.length) { const e = document.createElement('div'); e.className = 'col-empty'; e.textContent = 'Drag cards here'; body.appendChild(e); }
  for (const k of kids) { const ke = renderItem(k); body.appendChild(ke); elMap.set(k.id, ke); }
}

export function refreshItem(it) {
  const old = elMap.get(it.id);
  if (!old) return;
  const fresh = renderItem(it);
  old.replaceWith(fresh);
  elMap.set(it.id, fresh);
  refreshIcons(fresh);
  if (it.type === 'column') {
    for (const k of childrenOf(it.id)) {
      const ke = fresh.querySelector(`[data-id="${k.id}"]`);
      if (ke) elMap.set(k.id, ke);
    }
  }
  if (it.type === 'board' && it.id === state.selectedId) updateSelectionChrome();
}
