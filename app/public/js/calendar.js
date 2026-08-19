'use strict';

import { state, dom } from './state.js';
import { api } from './api.js';
import { dueInfo } from './util.js';
import { applyCam } from './viewport.js';
import { select } from './editing.js';
import { openCanvas } from './main.js';

// Cross-board calendar: every due date in the workspace (item-level
// data.due on any card + Quick Notes' per-task due dates -- GET
// /api/calendar already merges both into one flat list) shown as day/
// week/month/year views, plus a constant "Upcoming" panel below
// regardless of which view is active. Due dates are date-only (no time
// of day anywhere in the app's data model), so "Day view" is just a flat
// list for that date, not an hourly grid.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let root = null;
let entries = [];        // flat list from the server
let byDate = new Map();  // 'YYYY-MM-DD' -> entry[]
let view = 'month';      // 'day' | 'week' | 'month' | 'year'
let refDate = new Date(); // the date the current view is centered on

function refs() {
  if (root) return root;
  root = {
    el: document.getElementById('calendarView'),
    close: document.getElementById('calClose'),
    viewToggle: document.getElementById('calViewToggle'),
    prev: document.getElementById('calPrev'),
    next: document.getElementById('calNext'),
    today: document.getElementById('calToday'),
    periodLabel: document.getElementById('calPeriodLabel'),
    body: document.getElementById('calBody'),
    upcoming: document.getElementById('calUpcomingList')
  };
  return root;
}

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a, b) => toISO(a) === toISO(b);
function startOfWeek(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; }

export function isCalendarOpen() { return !!root && !root.el.hidden; }

export async function openCalendar() {
  const r = refs();
  r.el.hidden = false;
  refDate = new Date();
  view = 'month';
  setViewButtons();
  await load();
  render();
}

function closeCalendar() {
  refs().el.hidden = true;
}

async function load() {
  const data = await api.calendar().catch(() => ({ entries: [] }));
  entries = data.entries || [];
  byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
}

function setViewButtons() {
  refs().viewToggle.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
}

function render() {
  renderPeriodLabel();
  if (view === 'day') renderDay();
  else if (view === 'week') renderWeek();
  else if (view === 'month') renderMonth();
  else renderYear();
  renderUpcoming();
}

