'use strict';

import { api } from './api.js';
import { toast } from './util.js';

// App-wide settings modal: default theme, accent color, star color, CalDAV
// credentials. Server-side default theme/accent/starColor are also baked
// into index.html on every request (see server.js) so a fresh device gets
// them before first paint; this module is what lets you change them, plus
// live-preview accent/star color and apply theme changes immediately on save.

let cached = null; // last-loaded settings, so Cancel can revert a live accent preview

function refs() {
  return {
    root: document.getElementById('settingsModal'),
    backdrop: document.getElementById('setBackdrop'),
    seg: document.getElementById('setThemeSeg'),
    accent: document.getElementById('setAccent'),
    accentHex: document.getElementById('setAccentHex'),
    accentReset: document.getElementById('setAccentReset'),
    starColor: document.getElementById('setStarColor'),
    starColorHex: document.getElementById('setStarColorHex'),
    starColorReset: document.getElementById('setStarColorReset'),
    caldavUrl: document.getElementById('setCaldavUrl'),
    caldavUser: document.getElementById('setCaldavUser'),
    caldavPass: document.getElementById('setCaldavPass'),
    caldavStatus: document.getElementById('setCaldavStatus'),
    cancel: document.getElementById('setCancel'),
    save: document.getElementById('setSave')
  };
}

// --user-accent, not --accent -- the latter is reused by buttons, links,
// checkboxes etc. across the whole UI, so overriding it directly repaints
// far more than the mind map / selection highlights this setting is for.
function applyAccent(hex) {
  if (hex) document.documentElement.style.setProperty('--user-accent', hex);
  else document.documentElement.style.removeProperty('--user-accent');
}

function applyStarColor(hex) {
  if (hex) document.documentElement.style.setProperty('--star-color', hex);
  else document.documentElement.style.removeProperty('--star-color');
}

function setThemeSeg(r, theme) {
  r.seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.val === theme));
}

async function open() {
  const r = refs();
  cached = await api.getSettings();
  setThemeSeg(r, cached.theme || 'system');
  const accent = cached.accent || '#2f6df0';
  r.accent.value = accent;
  r.accentHex.value = cached.accent || '';
  const starColor = cached.starColor || '#E8B94A';
  r.starColor.value = starColor;
  r.starColorHex.value = cached.starColor || '';
  r.caldavUrl.value = (cached.caldav && cached.caldav.url) || '';
  r.caldavUser.value = (cached.caldav && cached.caldav.username) || '';
  r.caldavPass.value = '';
  r.caldavPass.placeholder = cached.caldav && cached.caldav.passwordSet ? 'Leave blank to keep current password' : 'Password';
  r.caldavStatus.textContent = '';
  r.root.hidden = false;
}

function close() {
  refs().root.hidden = true;
  applyAccent(cached && cached.accent); // undo any unsaved live preview
  applyStarColor(cached && cached.starColor);
}

function applyThemeToThisBrowser(theme) {
  if (theme === 'system') {
    localStorage.removeItem('theme');
    document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches);
  } else {
    localStorage.setItem('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

async function save() {
  const r = refs();
  const theme = r.seg.querySelector('button.on')?.dataset.val || 'system';
  const accentHex = r.accentHex.value.trim();
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(accentHex) ? accentHex : null;
  const starColorHex = r.starColorHex.value.trim();
  const starColor = /^#[0-9a-fA-F]{3,8}$/.test(starColorHex) ? starColorHex : null;

  const patch = { theme, accent, starColor };
  const url = r.caldavUrl.value.trim();
  const username = r.caldavUser.value.trim();
  const password = r.caldavPass.value;
  if (url || username || password) patch.caldav = { url, username, password };

  const saved = await api.patchSettings(patch);
  cached = saved;
  applyThemeToThisBrowser(theme);
  applyAccent(accent);
  applyStarColor(starColor);
  toast('Settings saved');
  refs().root.hidden = true;
}

export function initSettings() {
  const r = refs();
  document.getElementById('settingsBtn').onclick = open;

  r.accent.addEventListener('input', () => {
    r.accentHex.value = r.accent.value;
    applyAccent(r.accent.value);
  });
  r.accentHex.addEventListener('input', () => {
    const v = r.accentHex.value.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) { r.accent.value = v.length <= 7 ? v : v.slice(0, 7); applyAccent(v); }
  });
  r.accentReset.onclick = () => { r.accentHex.value = ''; r.accent.value = '#2f6df0'; applyAccent(null); };

  r.starColor.addEventListener('input', () => {
    r.starColorHex.value = r.starColor.value;
    applyStarColor(r.starColor.value);
  });
  r.starColorHex.addEventListener('input', () => {
    const v = r.starColorHex.value.trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) { r.starColor.value = v.length <= 7 ? v : v.slice(0, 7); applyStarColor(v); }
  });
  r.starColorReset.onclick = () => { r.starColorHex.value = ''; r.starColor.value = '#E8B94A'; applyStarColor(null); };

  r.seg.querySelectorAll('button').forEach(b => {
    b.onclick = () => setThemeSeg(r, b.dataset.val);
  });

  r.save.onclick = () => save().catch(() => toast('Could not save settings'));
  r.cancel.onclick = close;
  r.backdrop.onclick = close;
  document.addEventListener('keydown', (e) => {
    if (r.root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // Mobile "•••" sheet reuses the same settings entry point.
  const msheet = document.getElementById('msheet');
  msheet?.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="settings"]')) open();
  });

  // Bake in the server-rendered accent (if any) as the live baseline so a
  // Cancel after a live preview has something correct to revert to.
  api.getSettings().then(s => { cached = s; }).catch(() => {});
}
