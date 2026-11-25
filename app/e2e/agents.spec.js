'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// Agents on boards: an agent's edit to the open board shows up without a reload,
// with a note of who did it, and its status and Orb chips are words, not colours.

test("an agent's edit appears live, with who did it and the card's status", async ({ page }) => {
  const cid = await freshCanvas(page);
  await page.waitForTimeout(500); // the first poll only notes where "new" starts
  await page.evaluate(
    cid =>
      fetch('/api/agent/board/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Milaclone-Agent': 'Hermes' },
        body: JSON.stringify({
          board: cid,
          cards: [{ text: 'Agent card', section: 'Plan', status: 'doing', orb: { kind: 'task', id: 't1' } }],
        }),
      }),
    cid
  );
  const card = page.locator('.item.type-note', { hasText: 'Agent card' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.locator('.agent-chip.agent-doing')).toHaveText('Doing');
  await expect(card.locator('.agent-chip.agent-orb')).toHaveText('Orb task');
  await expect(page.locator('#toast')).toContainText('Hermes added 1 card(s): Agent card');
});
