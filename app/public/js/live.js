'use strict';

// Live refresh for agents' edits. Agents (the MCP server, Pondering Orb, Hermes
// Studio) write through the API with an X-Milaclone-Agent header, and the server
// logs each write in /api/activity. While the page is visible this polls that
// log; when an agent changed the open board it reloads it (not while you are
// editing or dragging: the next poll tries again) and says who did what.

export const AGENT_STATES = { doing: 'Doing', done: 'Done', blocked: 'Blocked' };

// "Hermes added 2 card(s): Pegboard, Screws" or "Hermes and Ekko made 5 changes".
export function summarize(entries) {
  if (!entries.length) return '';
  const who = [...new Set(entries.map(e => e.actor || 'An agent'))];
  const names = who.length > 2 ? `${who.slice(0, 2).join(', ')} and others` : who.join(' and ');
  if (entries.length === 1) return `${names} ${entries[0].summary}`;
  return `${names} made ${entries.length} changes`;
}

// What a card's agent status chip says: words, so the state never rests on colour.
export function statusLabel(st) {
  if (!st || !AGENT_STATES[st.state]) return null;
  const text = AGENT_STATES[st.state] + (st.by ? ' · ' + st.by : '');
  const title = `${st.by || 'An agent'}: ${st.state}${st.detail ? ' (' + st.detail + ')' : ''}`;
  return { text, title };
}

// opts: fetchActivity(since) -> {items, latest}; boardId() -> id of the open board;
// canReload() -> false while editing; reload() -> Promise; notify(text);
// visible() -> page visible; every (ms).
export function startLive(opts) {
  const every = opts.every || 4000;
  let since = null,
    waiting = [],
    timer = null,
    busy = false;
  async function tick() {
    if (busy || !opts.visible()) return;
    busy = true;
    try {
      const r = await opts.fetchActivity(since ?? 0);
      if (since === null) {
        since = r.latest || 0; // the first answer only sets where "new" starts
        return;
      }
      since = Math.max(since, r.latest || 0);
      const board = opts.boardId();
      // Only the open board matters; moving to another drops what waited for the old one.
      waiting = waiting.concat(r.items || []).filter(e => e.canvasId === board);
      if (waiting.length && opts.canReload()) {
        const mine = waiting;
        waiting = [];
        await opts.reload();
        opts.notify(summarize(mine.slice().reverse()));
      }
    } catch {
      /* offline or the server restarted: try again next time */
    } finally {
      busy = false;
    }
  }
  tick();
  timer = setInterval(tick, every);
  return { tick, stop: () => clearInterval(timer) };
}
