'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startMarketplace } = require('../plugins/zsb-marketplace/index.js');
const { readCatalog, fetchPackage, CATALOG_URL } = require('../plugins/zsb-marketplace/catalog.js');
const catalog = require('../catalog.json');

const reports = catalog.plugins.find(plugin => plugin.id === 'daily-reports');
const zip = readFileSync(path.join(__dirname, '..', reports.download));
const version = '1.2.7-beta.1';

function makeFixture(t, options = {}) {
  const actions = new Map();
  let render;
  let importCount = 0;
  let installed = options.installed || [];
  const hub = {
    state: async () => ({ installed, allowUnverified: options.allowUnverified ?? true }),
    inspectZip: () => options.manifest || require('../plugins/daily-reports/plugin.json'),
    async importZip(data) {
      assert.deepEqual(data, zip);
      importCount++;
      installed = [{ id: reports.id, version: reports.version, bundled: false }];
      return { ok: true, started: true };
    },
  };
  const fetcher = async url => url === CATALOG_URL
    ? Response.json(catalog)
    : new Response(options.zip || zip);
  const cleanup = startMarketplace({
    id: 'zsb-marketplace',
    coreVersion: options.version || version,
    panel: {
      action: (name, fn) => actions.set(name, fn),
      tab(title, fn) {
        assert.equal(title, 'External Marketplace');
        render = fn;
      },
    },
  }, hub, options.fetcher || fetcher);
  t.after(cleanup);
  return { action: (name, ...args) => actions.get(name)(...args), render: () => render(), imports: () => importCount, cleanup };
}

test('lists GitHub ZIPs, imports the selected package once, and updates the listing', async t => {
  const fixture = makeFixture(t);
  await fixture.action('refresh');
  const picker = fixture.render().blocks.find(block => block.type === 'picker');
  assert.deepEqual(picker.items.map(item => item.id), ['daily-reports', 'terminal-opener', 'skillmap-presets', 'auto-grind', 'auto-forge',
    'auto-skin-collection', 'auto-trade-favourites', 'auto-sort-su', 'auction-sniper', 'farm-value', 'zsb-account-setup']);
  assert.match(JSON.stringify(fixture.render()), /Install Daily reports/);
  await fixture.action('select', 'not-in-catalog');
  const result = await fixture.action('install', reports.id);
  assert.match(result.message, /Daily reports 1\.0\.1 imported/);
  assert.equal(fixture.imports(), 1);
  assert.match(JSON.stringify(fixture.render()), /1\.0\.1 · Installed/);
  assert.equal((await fixture.action('install', reports.id)).ok, false);
  assert.equal(fixture.imports(), 1);
});

test('updates an older community install and preserves newer or bundled copies', async t => {
  const older = makeFixture(t, { installed: [{ id: reports.id, version: '1.0.0' }] });
  await older.action('refresh');
  assert.match(JSON.stringify(older.render()), /Update Daily reports/);
  await older.action('install', reports.id);
  assert.equal(older.imports(), 1);
  for (const local of [{ version: '1.1.0' }, { version: '1.0.1', bundled: true }]) {
    const fixture = makeFixture(t, { installed: [{ id: reports.id, ...local }] });
    await fixture.action('refresh');
    assert.equal((await fixture.action('install', reports.id)).ok, false);
    assert.equal(fixture.imports(), 0);
  }
});

test('discovers a marketplace self-update only on a manual check', async t => {
  const fixture = makeFixture(t, { installed: [{ id: 'zsb-marketplace', version: '1.0.0' }] });
  assert(!JSON.stringify(fixture.render()).includes('Updates available'));
  assert.equal(fixture.imports(), 0);
  await fixture.action('refresh');
  assert.match(JSON.stringify(fixture.render()), /Update ZSB Hub External Plugin Marketplace/);
  assert.equal(fixture.imports(), 0);
});

test('refuses unsigned imports when disabled, wrong manifests, bad hashes and incompatible Hub versions', async t => {
  for (const [options, problem] of [
    [{ allowUnverified: false }, /Allow unverified plugins/],
    [{ manifest: { id: 'different-plugin' } }, /disagrees.*id/],
    [{ zip: Buffer.from('altered') }, /checksum/],
    [{ version: '1.2.4' }, /cannot be installed/],
  ]) {
    const fixture = makeFixture(t, options);
    await fixture.action('refresh');
    assert.match((await fixture.action('install', reports.id)).error, problem);
    assert.equal(fixture.imports(), 0);
  }
});

test('serializes imports and aborts a pending download when the plugin stops', async t => {
  let downloading;
  const started = new Promise(resolve => { downloading = resolve; });
  const fixture = makeFixture(t, {
    fetcher: async (url, { signal }) => {
      if (url === CATALOG_URL) return Response.json(catalog);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        downloading();
      });
    },
  });
  await fixture.action('refresh');
  const first = fixture.action('install', reports.id);
  await started;
  assert.match((await fixture.action('install', reports.id)).error, /current marketplace action/);
  fixture.cleanup();
  assert.equal((await first).ok, false);
  assert.equal(fixture.imports(), 0);
});

test('rejects conflicting listings, auto-start packages and unsupported download URLs', () => {
  assert.throws(() => readCatalog({ ...catalog, plugins: [reports, reports] }), /duplicate/);
  assert.throws(() => readCatalog({ ...catalog, plugins: [{ ...reports, defaultEnabled: true }] }), /defaultEnabled/);
  assert.throws(() => readCatalog({ ...catalog, plugins: [{ ...reports, download: 'https://example.com/plugin.zip' }] }), /versioned GitHub Release/);
});

test('allows GitHub release asset redirects and refuses redirects outside GitHub', async () => {
  const release = 'https://github.com/example/example/releases/download/v1.0.0/package.zip';
  const allowed = 'https://release-assets.githubusercontent.com/path';
  const entry = { ...reports, download: release, sha256: createHash('sha256').update(zip).digest('hex') };
  const calls = [];
  const good = async url => {
    calls.push(url);
    return url === release ? Response.redirect(allowed, 302) : new Response(zip);
  };
  assert.deepEqual(await fetchPackage(entry, good), zip);
  assert.deepEqual(calls, [release, allowed]);
  await assert.rejects(fetchPackage(entry, async () => Response.redirect('https://example.com/package.zip', 302)),
    /Unexpected GitHub release download redirect/);
});
