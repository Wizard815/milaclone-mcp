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
    // --user-accent (not --accent, which the whole UI's buttons/links/
    // checkboxes reuse) -- scoped to just the mind map and selection/
    // marquee highlights. !important: :root.dark's own --user-accent
    // (style.css) has higher specificity than a plain :root rule and would
    // otherwise win in dark mode regardless of source order.
    inject.push(`  <style>:root{--user-accent:${settings.accent} !important;}</style>`);
  }
  // Miladash look (classic | night | parchment): applied as data-look on
  // <html> by the inline head script, before first paint.
  if (settings.look === 'night' || settings.look === 'parchment') {
    inject.push(`  <meta name="milaclone-default-look" content="${settings.look}">`);
  }
  if (inject.length) out = out.replace('<head>', '<head>\n' + inject.join('\n'));

  res.set('Cache-Control', 'no-cache').type('html').send(out);
});
// no-cache (not no-store): still uses ETag/Last-Modified conditional
// requests, so unchanged assets get a cheap 304 instead of a full refetch —
// this just stops the browser from skipping that check entirely and running
// on a stale copy after a deploy.
// Lucide icons ship as an npm runtime dependency and are served from the app
// itself, so icons render on self-hosted boxes with no route to a CDN.
const LUCIDE_UMD = path.join(path.dirname(require.resolve('lucide/package.json')), 'dist', 'umd');
app.use('/vendor/lucide', express.static(LUCIDE_UMD, {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
}));
// Fonts ship as npm packages too (Fontsource), served at /vendor/fonts.css with
// the family names the stylesheet uses, so nothing is fetched from Google.
const FONT_FILES = [
  ['@fontsource-variable/fraunces', 'opsz.css', 'Fraunces'],
  ['@fontsource-variable/source-serif-4', 'opsz.css', 'Source Serif 4'],
  ['@fontsource/figtree', '400.css', 'Figtree'], ['@fontsource/figtree', '500.css', 'Figtree'], ['@fontsource/figtree', '600.css', 'Figtree'],
  ['@fontsource/cinzel', '500.css', 'Cinzel'], ['@fontsource/cinzel', '600.css', 'Cinzel'], ['@fontsource/cinzel', '700.css', 'Cinzel'],
  ['@fontsource/alegreya-sans', '400.css', 'Alegreya Sans'], ['@fontsource/alegreya-sans', '500.css', 'Alegreya Sans'], ['@fontsource/alegreya-sans', '700.css', 'Alegreya Sans']
];
const fontDir = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));
const FONTS_CSS = FONT_FILES.map(([pkg, file, family]) => {
  const slug = pkg.split('/')[1];
  return fs.readFileSync(path.join(fontDir(pkg), file), 'utf8')
    .replace(/font-family:\s*'[^']*'/g, `font-family: '${family}'`)
    .replace(/url\(\.\/files\//g, `url(/vendor/fonts/${slug}/`);
}).join('\n');
app.get('/vendor/fonts.css', (req, res) => res.type('text/css').set('Cache-Control', 'no-cache').send(FONTS_CSS));
for (const pkg of new Set(FONT_FILES.map(f => f[0]))) {
  app.use(`/vendor/fonts/${pkg.split('/')[1]}`, express.static(path.join(fontDir(pkg), 'files'), { index: false, maxAge: '30d', immutable: true }));
}
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
}));
app.use(require('./routes'));

app.listen(PORT, HOST, () => {
  console.log(`\n  Miladash running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
