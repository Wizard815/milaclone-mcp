'use strict';

import { state } from './state.js';
import { toast } from './util.js';
import { applyCam, zoomBy } from './viewport.js';
import { arm, disarm } from './tools.js';
import { openCanvas } from './main.js';

// Mobile chrome: the header (back / title / share) and footer (board tab, more
// menu, and the swap-in tool tray). The elements exist on every viewport but
// are only shown by the mobile media query in style.css, so all of this can
// be wired unconditionally.

const el = id => document.getElementById(id);

// Called after every canvas load: the header only appears inside sub-boards,
// the root board keeps the full-bleed canvas like Milanote's home screen.
export function updateMobileChrome() {
  const bc = state.view.breadcrumb || [];
  const header = el('mheader');
  header.hidden = bc.length <= 1;
  if (!header.hidden) el('mTitle').textContent = (state.view.canvas && state.view.canvas.title) || 'Untitled board';
}

export function initMobile() {
  const nav = el('mfNav'), tray = el('mfTray'), tools = el('mfTools'), sheet = el('msheet');

  // The tray mirrors the desktop rail: clone its buttons so the icon set and
  // data-tool wiring stay defined in one place. They get their own class so
  // desktop-only selectors keep matching a single element per tool.
  document.querySelectorAll('#rail .tool').forEach(btn => {
    const c = btn.cloneNode(true);
    c.classList.remove('tool');
    c.classList.add('mtool');
    c.addEventListener('click', () => {
      const t = c.dataset.tool;
      if (state.armed === t) { disarm(); return; }
      arm(t, c);
    });
    tools.appendChild(c);
  });

  el('mAdd').onclick = () => { nav.hidden = true; tray.hidden = false; };
  el('mTrayClose').onclick = () => { disarm(); tray.hidden = true; nav.hidden = false; };

  el('mBoards').onclick = () => { if (state.rootCanvasId) openCanvas(state.rootCanvasId); };

  el('mBack').onclick = () => {
    const bc = state.view.breadcrumb;
    if (bc.length > 1) openCanvas(bc[bc.length - 2].id);
  };
  el('mShare').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Board link copied'); }
    catch (e) { toast('Copy this page URL to share'); }
  };

  el('mMore').onclick = () => { sheet.hidden = !sheet.hidden; };
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'zoomin') zoomBy(1.2);
    if (act.dataset.act === 'zoomout') zoomBy(1 / 1.2);
    if (act.dataset.act === 'reset') { state.cam = { x: 80, y: 60, scale: 1 }; applyCam(); }
    if (act.dataset.act === 'export') toast('Tip: your boards auto-save to the server');
    sheet.hidden = true;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!sheet.hidden && !e.target.closest('#msheet') && !e.target.closest('#mMore')) sheet.hidden = true;
  }, true);
}