function renderPeriodLabel() {
  const r = refs();
  if (view === 'day') {
    r.periodLabel.textContent = refDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } else if (view === 'week') {
    const s = startOfWeek(refDate);
    const e = new Date(s); e.setDate(e.getDate() + 6);
    r.periodLabel.textContent = `${s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } else if (view === 'month') {
    r.periodLabel.textContent = `${MONTH_NAMES[refDate.getMonth()]} ${refDate.getFullYear()}`;
  } else {
    r.periodLabel.textContent = String(refDate.getFullYear());
  }
}

function jumpToDay(d) {
  refDate = d;
  view = 'day';
  setViewButtons();
  render();
}

// Month-view cell: a dot (+ count once >1) rather than the entries
// themselves -- there isn't room for real text at 1/42 of the grid.
function monthCell(d) {
  const iso = toISO(d);
  const dayEntries = byDate.get(iso) || [];
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cal-day' + (dayEntries.length ? ' has-entries' : '') + (sameDay(d, new Date()) ? ' today' : '');
  if (d.getMonth() !== refDate.getMonth()) cell.classList.add('dim');
  const num = document.createElement('span'); num.className = 'cal-day-num'; num.textContent = d.getDate();
  cell.appendChild(num);
  if (dayEntries.length) {
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    if (dayEntries.length > 1) dot.textContent = String(dayEntries.length);
    cell.appendChild(dot);
  }
  cell.onclick = () => jumpToDay(d);
  return cell;
}

function renderMonth() {
  const r = refs();
  r.body.innerHTML = '';
  r.body.className = 'cal-body cal-body-month';
  const grid = document.createElement('div'); grid.className = 'cal-grid';
  for (const name of DAY_NAMES) { const h = document.createElement('div'); h.className = 'cal-grid-head'; h.textContent = name; grid.appendChild(h); }
  const first = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const start = startOfWeek(first);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    grid.appendChild(monthCell(d));
  }
  r.body.appendChild(grid);
}

function renderWeek() {
  const r = refs();
  r.body.innerHTML = '';
  r.body.className = 'cal-body cal-body-week';
  const grid = document.createElement('div'); grid.className = 'cal-week-grid';
  const start = startOfWeek(refDate);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const col = document.createElement('div'); col.className = 'cal-week-col';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'cal-week-head' + (sameDay(d, new Date()) ? ' today' : '');
    head.textContent = `${DAY_NAMES[i]} ${d.getDate()}`;
    head.onclick = () => jumpToDay(d);
    col.appendChild(head);
    for (const en of (byDate.get(toISO(d)) || [])) col.appendChild(entryRow(en, 'cal-day-entry'));
    grid.appendChild(col);
  }
  r.body.appendChild(grid);
}

function renderDay() {
  const r = refs();
  r.body.innerHTML = '';
  r.body.className = 'cal-body cal-body-day';
  const dayEntries = byDate.get(toISO(refDate)) || [];
  if (!dayEntries.length) {
    r.body.appendChild(emptyRow('Nothing due this day.'));
    return;
  }
  for (const en of dayEntries) r.body.appendChild(entryRow(en, 'cal-day-list-row', true));
}

function renderYear() {
  const r = refs();
  r.body.innerHTML = '';
  r.body.className = 'cal-body cal-body-year';
  const grid = document.createElement('div'); grid.className = 'cal-year-grid';
  for (let m = 0; m < 12; m++) {
    const wrap = document.createElement('div'); wrap.className = 'cal-year-month';
    const h = document.createElement('button');
    h.type = 'button'; h.className = 'cal-year-month-title'; h.textContent = MONTH_NAMES[m];
    h.onclick = () => { refDate = new Date(refDate.getFullYear(), m, 1); view = 'month'; setViewButtons(); render(); };
    wrap.appendChild(h);
    const mini = document.createElement('div'); mini.className = 'cal-year-mini';
    const start = startOfWeek(new Date(refDate.getFullYear(), m, 1));
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const has = byDate.has(toISO(d));
      const dot = document.createElement('span');
      dot.className = 'cal-year-dot' + (has ? ' has-entries' : '') + (d.getMonth() !== m ? ' dim' : '') + (sameDay(d, new Date()) ? ' today' : '');
      mini.appendChild(dot);
    }
    wrap.appendChild(mini);
    grid.appendChild(wrap);
  }
  r.body.appendChild(grid);
}

function entryRow(en, cls, withBoard) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = cls + (en.done ? ' done' : '');
  const title = document.createElement('span'); title.className = 'cal-entry-title'; title.textContent = en.title;
  row.appendChild(title);
  if (withBoard) { const board = document.createElement('span'); board.className = 'cal-entry-board'; board.textContent = en.canvasTitle; row.appendChild(board); }
  row.onclick = (e) => { e.stopPropagation(); openEntry(en); };
  return row;
}

function emptyRow(text) {
  const d = document.createElement('div'); d.className = 'cal-empty'; d.textContent = text; return d;
}

function renderUpcoming() {
  const r = refs();
  r.upcoming.innerHTML = '';
  const todayIso = toISO(new Date());
  const overdue = entries.filter(e => e.date < todayIso).sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = entries.filter(e => e.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date));
  const combined = [...overdue, ...upcoming].slice(0, 40);
  if (!combined.length) { r.upcoming.appendChild(emptyRow('Nothing due.')); return; }
  for (const en of combined) {
    const info = dueInfo(en.date);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cal-upcoming-row' + (en.done ? ' done' : '') + (info && info.overdue && !en.done ? ' overdue' : '');
    const title = document.createElement('span'); title.className = 'cal-upcoming-title'; title.textContent = en.title;
    const board = document.createElement('span'); board.className = 'cal-upcoming-board'; board.textContent = en.canvasTitle;
    const when = document.createElement('span'); when.className = 'cal-upcoming-when'; when.textContent = info ? info.full : en.date;
    row.append(title, board, when);
    row.onclick = () => openEntry(en);
    r.upcoming.appendChild(row);
  }
}

// Centers the *main canvas's* camera on a world point -- same pattern
// already duplicated in mindmap.js/connect.js.
function centerCameraOn(x, y) {
  const vw = dom.stage.clientWidth, vh = dom.stage.clientHeight;
  state.cam.x = vw / 2 - x * state.cam.scale;
  state.cam.y = vh / 2 - y * state.cam.scale;
  applyCam();
}

// A `task` entry lives inside a todo card's data.tasks[], not as its own
// canvas item -- selects/centers the parent list (listId) instead, same
// as Quick Notes' own "Show on board" already does.
async function openEntry(en) {
  closeCalendar();
  await openCanvas(en.canvasId);
  const targetId = en.kind === 'task' ? en.listId : en.id;
  const target = state.view.items.find(x => x.id === targetId);
  if (target) {
    select(target.id);
    centerCameraOn((target.x || 0) + (target.w || 240) / 2, (target.y || 0) + 60);
  }
}

function shiftRef(delta) {
  const d = new Date(refDate);
  if (view === 'day') d.setDate(d.getDate() + delta);
  else if (view === 'week') d.setDate(d.getDate() + delta * 7);
  else if (view === 'month') d.setMonth(d.getMonth() + delta);
  else d.setFullYear(d.getFullYear() + delta);
  refDate = d;
  render();
}

export function initCalendar() {
  const r = refs();
  document.getElementById('calendarBtn').addEventListener('click', openCalendar);
  r.close.addEventListener('click', closeCalendar);
  r.prev.addEventListener('click', () => shiftRef(-1));
  r.next.addEventListener('click', () => shiftRef(1));
  r.today.addEventListener('click', () => { refDate = new Date(); render(); });
  r.viewToggle.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { view = b.dataset.view; setViewButtons(); render(); });
  });
  document.addEventListener('keydown', (e) => {
    if (r.el.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCalendar(); }
  });
}
