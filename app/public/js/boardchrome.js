'use strict';

import { state } from './state.js';
import { colorVar, lucideEl, refreshIcons } from './util.js';
import { deselect, renameSelected, deleteItem } from './editing.js';
import { openPalette, closePalette } from './menus.js';
import { disarm } from './tools.js';

// When a board card is selected, the create rail / mobile nav swap out for
// Color · Icon · Rename · Delete (Milanote-style). Non-board cards keep the
// floating card-tools badge.

const el = id => document.getElementById(id);

function selectedBoard() {
  if (!state.selectedId) return null;
  const it = state.view.items.find(i => i.id === state.selectedId);
  return it && it.type === 'board' ? it : null;
}

export function updateSelectionChrome() {
  const board = selectedBoard();
  const railCreate = el('railCreate');
  const railBoard = el('railBoard');
  const mfNav = el('mfNav');
  const mfTray = el('mfTray');
  const mfBoard = el('mfBoard');
  const mBoardSheet = el('mBoardSheet');

  if (board) {
    disarm();
    if (railCreate) railCreate.hidden = true;
    if (railBoard) railBoard.hidden = false;
    if (mfNav) mfNav.hidden = true;
    if (mfTray) mfTray.hidden = true;
    if (mfBoard) mfBoard.hidden = false;
    refreshIcons(el('railBoard'));
    refreshIcons(el('mfBoard'));
  } else {
    if (railCreate) railCreate.hidden = false;
    if (railBoard) railBoard.hidden = true;
    if (mfBoard) mfBoard.hidden = true;
    if (mfNav && (!mfTray || mfTray.hidden)) mfNav.hidden = false;
    if (mBoardSheet) mBoardSheet.hidden = true;
    closePalette();
  }
}

export function initBoardChrome() {
  el('railBoardBack').onclick = () => deselect();
  el('railBoardRename').onclick = () => renameSelected();
  el('railBoardDelete').onclick = () => {
    const it = selectedBoard(); if (!it) return;
    deleteItem(it.id);
  };

  el('mfBoardRename').onclick = () => renameSelected();
  el('mfBoardDone').onclick = () => deselect();

  const sheet = el('mBoardSheet');
  el('mfBoardMore').onclick = () => { sheet.hidden = !sheet.hidden; };
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'delete') {
      const it = selectedBoard();
      if (it) deleteItem(it.id);
    }
    sheet.hidden = true;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!sheet.hidden && !e.target.closest('#mBoardSheet') && !e.target.closest('#mfBoardMore')) {
      sheet.hidden = true;
    }
  }, true);

  updateSelectionChrome();
}
