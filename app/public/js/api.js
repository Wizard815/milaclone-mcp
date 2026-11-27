'use strict';

import { toast } from './util.js';

// When the server runs with API_KEY, /api answers 401 until this browser has
// signed in. The key is asked for once (a form over the page), traded for an HttpOnly cookie
// (POST /api/login), and the request that was refused is sent again. The
// server never puts the key in the page.
const nativeFetch = window.fetch.bind(window);
let signingIn = null;
// An in-page form, not window.prompt(): browsers block prompts from a page shown
// inside another site's frame (the Orb's Ideas tab).
function askKey(note) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.55);font:15px/1.4 system-ui,sans-serif';
    const form = document.createElement('form');
    form.style.cssText =
      'background:#fff;color:#222;padding:22px;border-radius:10px;width:min(340px,90vw);display:grid;gap:10px';
    const label = document.createElement('label');
    label.textContent = (note ? note + ' ' : '') + 'This board needs its key (API_KEY on the server).';
    label.htmlFor = 'milaclone-key-input';
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'milaclone-key-input';
    input.autocomplete = 'current-password';
    input.required = true;
    input.style.cssText = 'padding:9px;border:1px solid #bbb;border-radius:6px;font:inherit';
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Open the board';
    button.style.cssText =
      'padding:9px;border:0;border-radius:6px;background:#222;color:#fff;font:inherit;cursor:pointer';
    form.append(label, input, button);
    wrap.append(form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      wrap.remove();
      resolve(input.value.trim());
    });
    document.body.append(wrap);
    input.focus();
  });
}
function signIn() {
  signingIn ||= (async () => {
    for (let note = ''; ;) {
      const key = await askKey(note);
      const r = await nativeFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (r.ok) return true;
      if (r.status === 429) {
        toast('Too many wrong keys. Try again in 10 minutes.');
        return false;
      }
      note = 'That key is not right.';
    }
  })().finally(() => {
    signingIn = null;
  });
  return signingIn;
}
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const ours = url.startsWith('/api/') || url.startsWith(location.origin + '/api/');
  const r = await nativeFetch(input, init);
  if (!ours || r.status !== 401 || typeof input !== 'string') return r;
  return (await signIn()) ? nativeFetch(input, init) : r;
};

const json = (method, body, extra) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...extra,
});

// Writes must never fail silently: a failed save says so instead of pretending
// the edit landed. Resolves to the server's item, or null on failure.
async function write(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.ok) return await r.json();
  } catch {
    /* offline or aborted: reported below */
  }
  toast('Could not save — check your connection');
  return null;
}

// Thin wrappers over the JSON endpoints exposed by the Node backend.
export const api = {
  async pipeline() {
    return (await fetch('/api/pipeline')).json();
  },
  async orb() {
    return (await fetch('/api/orb')).json();
  },
  async promote(id) {
    const r = await fetch('/api/item/' + id + '/promote', json('POST', {}));
    return { ok: r.ok, body: await r.json() };
  },
  async exportCanvas(id, nested) {
    return (await fetch('/api/canvas/' + id + '/export' + (nested ? '?nested=1' : ''))).json();
  },
  async importCanvas(id, body) {
    const r = await fetch('/api/canvas/' + id + '/import', json('POST', body));
    return { ok: r.ok, body: await r.json() };
  },
  async root() {
    return (await fetch('/api/root')).json();
  },
  async canvas(id) {
    return (await fetch('/api/canvas/' + id)).json();
  },
  // Never throws: a failed search just shows no results.
  async search(q) {
    try {
      return (await (await fetch('/api/search?q=' + encodeURIComponent(q))).json()).results || [];
    } catch {
      return [];
    }
  },
  async todos() {
    return (await fetch('/api/todos')).json();
  },
  patchCanvas(id, body) {
    return write('/api/canvas/' + id, json('PATCH', body));
  },
  async create(body) {
    return (
      await fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  },
  // `keepalive` lets a save started while the page is closing still reach the server.
  patch(id, body, keepalive = false) {
    return write('/api/item/' + id, json('PATCH', body, { keepalive }));
  },
  patchMany(updates) {
    return write('/api/items', json('PATCH', { updates }));
  },
  async remove(id) {
    return (await fetch('/api/item/' + id, { method: 'DELETE' })).json();
  },
  restore(id) {
    return write('/api/item/' + id + '/restore', { method: 'POST' });
  },
  copy(id, to) {
    return write('/api/item/' + id + '/copy', json('POST', to));
  },
  move(id, to) {
    return write('/api/item/' + id + '/move', json('POST', to));
  },
  // null when the server can't be reached or errors.
  async trash() {
    try {
      const r = await fetch('/api/trash');
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  emptyTrash() {
    return write('/api/trash', { method: 'DELETE' });
  },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return (await fetch('/api/upload', { method: 'POST', body: fd })).json();
  },
};
