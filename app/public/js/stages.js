'use strict';

import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { refreshItem } from './cards.js';

// Miladash idea stages. Stage is a field on the card, never its position:
// moving a card on the board leaves its stage alone, and the Pipeline view
// (pipeline.js) is the only place where dragging changes it.

export const STAGE_LABELS = { thought: 'Thought', design: 'Design', code: 'Code' };

// Sets (or clears, with null) the stage of every item in `items`.
export async function setStage(items, stage) {
  for (const it of items) {
    if ((it.stage || null) === (stage || null)) continue;
    it.stage = stage || null;
    it.updatedAt = Date.now();
    refreshItem(it);
    await api.patch(it.id, { stage: it.stage });
  }
  if (items.length > 1) toast(stage ? `${items.length} cards set to ${STAGE_LABELS[stage]}` : 'Stage cleared');
}

// Ask the server to create a project in Pondering Orb for a Code-stage idea.
// The server holds ORB_URL/ORB_TOKEN; the browser never sees the token.
export async function promoteItem(it) {
  toast('Promoting to Orb…');
  const { ok, body } = await api.promote(it.id);
  if (!ok) { toast(body.error || 'Promote failed'); return; }
  it.data = body.item.data;
  it.updatedAt = body.item.updatedAt;
  refreshItem(it);
  toast(`"${body.item.data.promoted.name}" is now a project in Orb`);
}

export async function loadOrbStatus() {
  try { state.orb = await api.orb(); } catch (e) { state.orb = { configured: false }; }
}
