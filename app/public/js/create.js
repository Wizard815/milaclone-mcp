'use strict';

import { state, dom, elMap } from './state.js';
import { api } from './api.js';
import { rid } from './util.js';
import { render } from './cards.js';
import { select, enterEdit } from './editing.js';
import { openDocument } from './docs.js';
import { openDrawEditor } from './draw-editor.js';
import { openPalette } from './menus.js';

// Default shapes for each card type and the toolbar "place a new card" flow.

export function defaultsFor(type) {
  switch (type) {
    case 'note':    return { w: 240, data: { title: '', body: '' } };
    case 'todo':    return { w: 240, data: { title: 'To-do', tasks: [{ id: rid(), text: '', done: false }] } };
    case 'link':    return { w: 240, color: 'blue', data: { url: '', title: '' } };
    case 'column':  return { w: 252, data: { title: 'Column' } };
    case 'board':   return { w: 152, data: { title: 'Untitled board' } };
    case 'comment': return { w: 220, data: { body: '' } };
    case 'file':    return { w: 220, data: {} };
    case 'heading': return { w: 320, data: { text: '' } };
    case 'document':return { w: 152, data: { title: 'Untitled document', bodyHtml: '' } };
    case 'table':   return { w: 360, data: { rows: [['', ''], ['', '']] } };
    case 'color':   return { w: 160, data: { hex: '#2f6df0' } };
    case 'draw':    return { w: 320, color: 'slate', data: { title: 'Untitled drawing', strokes: [] } };
    case 'shape':   return { w: 200, color: 'slate', data: { shape: 'circle', filled: false, thickness: 4 } };
    default:        return { w: 240, data: {} };
  }
}

export async function createAt(type, wx, wy) {
  const d = defaultsFor(type);
  const body = Object.assign({ canvasId: state.view.canvas.id, type, x: Math.round(wx), y: Math.round(wy) }, d);
  const it = await api.create(body);
  state.view.items.push(it);
  render();
  select(it.id);
  if (type === 'document') {
    openDocument(it);
  } else if (type === 'draw') {
    openDrawEditor(it);
  } else if (type === 'shape') {
    // Shape/fill/color is one decision, made right after placing it (grey
    // hollow circle if you just click away) rather than a second click on
    // the handle to reach the same picker.
    const el = elMap.get(it.id);
    const handle = el.querySelector('.shape-handle');
    if (handle) openPalette(it, handle, 'shape');
  } else if (type !== 'board' && type !== 'image' && type !== 'file') {
    const el = elMap.get(it.id); enterEdit(el); el.querySelector('[data-edit]')?.focus();
  }
  dom.hint.style.display = 'none';
}
