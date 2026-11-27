'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { DB_FILE } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';

// Bundle the TipTap editor (public/js/editor.js + its npm deps) into
// public/vendor/editor.js. Cards import() it the first time a note is edited.
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'public/js/editor.js')],
  outfile: path.join(__dirname, 'public/vendor/editor.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  logLevel: 'warning',
});

const app = express();

// Lucide icons and the UI fonts ship as pinned npm dependencies and are served
// by the app itself, so a self-hosted box with no route to a CDN still renders.
const pkgDir = pkg => path.dirname(require.resolve(`${pkg}/package.json`));
app.use('/vendor/lucide', express.static(path.join(pkgDir('lucide'), 'dist', 'umd'), { index: false }));
const FONT_FILES = [
  ['@fontsource-variable/fraunces', 'opsz.css', 'Fraunces'],
  ['@fontsource-variable/source-serif-4', 'opsz.css', 'Source Serif 4'],
  ['@fontsource/figtree', '400.css', 'Figtree'],
  ['@fontsource/figtree', '500.css', 'Figtree'],
  ['@fontsource/figtree', '600.css', 'Figtree'],
];
const FONTS_CSS = FONT_FILES.map(([pkg, file, family]) =>
  fs
    .readFileSync(path.join(pkgDir(pkg), file), 'utf8')
    .replace(/font-family:\s*'[^']*'/g, `font-family: '${family}'`)
    .replace(/url\(\.\/files\//g, `url(/vendor/fonts/${pkg.split('/')[1]}/`)
).join('\n');
app.get('/vendor/fonts.css', (req, res) => res.type('text/css').send(FONTS_CSS));
for (const pkg of new Set(FONT_FILES.map(f => f[0]))) {
  app.use(
    `/vendor/fonts/${pkg.split('/')[1]}`,
    express.static(path.join(pkgDir(pkg), 'files'), { index: false, maxAge: '30d', immutable: true })
  );
}

// The generic handler can also reach public/uploads (e.g. via an encoded URL), so
// it applies the same upload safety headers to anything it resolves in there.
const routes = require('./routes');
app.use(routes);
// The service worker is re-checked on every launch so an update lands right away.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: routes.setUploadHeaders }));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
