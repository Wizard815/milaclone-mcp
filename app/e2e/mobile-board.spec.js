'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// WebKit/Safari does not synthesize dblclick from touch double-taps, so board
// open has to be driven by our own pointer double-tap detection.

test('double-tap opens a board card on mobile Safari', async ({ page }) => {
  const canvasId = await freshCanvas(page);

  const board = await page.evaluate(async (canvasId) => {
    const it = await (await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId, type: 'board', x: 40, y: 160, data: { title: 'Nested' } }),
    })).json();
    return { id: it.id, childId: it.data.childCanvasId };
  }, canvasId);

  // Re-enter the canvas so the new card is rendered.
  await page.goto('/#' + canvasId);
  const card = page.locator(`.item.type-board[data-id="${board.id}"]`);
  await expect(card).toBeVisible();

  const box = await card.locator('.tile').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(x, y);

  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + board.childId);
  await expect(page.locator('#mheader')).toBeVisible();
});
