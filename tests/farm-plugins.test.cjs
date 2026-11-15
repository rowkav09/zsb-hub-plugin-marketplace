'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const forge = require('../plugins/auto-forge');
const skills = require('../plugins/skillmap-presets');
const { MAPS, parseMap, purchasePlan } = require('../plugins/skillmap-presets/planning');

function farm(plugin, manifest, overrides, respond) {
  const accounts = [{ id: 'first', name: 'First', healthy: true }, { id: 'second', name: 'Second', healthy: true }];
  const settings = { ...Object.fromEntries(Object.entries(manifest.settings).map(([key, schema]) => [key, schema.default])), ...overrides };
  const requests = [];
  const actions = new Map();
  const locks = new Map();
  const busy = new Set();
  let render;
  let onChange;
  let saved = {};
  const routes = {
    routes: [{ id: 'tunnel-a', group: 'ip:203.0.113.10' }, { id: 'tunnel-b', group: 'ip:203.0.113.20' }],
    accounts: accounts.map(account => ({ id: account.id, route: 'tunnel-a' })),
  };
  plugin.start({
    accounts: {
      list: () => accounts,
      get: id => accounts.find(account => account.id === id),
      busy: id => busy.has(id),
      wanted: () => false,
      setBusy: (id, reason) => reason ? locks.set(id, reason) : locks.delete(id),
    },
    network: { state: () => routes },
    data: { get: () => saved, set: state => { saved = structuredClone(state); } },
    settings: {
      get: key => settings[key],
      runsOn: (_key, id) => !settings.only || settings.only.includes(id),
      onChange: fn => { onChange = fn; },
      set(key, value) { settings[key] = value; onChange(key); return { ok: true }; },
    },
    panel: {
      action: (name, fn) => actions.set(name, fn),
      tab: (_title, fn) => { render = fn; },
    },
    request(id, path, opts) {
      requests.push({ id, path, ...opts });
      if (opts.method === 'POST') assert(locks.has(id), 'mutations should hold the account');
      return respond(id, path, opts);
    },
    log() {},
  });
  return {
    busy, locks, routes,
    data: () => saved,
    action: (name, arg) => actions.get(name)(arg),
    button: name => render().blocks.filter(block => block.type === 'buttons').flatMap(block => block.items).find(button => button.action === name),
    preview: () => render().blocks.find(block => ['forge-preview', 'skill-preview'].includes(block.id)).blocks[0].rows,
    posts: () => requests.filter(request => request.method === 'POST'),
    change(key, value) { settings[key] = value; onChange(key); },
  };
}

const forgeManifest = require('../plugins/auto-forge/plugin.json');
const skin = (_id, price, extra) => ({ _id, price, name: _id, quality: 0, isFavorite: false, hasPattern: true, statTrak: false, ...extra });
const inventory = skins => ({ kind: 'ok', json: { skins, pages: 1 } });
const forgeDefaults = { maxPrice: 10, delay: 0 };

test('Auto Forge caps the preview, invalidates approval on picker changes, and rechecks eligibility', async () => {
  const inventories = {
    first: [skin('favourite', 0, { isFavorite: true }), skin('unknown', 0, { isFavorite: undefined }),
      skin('over cap', 11), skin('StatTrak', 0, { statTrak: true }), skin('a', 1), skin('b', 2)],
    second: [skin('c', 3), skin('d', 4)],
  };
  const f = farm(forge, forgeManifest, { ...forgeDefaults, batchLimit: 3, perAccount: 2 }, (id, pathname, opts) => {
    if (opts.method === 'POST') return { kind: 'ok', json: { message: 'Reforge successful.' } };
    assert.match(pathname, /^\/api\/inventory\?/);
    return inventory(inventories[id]);
  });
  await f.action('scan');
  assert.deepEqual(f.preview().map(row => row[1]), ['a', 'b', 'c']);
  assert.equal(f.posts().length, 0);
  const broadToken = f.button('forge').arg;
  assert.equal(f.action('pick', 'b').ok, true);
  assert.deepEqual(f.preview().map(row => row[1]), ['b']);
  assert.equal((await f.action('forge', broadToken)).ok, false);
  assert.equal(f.action('pick', 'b').ok, true);
  inventories.first = [skin('a', 1, { isFavorite: true }), skin('b', 2), skin('new', 0)];

  const token = f.button('forge').arg;
  assert.match((await f.action('forge', token)).message, /2 successful/);
  assert.deepEqual(f.posts().map(req => [req.id, req.body, req.tries]), [
    ['first', { skinId: 'b' }, 1],
    ['second', { skinId: 'c' }, 1],
  ]);
  assert.equal((await f.action('forge', token)).ok, false);
  assert.equal(f.locks.size, 0);
  assert.equal(f.data().today.ok, 2);
});

