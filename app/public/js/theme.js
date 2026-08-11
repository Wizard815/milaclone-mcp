'use strict';

import { refreshIcons } from './util.js';

// Light/dark theme toggle. The initial class is already applied by an inline
// <script> in <head> (before first paint); this module just wires the button
// and keeps localStorage in sync.

export function initTheme() {
  const btn = document.getElementById('themeToggle');
  btn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  });
  refreshIcons(btn);
}
