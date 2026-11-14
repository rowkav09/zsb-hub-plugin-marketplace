import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const { plugins } = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));

test.beforeEach(async ({ page }) => {
  const origin = new URL(test.info().project.use.baseURL).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.abort());
});

test('combines search with category filters and resets empty results', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('.plugin-card:visible');
  const search = page.getByRole('searchbox', { name: 'Search plugins' });
  await expect(cards).toHaveCount(plugins.length);
  await page.getByRole('button', { name: 'Rewards', exact: true }).click();
  await expect(cards).toHaveCount(plugins.filter(plugin => plugin.category === 'Rewards').length);
  await search.fill('monthly pass');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Monthly pass');

  await search.fill('no-such-plugin');
  await expect(page.getByRole('heading', { name: 'No matching plugins' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('0 plugins');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'All plugins' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(plugins.length);
});

test('serves the expected Account Pulse ZIP from its listing', async ({ page }) => {
  const plugin = plugins.find(entry => entry.id === 'account-pulse');
  await page.goto('/');
  await page.getByRole('link', { name: 'Details for Account Pulse' }).click();
  await expect(page.getByRole('heading', { name: 'Account Pulse', exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download ZIP' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(plugin.download.split('/').at(-1));
  const bytes = await readFile(await download.path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(plugin.sha256);
  await page.getByRole('link', { name: 'Source & documentation' }).click();
  await expect(page.getByRole('link', { name: 'JavaScript source' })).toBeVisible();
});

test('serves linked pages and assets without layout overflow or script errors', async ({ page, request, baseURL }) => {
  const seen = new Set();
  const queue = [new URL('index.html', baseURL)];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  for (const url of queue) {
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const response = await request.get(url.href);
    expect(response.ok(), url.href).toBe(true);
    if (!response.headers()['content-type']?.includes('text/html')) continue;
    await page.goto(url.href);
    await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), url.href).toBe(true);
    const targets = await page.locator('a[href], link[rel=stylesheet], script[src]')
      .evaluateAll(elements => elements.map(element => element.href || element.src));
    for (const target of targets) {
      const linked = new URL(target);
      if (linked.origin !== url.origin) continue;
      if (linked.hash && linked.pathname === url.pathname) {
        await expect(page.locator(linked.hash), target).toHaveCount(1);
      }
      linked.hash = '';
      if (!seen.has(linked.href)) queue.push(linked);
    }
  }

  for (const plugin of plugins) {
    expect(seen.has(new URL(`catalog/${plugin.id}.html`, baseURL).href)).toBe(true);
  }
  expect(errors).toEqual([]);
});