test('Auto Forge rechecks the upgraded skin and caps every stage of a Legendary chain', async () => {
  let stock = [skin('one', 1, { name: 'Picked' }), skin('two', 2, { name: 'Other' })];
  const f = farm(forge, forgeManifest, { ...forgeDefaults, target: 'all', perAccount: 2, only: ['first'] }, (_, path, opts) => {
    if (opts.method === 'POST') {
      const previous = stock.find(item => item._id === opts.body.skinId);
      assert(previous);
      const next = { ...previous, _id: previous._id + 'u', quality: previous.quality + 1, price: previous.price + 1 };
      stock = [...stock.filter(item => item !== previous), next];
      return { kind: 'ok', json: { message: 'Reforge successful.', skin: next } };
    }
    const quality = Number(new URL(path, 'https://test.invalid').searchParams.get('quality'));
    return inventory(stock.filter(item => item.quality === quality));
  });
  await f.action('scan');
  assert.deepEqual(f.preview(), [['First', 'Picked', 'Common', '$1', 2]]);
  assert.match((await f.action('forge', f.button('forge').arg)).message, /^2 attempted/);
  assert.deepEqual(f.posts().map(req => req.body.skinId), ['one', 'oneu']);
});

test('Auto Forge stops a chain if the upgraded skin exceeds the price cap', async () => {
  const upgraded = skin('one-up', 11, { name: 'Picked', quality: 1 });
  let upgradedOnce = false;
  const f = farm(forge, forgeManifest, { ...forgeDefaults, target: 'all', only: ['first'] }, (_, path, opts) => {
    if (opts.method === 'POST') {
      assert.equal(upgradedOnce, false);
      upgradedOnce = true;
      return { kind: 'ok', json: { message: 'Reforge successful.', skin: upgraded } };
    }
    const quality = Number(new URL(path, 'https://test.invalid').searchParams.get('quality'));
    if (quality === 0) return inventory(upgradedOnce ? [] : [skin('one', 1, { name: 'Picked' })]);
    return inventory(quality === 1 && upgradedOnce ? [upgraded] : []);
  });
  await f.action('scan');
  assert.match((await f.action('forge', f.button('forge').arg)).message, /^1 attempted.*1 skipped/);
  assert.deepEqual(f.posts().map(req => req.body.skinId), ['one']);
});

test('Auto Forge blocks concurrent lanes on the same IP and halts on an unconfirmed result', async () => {
  let began;
  let finish;
  const outbound = new Promise(resolve => { began = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const f = farm(forge, forgeManifest, forgeDefaults, (id, _, opts) => {
    if (opts.method !== 'POST') return inventory([skin(id + '-first', 1), skin(id + '-second', 2)]);
    began();
    return response;
  });
  await f.action('scan');
  const running = f.action('forge', f.button('forge').arg);
  await outbound;
  assert.deepEqual(f.posts().map(req => req.id), ['first']);
  assert.equal(f.locks.size, 1);
  finish({ kind: 'timeout' });
  assert.match((await running).message, /1 unconfirmed.*Batch stopped/);
  assert.equal(f.posts().length, 1);
  assert.equal(f.locks.size, 0);
  assert.equal(f.data().today.unconfirmed, 1);
  assert.equal(f.data().pending, true);
  await f.action('scan');
  assert.equal(f.button('forge'), undefined);
  assert.equal(f.action('review').ok, true);
  assert.equal(f.data().pending, false);
  assert.equal(f.button('forge'), undefined);
});

test('Auto Forge skips an account whose Hub route changed after the preview', async () => {
  const f = farm(forge, forgeManifest, { ...forgeDefaults, only: ['first'] }, (_, path, opts) => {
    assert.equal(opts.method, undefined);
    return inventory([skin('one', 1)]);
  });
  await f.action('scan');
  f.routes.accounts[0].route = 'tunnel-b';
  assert.match((await f.action('forge', f.button('forge').arg)).message, /^0 attempted.*1 skipped/);
  assert.equal(f.posts().length, 0);
});

const skillManifest = require('../plugins/skillmap-presets/plugin.json');
const node = (id, requiredPrevSkillId, cost) => ({ id, requiredPrevSkillId, cost, name: id });
const tree = [node('a1', null, 3), node('a2', 'a1', 5), node('a3', 'a2', 2), node('a4', null, 30)];
const profile = { money: 30, skillPoints: 4, rank: { id: 5 } };
const map = (owned, options = {}) => ({
  kind: 'ok',
  body: '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({
    props: { pageProps: {
      skillmap: JSON.stringify({ requiredRankId: 2, skills: tree, ...options }),
      skillIds: JSON.stringify([...owned]),
    } },
  }) + '</script>',
});

