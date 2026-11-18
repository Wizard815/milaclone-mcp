'use strict';

import { api } from './api.js';
import { toast, refreshIcons } from './util.js';

// Full-page document editor. A document card on the board is just a tile;
// opening it swaps in this overlay, which owns a contenteditable body and a
// small execCommand-driven formatting toolbar. Kept separate from cards.js
// so the canvas module doesn't need to know about rich-text editing.

let doc = null; // the item currently open, or null
let el = null; // cached DOM refs, populated lazily on first open

function refs() {
  if (el) return el;
  el = {
    root: document.getElementById('docEditor'),
    back: document.getElementById('deBack'),
    title: document.getElementById('deTitle'),
    content: document.getElementById('deContent'),
    toolbar: document.getElementById('deToolbar'),
    exportBtn: document.getElementById('deExportBtn'),
    exportMenu: document.getElementById('deExportMenu'),
  };
  return el;
}

export function isDocumentOpen() {
  return !!doc;
}

export function openDocument(it) {
  doc = it;
  const r = refs();
  r.root.hidden = false;
  r.title.value = it.data.title || '';
  r.content.innerHTML = it.data.bodyHtml || '';
  externalLinks(r.content);
  refreshIcons(r.root);
  requestAnimationFrame(() => r.content.focus());
}

export function closeDocument() {
  if (!doc) return;
  const r = refs();
  r.exportMenu.hidden = true;
  r.root.hidden = true;
  doc = null;
}

const saveTimers = new Map();
function save(patch) {
  if (!doc) return;
  Object.assign(doc.data, patch);
  if (patch.title != null) doc._title = patch.title;
  clearTimeout(saveTimers.get(doc.id));
  saveTimers.set(
    doc.id,
    setTimeout(() => api.patch(doc.id, { data: patch }), 400)
  );
}

function exec(cmd) {
  const r = refs();
  r.content.focus();
  if (cmd === 'blockquote') {
    document.execCommand('formatBlock', false, 'blockquote');
    return;
  }
  if (cmd === 'code') {
    const sel = window.getSelection();
    const text = sel && sel.toString();
    document.execCommand('insertHTML', false, '<code>' + (text || 'code') + '</code>');
    return;
  }
  if (cmd === 'link') {
    const url = window.prompt('Link URL');
    if (url) {
      document.execCommand('createLink', false, url);
      externalLinks(r.content);
      save({ bodyHtml: r.content.innerHTML });
    }
    return;
  }
  document.execCommand(cmd, false, null);
}

// Links in a document always open in a new tab, never in place: when
// Milaclone is embedded in an <iframe> an in-place navigation would replace
// the app inside the frame.
function externalLinks(root) {
  root.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || '';
}

// A small, deliberately lossy HTML -> Markdown pass covering exactly the
// formatting the toolbar can produce.
function htmlToMarkdown(root) {
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const inner = () => [...node.childNodes].map(walk).join('');
    switch (node.tagName) {
      case 'B':
      case 'STRONG':
        return `**${inner()}**`;
      case 'I':
      case 'EM':
        return `*${inner()}*`;
      case 'U':
        return `<u>${inner()}</u>`;
      case 'S':
      case 'STRIKE':
        return `~~${inner()}~~`;
      case 'CODE':
        return `\`${inner()}\``;
      case 'A':
        return `[${inner()}](${node.getAttribute('href') || ''})`;
      case 'BLOCKQUOTE':
        return `> ${inner()}\n`;
      case 'LI':
        return `- ${inner()}\n`;
      case 'UL':
      case 'OL':
        return inner() + '\n';
      case 'DIV':
      case 'P':
        return inner() + '\n';
      case 'BR':
        return '\n';
      default:
        return inner();
    }
  };
  return [...root.childNodes]
    .map(walk)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAs(kind) {
  const r = refs();
  const title = (r.title.value || 'Untitled document').trim();
  if (kind === 'txt') {
    download(title + '.txt', stripHtml(r.content.innerHTML), 'text/plain');
  } else if (kind === 'md') {
    download(title + '.md', htmlToMarkdown(r.content), 'text/markdown');
  } else if (kind === 'docx') {
    // Word opens well-formed HTML saved with a .doc extension; this avoids
    // pulling in a real docx-writer for basic formatted text.
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>${r.content.innerHTML}</body></html>`;
    download(title + '.doc', html, 'application/msword');
  } else if (kind === 'pdf') {
    const w = window.open('', '_blank');
    if (!w) {
      toast('Allow pop-ups to export as PDF');
      return;
    }
    w.document.write(`<html><head><title>${title}</title><style>
      body { font-family: Georgia, serif; max-width: 720px; margin: 40px auto; line-height: 1.5; }
      h1 { font-size: 22px; }
    </style></head><body><h1>${title}</h1>${r.content.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }
  r.exportMenu.hidden = true;
}

export function initDocs() {
  const r = refs();
  r.back.addEventListener('click', closeDocument);
  r.title.addEventListener('input', () => save({ title: r.title.value }));
  r.content.addEventListener('input', () => save({ bodyHtml: r.content.innerHTML }));
  // A link inside contenteditable doesn't follow on a plain click (that just
  // places the caret); Ctrl/Cmd-click opens it in a new tab.
  r.content.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  });
  // mousedown (not click) + preventDefault so the button never steals focus
  // from the content area — otherwise the text selection collapses before
  // execCommand runs and formatting silently applies to nothing.
  r.toolbar.addEventListener('mousedown', e => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    exec(btn.dataset.cmd);
  });
  r.exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    r.exportMenu.hidden = !r.exportMenu.hidden;
  });
  r.exportMenu.addEventListener('click', e => {
    const btn = e.target.closest('[data-export]');
    if (btn) exportAs(btn.dataset.export);
  });
  document.addEventListener('pointerdown', e => {
    if (!r.exportMenu.hidden && !e.target.closest('.de-exportwrap')) r.exportMenu.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (!doc) return;
    if (e.key === 'Escape') closeDocument();
  });
}
