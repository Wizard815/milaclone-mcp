'use strict';

import { toast } from './util.js';

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

// Thin wrappers over the JSON endpoints exposed by the Node backend. When the
// server has an API_KEY it injects it into index.html as a meta tag, and every
// request carries it.
const API_KEY = document.querySelector('meta[name="milaclone-key"]')?.content || '';
const authHeaders = API_KEY ? { 'X-API-Key': API_KEY } : {};
const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, authHeaders);

const json = (method, body, extra) => ({
  method,
  headers: jsonHeaders,
  body: JSON.stringify(body),
  ...extra,
});

export const api = {
  async root() {
    return (await fetch('/api/root', { headers: authHeaders })).json();
  },
  async canvas(id) {
    return (await fetch('/api/canvas/' + id, { headers: authHeaders })).json();
  },
  async graph() {
    return (await fetch('/api/graph', { headers: authHeaders })).json();
  },
  // Never throws: a failed search just shows no results.
  async search(q) {
    try {
      return (
        (await (await fetch('/api/search?q=' + encodeURIComponent(q), { headers: authHeaders })).json()).results || []
      );
    } catch {
      return [];
    }
  },
  async todos() {
    return (await fetch('/api/todos', { headers: authHeaders })).json();
  },
  patchCanvas(id, body) {
    return write('/api/canvas/' + id, json('PATCH', body));
  },
  async create(body) {
    return (await fetch('/api/item', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })).json();
  },
  // `keepalive` lets a save started while the page is closing still reach the server.
  patch(id, body, keepalive = false) {
    return write('/api/item/' + id, json('PATCH', body, { keepalive }));
  },
  patchMany(updates) {
    return write('/api/items', json('PATCH', { updates }));
  },
  async remove(id) {
    return (await fetch('/api/item/' + id, { method: 'DELETE', headers: authHeaders })).json();
  },
  restore(id) {
    return write('/api/item/' + id + '/restore', { method: 'POST', headers: authHeaders });
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
      const r = await fetch('/api/trash', { headers: authHeaders });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  emptyTrash() {
    return write('/api/trash', { method: 'DELETE', headers: authHeaders });
  },
  // A file download (Markdown export, database backup) fetched with the API key,
  // which a plain <a download> navigation can't send. null on failure.
  async file(url) {
    try {
      const r = await fetch(url, { headers: authHeaders });
      if (!r.ok) return null;
      const cd = r.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
      return { blob: await r.blob(), name: m ? decodeURIComponent(m[1]) : '' };
    } catch {
      return null;
    }
  },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return (await fetch('/api/upload', { method: 'POST', headers: authHeaders, body: fd })).json();
  },
  async getSettings() {
    return (await fetch('/api/settings', { headers: authHeaders })).json();
  },
  async patchSettings(body) {
    return (await fetch('/api/settings', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body) })).json();
  },
  async tags() {
    return (await fetch('/api/tags', { headers: authHeaders })).json();
  },
  async pipeline() {
    return (await fetch('/api/pipeline', { headers: authHeaders })).json();
  },
  async orb() {
    return (await fetch('/api/orb', { headers: authHeaders })).json();
  },
  async promote(id) {
    const r = await fetch('/api/item/' + id + '/promote', { method: 'POST', headers: jsonHeaders, body: '{}' });
    return { ok: r.ok, body: await r.json() };
  },
  async exportCanvas(id, nested) {
    const r = await fetch('/api/canvas/' + id + '/export' + (nested ? '?nested=1' : ''), { headers: authHeaders });
    return r.json();
  },
  async importCanvas(id, body) {
    const r = await fetch('/api/canvas/' + id + '/import', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    return { ok: r.ok, body: await r.json() };
  },
};