test('Skillmap Presets fits whole prerequisite chains within the account budget and rank', () => {
  const rules = { maxSpend: 30, cashReserve: 20, maxPoints: 3, fit: true };
  const state = { ...parseMap(map([]).body, MAPS.a), account: profile };
  const plan = purchasePlan(['a4', 'a3'], state, rules);
  assert.deepEqual(plan.steps.map(skill => skill.id), ['a1', 'a2', 'a3']);
  assert.equal(plan.total, 10);
  assert.equal(plan.complete, false);
  assert.deepEqual(purchasePlan(['a4', 'a3'], state, { ...rules, fit: false }).steps, []);
  assert.deepEqual(purchasePlan(['a3'], { ...state, account: { ...profile, rank: { id: 1 } } }, rules).steps, []);
  const cyclic = parseMap(map([], { skills: [node('a1', 'a2', 3), node('a2', 'a1', 3)] }).body, MAPS.a);
  assert.throws(() => purchasePlan(['a1'], { ...cyclic, account: profile }, rules), /cyclic prerequisite/);
  assert.throws(() => parseMap('<html>Not a skillmap</html>', MAPS.a), /data unavailable/);
});

test('Skillmap Presets previews busy accounts and only buys missing approved skills on available accounts', async () => {
  const owned = new Set();
  const f = farm(skills, skillManifest, { preset: 'custom', customIds: 'a2, a3', cashReserve: 20 }, (_, path, opts) => {
    if (path === '/api/me') return { kind: 'ok', json: profile };
    if (path === '/skillmaps/de_dust_2') return map(owned);
    assert.equal(path, '/api/skill');
    assert.equal(opts.body.mapName, 'Dust II');
    owned.add(opts.body.skillId);
    return { kind: 'ok', status: 200 };
  });
  f.busy.add('second');
  await f.action('preview');
  assert.deepEqual(f.preview().map(row => row[2]), ['a1 (a1)', 'a2 (a2)', 'a3 (a3)', 'a1 (a1)', 'a2 (a2)', 'a3 (a3)']);
  assert.equal(f.posts().length, 0);
  const token = f.button('apply').arg;
  owned.add('a1');
  assert.match((await f.action('apply', token)).message, /2 confirmed purchase/);
  assert.deepEqual(f.posts().map(req => [req.id, req.body.skillId, req.tries]), [['first', 'a2', 1], ['first', 'a3', 1]]);
  assert.equal(f.locks.size, 0);
  assert.equal((await f.action('apply', token)).ok, false);
});

test('Skillmap Presets rejects a price increase and halts an unconfirmed purchase', async () => {
  let priceChanged = false;
  const f = farm(skills, skillManifest, { preset: 'custom', customIds: 'a2' }, (id, path) => {
    if (path === '/api/me') return { kind: 'ok', json: profile };
    if (path === '/skillmaps/de_dust_2') return map([], priceChanged ? { skills: [node('a1', null, 20), tree[1]] } : {});
    assert.equal(path, '/api/skill');
    assert.equal(id, 'first');
    return { kind: 'timeout' };
  });
  await f.action('preview');
  priceChanged = true;
  await f.action('apply', f.button('apply').arg);
  assert.equal(f.posts().length, 0);
  priceChanged = false;
  await f.action('preview');
  assert.match((await f.action('apply', f.button('apply').arg)).message, /1 unconfirmed/);
  assert.deepEqual(f.posts().map(req => req.body.skillId), ['a1']);
  assert.equal(f.locks.size, 0);
});
