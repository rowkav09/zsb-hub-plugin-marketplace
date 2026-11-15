'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const forge = require('../plugins/forge-queue');
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
  plugin.start({
    accounts: {
      list: () => accounts,
      get: id => accounts.find(account => account.id === id),
      busy: id => busy.has(id),
      wanted: () => false,
      setBusy: (id, reason) => reason ? locks.set(id, reason) : locks.delete(id),
    },
    settings: {
      get: key => settings[key],
      runsOn: (_key, id) => !settings.only || settings.only.includes(id),
      onChange: fn => { onChange = fn; },
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
    busy, locks,
    action: (name, arg) => actions.get(name)(arg),
    button: name => render().blocks.filter(block => block.type === 'buttons').flatMap(block => block.items).find(button => button.action === name),
    preview: () => render().blocks.find(block => block.type === 'card').blocks[0].rows,
    posts: () => requests.filter(request => request.method === 'POST'),
    change(key, value) { settings[key] = value; onChange(); },
  };
}

const forgeManifest = require('../plugins/forge-queue/plugin.json');
const skin = (_id, price, extra) => ({ _id, price, name: _id, quality: 0, isFavorite: false, hasPattern: true, statTrak: false, ...extra });
const inventory = skins => ({ kind: 'ok', json: { skins, pages: 1 } });

test('Forge Queue previews capped selections across accounts and refreshes the approved items', async () => {
  const inventories = {
    first: [skin('favourite', 0, { isFavorite: true }), skin('unknown', 0, { isFavorite: undefined }),
      skin('over cap', 11), skin('StatTrak', 0, { statTrak: true }), skin('a', 1), skin('b', 2)],
    second: [skin('c', 3), skin('d', 4)],
  };
  const f = farm(forge, forgeManifest, { maxPrice: 10, batchLimit: 3, perAccount: 2 }, (id, pathname, opts) => {
    if (opts.method === 'POST') return { kind: 'ok', json: { message: 'Reforge successful.' } };
    assert.match(pathname, /^\/api\/inventory\?/);
    return inventory(inventories[id]);
  });
  await f.action('scan');
  assert.deepEqual(f.preview().map(row => row[1]), ['a', 'b', 'c']);
  assert.equal(f.posts().length, 0);

  inventories.first = [skin('a', 1, { isFavorite: true }), skin('b', 2), skin('new', 0)];
  const token = f.button('forge').arg;
  assert.equal((await f.action('forge', 'wrong-token')).ok, false);
  assert.match((await f.action('forge', token)).message, /2 forged/);
  assert.deepEqual(f.posts().map(req => [req.id, req.body, req.tries]), [
    ['first', { skinId: 'b' }, 1],
    ['second', { skinId: 'c' }, 1],
  ]);
  assert.equal((await f.action('forge', token)).ok, false);
  assert.equal(f.locks.size, 0);
});

test('Forge Queue invalidates previews on settings changes and halts on unknown results', async () => {
  const f = farm(forge, forgeManifest, { maxPrice: 10 }, (id, _, opts) =>
    opts.method === 'POST' ? { kind: 'timeout' } : inventory([skin(id, 1)]));
  await f.action('scan');
  const token = f.button('forge').arg;
  f.change('perAccount', 1);
  assert.equal((await f.action('forge', token)).ok, false);
  assert.equal(f.posts().length, 0);
  await f.action('scan');
  assert.match((await f.action('forge', f.button('forge').arg)).message, /1 unconfirmed/);
  assert.deepEqual(f.posts().map(req => req.id), ['first']);
  assert.equal(f.locks.size, 0);
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

test('Skillmap Presets skips busy accounts and only buys missing approved skills', async () => {
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
  assert.deepEqual(f.preview().map(row => row[2]), ['a1 (a1)', 'a2 (a2)', 'a3 (a3)']);
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
