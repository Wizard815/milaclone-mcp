'use strict';

// A promise-based, in-app stand-in for window.confirm(). Native confirm()
// dialogs are unreliable across embedded/mobile webviews — some suppress
// them entirely, some auto-answer without showing anything — and this app
// has a real mobile mode where that matters. Only one confirm can be open
// at a time, which is all this app ever needs.

let els = null;
let resolvePending = null;

function refs() {
  if (els) return els;
  els = {
    root: document.getElementById('confirmModal'),
    backdrop: document.querySelector('#confirmModal .cm-backdrop'),
    message: document.getElementById('cmMessage'),
    cancel: document.getElementById('cmCancel'),
    ok: document.getElementById('cmOk')
  };
  return els;
}

function close(result) {
  const r = refs();
  r.root.hidden = true;
  if (resolvePending) { resolvePending(result); resolvePending = null; }
}

export function confirmDialog(message, { okLabel = 'Delete' } = {}) {
  const r = refs();
  r.message.textContent = message;
  r.ok.textContent = okLabel;
  r.root.hidden = false;
  return new Promise((resolve) => {
    resolvePending = resolve;
  });
}

export function isConfirmOpen() {
  return !!els && !els.root.hidden;
}

export function initConfirmDialog() {
  const r = refs();
  r.ok.addEventListener('click', () => close(true));
  r.cancel.addEventListener('click', () => close(false));
  r.backdrop.addEventListener('click', () => close(false));
  document.addEventListener('keydown', (e) => {
    if (r.root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
  });
}
