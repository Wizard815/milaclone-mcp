'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { DB_FILE, getSettings } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = (process.env.API_KEY || '').trim();

const app = express();
app.use(express.json({ limit: '5mb' }));

// Serve index.html ourselves (with the API key injected as a meta tag) so the
// browser UI can keep authenticating against /api/* once API_KEY is set.
// Everything else (js/, style.css, uploads/) is still served statically.
//
// Read fresh on every request rather than cached at boot: with a cached copy,
// a `git pull` without restarting the container silently keeps serving the
// old markup indefinitely — the disk read is negligible for a personal,
// low-traffic app and it's a much easier failure mode to reason about.
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
// Only a 3/4/6/8-digit hex color is ever allowed into the injected <style>
// tag below -- settings.accent is user-supplied and this keeps it from being
// used to break out of the tag.
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

app.get('/', (req, res) => {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  let out = html;
  if (API_KEY) out = out.replace('</head>', `  <meta name="milaclone-key" content="${API_KEY}">\n</head>`);

  const settings = getSettings();
  // Server-rendered so the default theme/accent are consistent on first load
  // across every device, before any per-browser localStorage override exists.
  // Injected right after <head> -- must land before the inline theme script
  // further down the head, which reads milaclone-default-theme synchronously.
  const inject = [];
  if (settings.theme === 'light' || settings.theme === 'dark') {
    inject.push(`  <meta name="milaclone-default-theme" content="${settings.theme}">`);
  }
  if (settings.accent && HEX_COLOR.test(settings.accent)) {
    // !important: :root.dark's own --accent (style.css) has higher
    // specificity than a plain :root rule and would otherwise win in dark
    // mode regardless of source order.
    inject.push(`  <style>:root{--accent:${settings.accent} !important;}</style>`);
  }
  if (inject.length) out = out.replace('<head>', '<head>\n' + inject.join('\n'));

  res.set('Cache-Control', 'no-cache').type('html').send(out);
});
// no-cache (not no-store): still uses ETag/Last-Modified conditional
// requests, so unchanged assets get a cheap 304 instead of a full refetch —
// this just stops the browser from skipping that check entirely and running
// on a stale copy after a deploy.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
}));
app.use(require('./routes'));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
