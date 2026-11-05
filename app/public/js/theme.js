'use strict';

import { refreshIcons } from './util.js';

// Light/dark theme toggle, plus the Miladash "look" (classic | night |
// parchment). The initial class and data-look are already applied by an
// inline <script> in <head> (before first paint); this module wires the
// button and keeps localStorage in sync.
//
// classic: Milaclone's own palette, with the light/dark toggle as before.
// night / parchment: Pondering Orb's theme tokens (see style.css). Night is
// dark and Parchment is light, so in those looks the toggle swaps between
// the two instead of only flipping light/dark.

const LOOKS = ['classic', 'night', 'parchment'];

export function currentLook() {
  const l = document.documentElement.dataset.look;
  return LOOKS.includes(l) ? l : 'classic';
}

export function applyLook(look) {
  const root = document.documentElement;
  if (look === 'night' || look === 'parchment') {
    root.dataset.look = look;
    root.classList.toggle('dark', look === 'night');
  } else {
    delete root.dataset.look;
    const t = localStorage.getItem('theme');
    root.classList.toggle('dark', t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  }
}

export function saveLook(look) {
  try { localStorage.setItem('look', LOOKS.includes(look) ? look : 'classic'); } catch (e) {}
}

export function initTheme() {
  const btn = document.getElementById('themeToggle');
  btn.addEventListener('click', () => {
    const look = currentLook();
    if (look !== 'classic') {
      const next = look === 'night' ? 'parchment' : 'night';
      applyLook(next); saveLook(next);
      return;
    }
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  });
  refreshIcons(btn);
}
