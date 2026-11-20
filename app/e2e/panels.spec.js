'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas, place } = require('./helpers');

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);
const getItems = async (page, id) => (await api(page, 'GET', '/api/canvas/' + id)).items;

// Opening a board runs a short camera animation; wait it out before measuring
// anything or dragging, or positions shift under the mouse.
async function settle(page) { await page.reload(); await expect(page.locator('#stage')).toBeVisible(); await page.waitForTimeout(1000); }

async function mkPanel(page, canvasId, data = {}, geo = {}) {
  const p = await api(page, 'POST', '/api/item', { canvasId, type: 'panel', x: 100, y: 100, w: 500, h: 360, data: { title: 'Plan' }, ...geo, ...(data.color ? { color: data.color } : {}) });
  await settle(page);
  return p;
}

test('the Panel tool places a named panel behind other cards', async ({ page }) => {
  const id = await freshCanvas(page);
  await place(page, 'panel', 700, 300);
  const panel = page.locator('.item.panel');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('.panel-count')).toHaveText('0 items');
  await page.keyboard.type('Research');
  await expect.poll(async () => (await getItems(page, id))[0].data.title).toBe('Research');
  expect(await panel.evaluate(e => e.style.zIndex)).toBe('0');
});

test('a card dropped inside a panel is logged as a member; leaving removes it', async ({ page }) => {
  const id = await freshCanvas(page);
  const panel = await mkPanel(page, id, { title: 'Plan' });
  const note = await api(page, 'POST', '/api/item', { canvasId: id, type: 'note', x: 900, y: 120, data: { title: 'Idea' } });
  await settle(page);
  await expect(page.locator('.item.panel .panel-count')).toHaveText('0 items');

  const el = page.locator(`.item[data-id="${note.id}"]`);
  const box = await el.boundingBox();
  const pbox = await page.locator('.item.panel').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(pbox.x + 100, pbox.y + 90, { steps: 6 });
  await expect(page.locator('.item.panel')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(page.locator('.item.panel .panel-count')).toHaveText('1 item');
  await expect.poll(async () => (await getItems(page, id)).find(i => i.id === note.id)._panelId).toBe(panel.id);
  await expect(el).toHaveAttribute('data-panel', 'Plan');

  // drag it back out
  const b2 = await el.boundingBox();
  await page.mouse.move(b2.x + 20, b2.y + 12);
  await page.mouse.down();
  await page.mouse.move(b2.x + 700, b2.y + 12, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.item.panel .panel-count')).toHaveText('0 items');
  await expect.poll(async () => (await getItems(page, id)).find(i => i.id === note.id)._panelId).toBeUndefined();
});

test('dragging a panel by its header carries its cards and survives reload', async ({ page }) => {
  const id = await freshCanvas(page);
  const panel = await mkPanel(page, id);
  const note = await api(page, 'POST', '/api/item', { canvasId: id, type: 'note', x: 140, y: 170, data: { title: 'Inside' } });
  await settle(page);
  await expect(page.locator('.item.panel .panel-count')).toHaveText('1 item');
  const head = await page.locator('.item.panel .panel-head').boundingBox();
  await page.mouse.move(head.x + head.width - 90, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + head.width - 90 + 200, head.y + 20 + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await getItems(page, id)).find(i => i.id === panel.id).x).toBe(300);
  const items = await getItems(page, id);
  expect(items.find(i => i.id === note.id).x).toBe(340);
  expect(items.find(i => i.id === note.id).y).toBe(250);
  await page.reload();
  await expect(page.locator('.item.panel .panel-count')).toHaveText('1 item');
});

test('the corner handle resizes a panel to any width and height', async ({ page }) => {
  const id = await freshCanvas(page);
  const panel = await mkPanel(page, id);
  const h = await page.locator('.panel-resize').boundingBox();
  await page.mouse.move(h.x + 6, h.y + 6);
  await page.mouse.down();
  await page.mouse.move(h.x + 306, h.y - 94, { steps: 6 }); // wider, shorter
  await page.mouse.up();
  await expect.poll(async () => (await getItems(page, id)).find(i => i.id === panel.id).w).toBe(800);
  expect((await getItems(page, id)).find(i => i.id === panel.id).h).toBe(260);
});

test('the shape button cycles rect / rounded / ellipse; empty body is click-through', async ({ page }) => {
  const id = await freshCanvas(page);
  const panel = await mkPanel(page, id);
  await expect(page.locator('.item.panel')).toHaveClass(/shape-rounded/);
  await page.click('.panel-shape-btn');
  await expect(page.locator('.item.panel')).toHaveClass(/shape-ellipse/);
  await expect.poll(async () => (await getItems(page, id)).find(i => i.id === panel.id).data.shape).toBe('ellipse');
  // body click-through: clicking inside the panel (below the header) hits the stage, not the panel
  const hit = await page.evaluate(() => { const r = document.querySelector('.item.panel').getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('.item.panel'); });
  expect(hit).toBe(false);
});

test('deleting a panel keeps the cards that were inside it', async ({ page }) => {
  const id = await freshCanvas(page);
  const panel = await mkPanel(page, id);
  const note = await api(page, 'POST', '/api/item', { canvasId: id, type: 'note', x: 140, y: 170, data: { title: 'Keep me' } });
  await settle(page);
  await page.locator('.item.panel .panel-head').click({ position: { x: 20, y: 20 } });
  await page.locator('.item.panel .card-tools button[title="Delete"]').click();
  await expect(page.locator('.item.panel')).toHaveCount(0);
  await expect(page.locator(`.item[data-id="${note.id}"]`)).toHaveCount(1);
});
