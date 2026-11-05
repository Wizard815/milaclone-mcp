'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

// Miladash: stage chips, the Pipeline view, arrow kinds and box-select.

async function seedNotes(page, canvasId) {
  return page.evaluate(async (cid) => {
    const mk = (b) => fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ canvasId: cid, type: 'note', w: 220 }, b)) }).then(r => r.json());
    const a = await mk({ x: 100, y: 100, data: { title: 'Alpha idea', body: 'pitch' } });
    const b = await mk({ x: 500, y: 120, data: { title: 'Beta idea', body: '' } });
    return [a.id, b.id];
  }, canvasId);
}
// Opening a board eases the camera in over ~0.5s; measure cards after it.
async function reloadSettled(page) {
  await page.reload();
  await page.waitForSelector('#world .item');
  await page.waitForFunction(() => !document.getElementById('world').classList.contains('cam-animate'));
}
const item = (page, id) => page.evaluate((i) => fetch('/api/item/' + i).then(r => r.json()), id);

test('right-click sets a stage and the chip shows it', async ({ page }) => {
  const cid = await freshCanvas(page);
  const [a] = await seedNotes(page, cid);
  await reloadSettled(page);
  const card = page.locator(`.item[data-id="${a}"]`);
  await card.click({ button: 'right', position: { x: 30, y: 10 } });
  await page.click('#ctxmenu .ctx-stage[data-stage="design"]');
  await expect(card.locator('.stage-chip')).toHaveText('Design');
  await expect.poll(async () => (await item(page, a)).stage).toBe('design');
});

test('pipeline view: dragging a card to another column changes its stage', async ({ page }) => {
  const cid = await freshCanvas(page);
  const [a] = await seedNotes(page, cid);
  await page.evaluate((i) => fetch('/api/item/' + i, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"stage":"thought"}' }), a);
  await page.click('#pipelineBtn');
  const pc = page.locator(`.pl-col[data-stage="thought"] .pl-card[data-id="${a}"]`);
  await expect(pc).toBeVisible();
  const from = await pc.boundingBox();
  const to = await page.locator('.pl-col[data-stage="code"] .pl-body').boundingBox();
  await page.mouse.move(from.x + 20, from.y + 15);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(`.pl-col[data-stage="code"] .pl-card[data-id="${a}"]`)).toBeVisible();
  await expect.poll(async () => (await item(page, a)).stage).toBe('code');
});

test('a line can be made a dashed "depends on" arrow from its menu', async ({ page }) => {
  const cid = await freshCanvas(page);
  const [a, b] = await seedNotes(page, cid);
  const line = await page.evaluate(([cid, a, b]) => fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasId: cid, type: 'line', data: { fromId: a, toId: b } }) }).then(r => r.json()), [cid, a, b]);
  await reloadSettled(page);
  const vis = page.locator(`.cline[data-id="${line.id}"] .cvis`);
  await expect(vis).toHaveCount(1);
  const ra = await page.locator(`.item[data-id="${a}"]`).boundingBox();
  const rb = await page.locator(`.item[data-id="${b}"]`).boundingBox();
  await page.mouse.click((ra.x + ra.width + rb.x) / 2, (ra.y + ra.height / 2 + rb.y + rb.height / 2) / 2, { button: 'right' });
  await page.click('#ctxmenu [data-act="kind-depends"]');
  await expect(vis).toHaveAttribute('stroke-dasharray', '7 5');
  await expect.poll(async () => (await item(page, line.id)).data.kind).toBe('depends');
});

test('shift+drag on empty canvas box-selects cards that then move together', async ({ page }) => {
  const cid = await freshCanvas(page);
  const [a, b] = await seedNotes(page, cid);
  await reloadSettled(page);
  const ra = await page.locator(`.item[data-id="${a}"]`).boundingBox();
  const rb = await page.locator(`.item[data-id="${b}"]`).boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(ra.x - 30, ra.y - 30);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width + 30, Math.max(ra.y + ra.height, rb.y + rb.height) + 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.item.selected')).toHaveCount(2);
  await page.mouse.move(ra.x + 40, ra.y + 12);
  await page.mouse.down();
  await page.mouse.move(ra.x + 140, ra.y + 62, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => [(await item(page, a)).x, (await item(page, b)).x]).toEqual([200, 600]);
});
