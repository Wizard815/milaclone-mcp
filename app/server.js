'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { DB_FILE } = require('./db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = (process.env.API_KEY || '').trim();

const app = express();
app.use(express.json({ limit: '5mb' }));

// Serve index.html ourselves (with the API key injected as a meta tag) so the
// browser UI can keep authenticating against /api/* once API_KEY is set.
// Everything else (js/, style.css, uploads/) is still served statically.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get('/', (req, res) => {
  const html = API_KEY
    ? INDEX_HTML.replace('</head>', `  <meta name="milaclone-key" content="${API_KEY}">\n</head>`)
    : INDEX_HTML;
  res.type('html').send(html);
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(require('./routes'));

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
