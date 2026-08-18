'use strict';

// Thin wrappers over the JSON endpoints exposed by the Node backend.
const API_KEY = document.querySelector('meta[name="milaclone-key"]')?.content || '';
const authHeaders = API_KEY ? { 'X-API-Key': API_KEY } : {};
const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, authHeaders);

export const api = {
  async root() { return (await fetch('/api/root', { headers: authHeaders })).json(); },
  async canvas(id) { return (await fetch('/api/canvas/' + id, { headers: authHeaders })).json(); },
  async graph() { return (await fetch('/api/graph', { headers: authHeaders })).json(); },
  async todos() { return (await fetch('/api/todos', { headers: authHeaders })).json(); },
  async patchCanvas(id, body) { return (await fetch('/api/canvas/' + id, { method:'PATCH', headers: jsonHeaders, body:JSON.stringify(body) })).json(); },
  async create(body) { return (await fetch('/api/item', { method:'POST', headers: jsonHeaders, body:JSON.stringify(body) })).json(); },
  async patch(id, body) { return (await fetch('/api/item/' + id, { method:'PATCH', headers: jsonHeaders, body:JSON.stringify(body) })).json(); },
  async patchMany(updates) { return (await fetch('/api/items', { method:'PATCH', headers: jsonHeaders, body:JSON.stringify({updates}) })).json(); },
  async remove(id) { return (await fetch('/api/item/' + id, { method:'DELETE', headers: authHeaders })).json(); },
  async restore(id) { return (await fetch('/api/item/' + id + '/restore', { method:'POST', headers: authHeaders })).json(); },
  async upload(file) { const fd = new FormData(); fd.append('file', file); return (await fetch('/api/upload', { method:'POST', headers: authHeaders, body:fd })).json(); },
  async getSettings() { return (await fetch('/api/settings', { headers: authHeaders })).json(); },
  async patchSettings(body) { return (await fetch('/api/settings', { method:'PATCH', headers: jsonHeaders, body:JSON.stringify(body) })).json(); },
  async tags() { return (await fetch('/api/tags', { headers: authHeaders })).json(); }
};
