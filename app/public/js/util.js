'use strict';

import { COLORS, dom } from './state.js';

export const colorVar = c => `var(--c-${COLORS.includes(c) ? c : 'slate'})`;

export function lucideEl(name) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  return i;
}

// `lucide` is a global provided by the CDN <script>. If it failed to load we
// silently skip icon rendering rather than throwing.
export function refreshIcons(root) {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons(root ? { nodes: [root] } : undefined);
  }
}

export function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
export function isLocked(it) { return !!(it.data && it.data.locked); }
export function rid() { return Math.random().toString(36).slice(2, 10); }
export function normalizeUrl(u) { if (!u) return '#'; return /^https?:\/\//.test(u) ? u : 'https://' + u; }

export function imageSize(src) {
  return new Promise(r => {
    const i = new Image();
    i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => r({ w: 1, h: 1 });
    i.src = src;
  });
}

let toastTimer;
export function toast(msg) {
  dom.toastEl.textContent = msg;
  dom.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toastEl.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// Due-date math + urgency formatting. Shared by Quick Notes (per-task due
// dates) and the canvas due-date badge (per-item due dates) so there's one
// implementation of "what does this ISO date mean relative to today."
// ---------------------------------------------------------------------------
const DAY = 86400000;
export const parseISO = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
export function daysUntil(iso) {
  const d = parseISO(iso);
  if (!d) return null;
  const now = new Date();
  return Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY);
}
export function relDays(n) {
  if (n === 0) return 'due today';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(n);
  if (abs < 7) return rtf.format(n, 'day');
  if (abs < 30) return rtf.format(Math.round(n / 7), 'week');
  return rtf.format(Math.round(n / 30), 'month');
}
// `overdue` is a plain flag rather than a baked-in CSS color, since callers
// live in different CSS scopes (Quick Notes' --qn-* variables vs. the
// canvas's own) and each maps it to its own palette.
export function dueInfo(iso) {
  const n = daysUntil(iso);
  if (n === null) return null;
  const short = parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const near = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : null;
  return {
    label: near || short,
    full: near || 'Due ' + short,
    sub: relDays(n),
    overdue: n <= 0
  };
}
