'use strict';

// Panels: named, free-form background regions that group other cards.
//
// A `panel` is an ordinary item (type 'panel') with a title, a position and a
// size of any width/height, drawn behind everything else. Membership is
// *positional*: a card belongs to a panel when its anchor point lies inside
// the panel's area, so "putting a card in a panel" is just placing it there --
// in the UI, via the API, or through the MCP. Because membership is derived
// from geometry on every read it can never go stale, and the API reports it
// (`_panelId`/`_panelTitle` on members, `_memberIds` on the panel).
//
// The anchor is the card's horizontal centre, 24px below its top edge. Card
// heights aren't stored (notes auto-grow in the browser), so this is the one
// point that means the same thing on the server and in the browser.
// public/js/panels.js mirrors these rules by hand, like previewTextFor.

const ANCHOR_DROP = 24;
const SHAPES = ['rect', 'rounded', 'ellipse'];
const DEFAULT_PANEL = { w: 480, h: 320 };
const HEADER_H = 44;

const isPanel = it => it.type === 'panel';
const area = p => (p.w || DEFAULT_PANEL.w) * (p.h || DEFAULT_PANEL.h);

function anchorOf(it) {
  return { x: it.x + (it.w || 240) / 2, y: it.y + ANCHOR_DROP };
}

function containsPoint(panel, pt) {
  const w = panel.w || DEFAULT_PANEL.w,
    h = panel.h || DEFAULT_PANEL.h;
  if (panel.data && panel.data.shape === 'ellipse') {
    const rx = w / 2,
      ry = h / 2;
    const dx = (pt.x - (panel.x + rx)) / rx,
      dy = (pt.y - (panel.y + ry)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return pt.x >= panel.x && pt.x <= panel.x + w && pt.y >= panel.y && pt.y <= panel.y + h;
}

// Can `it` be a member of `panel`? Lines are derived from their endpoints, and
// a panel only holds strictly smaller panels (so two panels never contain each
// other).
function isMemberOf(panel, it) {
  if (it.id === panel.id || it.type === 'line' || it.parentItemId) return false;
  if (isPanel(it) && area(it) >= area(panel)) return false;
  return containsPoint(panel, anchorOf(it));
}

// items: every item on one canvas. Returns Map(itemId -> directPanel) where
// directPanel is the smallest panel containing the item, plus the panels list.
function computeMembership(items) {
  const panels = items.filter(isPanel).sort((a, b) => area(a) - area(b));
  const direct = new Map();
  for (const it of items) {
    const p = panels.find(pn => isMemberOf(pn, it));
    if (p) direct.set(it.id, p);
  }
  return { panels, direct };
}

// Every item inside `panel` at any nesting depth (what moves with it).
function allMembers(panel, items) {
  return items.filter(it => isMemberOf(panel, it));
}

// Adds `_panelId`/`_panelTitle` to members and `_memberIds`/`_memberCount` to
// panels. Mutates and returns the same array.
function annotate(items) {
  const { panels, direct } = computeMembership(items);
  const byPanel = new Map(panels.map(p => [p.id, []]));
  for (const it of items) {
    const p = direct.get(it.id);
    if (!p) continue;
    it._panelId = p.id;
    it._panelTitle = p.data.title || 'Panel';
    byPanel.get(p.id).push(it.id);
  }
  for (const p of panels) {
    p._memberIds = byPanel.get(p.id);
    p._memberCount = p._memberIds.length;
  }
  return items;
}

// Smallest rectangle (with padding and room for the header) that encloses
// every item's anchor *and* its visible card -- heights are unknown, so the
// caller passes a per-item estimate.
// Rough rendered height of a card whose `h` isn't stored (cards auto-grow in
// the browser), so a group panel's box reaches past the bottom of tall cards.
function estimateH(it) {
  const d = it.data || {};
  switch (it.type) {
    case 'todo':
      return 70 + 36 * Math.max(1, (d.tasks || []).length);
    case 'table':
      return 50 + 32 * Math.max(1, (d.rows || []).length);
    case 'column':
      return 80;
    case 'note':
      return 60 + 22 * Math.ceil(String(d.text || d.body || '').length / 28);
    case 'board':
    case 'document':
      return 140;
    case 'link':
      return 110;
    case 'heading':
      return 60;
    case 'color':
      return 150;
    default:
      return 140;
  }
}

function boundsFor(items, { padding = 40, estimateH: est = estimateH } = {}) {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const it of items) {
    const w = it.w || 240,
      h = it.h || est(it);
    x1 = Math.min(x1, it.x);
    y1 = Math.min(y1, it.y);
    x2 = Math.max(x2, it.x + w);
    y2 = Math.max(y2, it.y + h);
  }
  return {
    x: Math.round(x1 - padding),
    y: Math.round(y1 - padding - HEADER_H),
    w: Math.round(x2 - x1 + padding * 2),
    h: Math.round(y2 - y1 + padding * 2 + HEADER_H),
  };
}

module.exports = {
  SHAPES,
  DEFAULT_PANEL,
  HEADER_H,
  ANCHOR_DROP,
  isPanel,
  anchorOf,
  containsPoint,
  isMemberOf,
  computeMembership,
  allMembers,
  annotate,
  boundsFor,
  estimateH,
};
