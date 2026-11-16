'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, cpSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const oid = character => character.repeat(24);
const skin = (id, name, extra) => ({ _id: oid(id), name, price: 5, isFavorite: false, ...extra });
const ok = json => ({ kind: 'ok', json });
const inventory = skins => ok({ skins, pages: 1 });

function hub(t, id, options, transport) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zsb-inventory-fixture-'));
  cpSync(path.join(root, 'plugins', id), dir, { recursive: true });
  cpSync(path.join(root, 'shared/farm-batch.js'), path.join(dir, 'farm-batch.js'));
  const plugin = require(path.join(dir, 'index.js'));
  const { settings } = require(path.join(dir, 'plugin.json'));
  const accounts = (options.accountIds || ['a']).map(id => ({ id, name: id.toUpperCase(), healthy: true }));
  const values = { runMode: 'live', on: false, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.default])),
    ...(options.collections ? { targets: 'named' } : {}), ...options };
  const actions = new Map(), locks = new Set(), posts = [];
  const requests = new Map();
  let draw, onChange, callback, data = {};
  const routes = new Map(accounts.map(a => [a.id, 'route-' + a.id]));
  const ctx = {
    accounts: {
      list: () => accounts,
      get: id => accounts.find(a => a.id === id),
      busy: id => options.busy?.get(id) || null,
      wanted: id => options.wanted?.get(id) || null,
      want: (id, label) => label ? requests.set(id, label) : requests.delete(id),
      setBusy: (id, label) => label ? locks.add(id) : locks.delete(id),
    },
    network: { state: () => ({ accounts: accounts.map(a => ({ id: a.id, route: routes.get(a.id) })) }) },
    data: { get: () => data, set: value => { data = { ...value }; } },
    settings: {
      get: key => values[key],
      runsOn: (key, id) => key === 'accounts' && (options.senders || accounts.map(a => a.id)).includes(id),
      set(key, value) { values[key] = value; onChange(key); return { ok: true }; },
      onChange: fn => { onChange = fn; },
    },
    power: { practice: () => values.runMode !== 'live', live: () => values.runMode === 'live' && values.on },
    panel: { action: (name, fn) => actions.set(name, fn), tab: (_, render) => { draw = render; } },
    every: (_, fn) => { callback = fn; },
    on() {},
    sleep: () => new Promise(() => {}),
    log() {},
    socket: options.socket,
    request(acct, url, opts) {
      if (opts.method && opts.method !== 'GET') {
        assert(locks.has(acct), 'writes hold the account');
        assert.equal(opts.tries, 1);
        posts.push({ acct, url, method: opts.method, body: opts.body });
      }
      return transport(acct, new URL(url, 'https://test.invalid'), opts);
    },
  };
  plugin.start(ctx);
  if (id === 'auto-skin-collection') actions.get('show-collection-run')();
  t.after(() => { plugin.stop(); rmSync(dir, { force: true, recursive: true }); });
  const action = (name, args) => actions.get(name)(args);
  return {
    action, posts, locks, routes, requests, callback, change: ctx.settings.set, data: () => data, blocks: () => draw().blocks,
    preview: () => draw().blocks.find(block => block.type === 'table')?.rows,
    approval: () => draw().blocks.filter(b => b.type === 'buttons').flatMap(b => b.items).find(b => b.action === 'apply'),
  };
}

test('Storage sorter honours priority and per-account rules and verifies moves', async t => {
  const rankedFade = skin('a', 'Fixture Fade', { floatRanks: { lowestFloatBySkingroupRank: 1 } });
  const stock = { a: [rankedFade], b: [rankedFade] };
  const units = [{ _id: oid('c'), name: 'Fade', skinCount: 0 }, { _id: oid('d'), name: '#1', skinCount: 0 }];
  const stored = new Map();
  const f = hub(t, 'auto-sort-su', {
    accountIds: ['a', 'b'], rules: [
      { account: 'a', priority: 1, kind: 'rank1', unit: '#1' },
      { account: '', priority: 2, kind: 'fade', unit: 'Fade' },
    ],
  }, (acct, url, opts) => {
    if (url.pathname.endsWith('/skin/rank')) return ok({ floatRanks: rankedFade.floatRanks });
    if (url.pathname === '/api/patternNames') return ok(['100% Fade']);
    if (url.pathname === '/api/inventory') {
      assert(url.searchParams.has('patterns') || url.searchParams.has('filterFloatRanks'));
      return inventory(stock[acct]);
    }
    if (url.pathname.endsWith('/storageUnits')) return ok(units);
    if (opts.method === 'POST') {
      stored.set(acct + opts.body.storageUnitId, stock[acct]);
      stock[acct] = [];
      return ok(null);
    }
    return inventory(stored.get(acct + url.searchParams.get('id')) || []);
  });
  assert.equal((await f.action('preview')).ok, true);
  assert.deepEqual(f.preview(), [['A', 'Fixture Fade', '#1', 1], ['B', 'Fixture Fade', 'Fade', 2]]);
  assert.equal(f.posts.length, 0);
  const result = await f.action('apply', f.approval().arg);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.posts.map(entry => [entry.acct, entry.body.storageUnitId]), [['a', oid('d')], ['b', oid('c')]]);
  assert.equal(f.locks.size, 0);
});

test('Unconfirmed storage deposits stop the batch and require acknowledgement', async t => {
  const f = hub(t, 'auto-sort-su', { rules: [{ kind: 'name', match: 'Fixture', unit: 'Keep' }], on: true }, (_, url, opts) => {
    if (url.pathname.endsWith('storageUnits')) return ok([{ _id: oid('f'), name: 'Keep', skinCount: 0 }]);
    if (opts.method === 'POST') return { kind: 'timeout' };
    return inventory([skin('a', 'Fixture One'), skin('b', 'Fixture Two')]);
  });
  await f.action('preview');
  assert.equal((await f.action('apply', f.approval().arg)).ok, false);
  assert.deepEqual(f.posts.map(post => post.body.skinIds), [[oid('a')]]);
  assert.equal(f.data().needsReview, true);
  assert.equal(f.locks.size, 0);
  await f.action('preview');
  assert.equal(f.approval(), undefined);
  assert.equal(f.action('review').ok, true);
});

test('Collection completer submits approved skin groups and claims a verified reward', async t => {
  const name = 'Fixture Case', first = { _id: oid('a'), name: 'First skin' }, second = { _id: oid('b'), name: 'Second skin' };
  const collection = { submittedSkingroupIds: [], redeemedCollectionRewards: [] };
  const f = hub(t, 'auto-skin-collection', {
    collections: [name], maxSkin: 20, runMode: 'practice', on: true, submissions: 1,
  }, (_, url, opts) => {
    if (url.searchParams.get('all') === 'true') return ok({ skinCollections: [{ name }] });
    if (opts.method === 'POST') {
      collection.submittedSkingroupIds.push(opts.body.id);
      return ok(null);
    }
    if (opts.method === 'PATCH') {
      collection.redeemedCollectionRewards.push(opts.body.collectionName);
      return ok(null);
    }
    if (url.pathname === '/api/skinCollection') return ok({ skinCollectionSkingroups: [first, second], userSkinCollection: collection });
    const groupId = url.searchParams.get('skingroupId');
    return inventory(groupId === first._id
      ? [skin('d', 'First skin', { skingroupId: first._id }), skin('e', 'First skin', { skingroupId: first._id, price: 6 })]
      : [skin('f', 'Second skin')]);
  });
  await f.action('preview');
  assert.deepEqual(f.preview().map(row => row[2]), [
    'Submit First skin · site chooses 1 of 2', 'Submit Second skin · site chooses 1 of 1', 'Claim completed reward',
  ]);
  assert.equal(f.posts.length, 0);
  assert.equal((await f.action('apply', f.approval().arg)).ok, true);
  assert.deepEqual(f.posts.map(post => post.body), [{ id: first._id, collection: name }, { id: second._id, collection: name }, { collectionName: name }]);
  assert.equal(f.callback, undefined, 'legacy scheduled settings cannot run the completer');
  assert.equal(f.approval(), undefined, 'the completed preview cannot run again');
});

test('Collection scans include favourited duplicates on later pages and recheck before submitting', async t => {
  const name = 'Fixture Case';
  const blocked = { _id: oid('a'), name: 'Protected skin' };
  const changed = { _id: oid('b'), name: 'Changed skin' };
  const unmarked = { _id: oid('c'), name: 'Unknown favourite state' };
  let toggled = false;
  const f = hub(t, 'auto-skin-collection', { collections: [name], maxSkin: 20 }, (_, url) => {
    if (url.searchParams.has('all')) return ok({ skinCollections: [{ name }] });
    if (url.pathname === '/api/skinCollection') return ok({ skinCollectionSkingroups: [blocked, changed, unmarked], userSkinCollection: null });
    assert(!url.searchParams.has('favoriteSkinsFilter'), 'a group scan must see every copy');
    switch (url.searchParams.get('skingroupId')) {
      case blocked._id:
        return ok({ pages: 2, skins: url.searchParams.get('page') === '1'
          ? [skin('d', blocked.name)] : [skin('e', blocked.name, { isFavorite: true })] });
      case changed._id: return inventory([skin('f', changed.name, { isFavorite: toggled })]);
      case unmarked._id: return inventory([skin('1', unmarked.name, { isFavorite: undefined })]);
      default: assert.fail('Unexpected group ' + url.searchParams.get('skingroupId'));
    }
  });
  assert.equal((await f.action('preview')).ok, true);
  assert.deepEqual(f.preview().map(row => row[2]), ['Submit Changed skin · site chooses 1 of 1']);
  toggled = true;
  assert.equal((await f.action('apply', f.approval().arg)).ok, true);
  assert.equal(f.posts.length, 0);
});

test('Collection preview reads a busy account and an approved run waits through a long Armory turn', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const name = 'Fixture Case', group = { _id: oid('a'), name: 'Missing skin' };
  const busy = new Map([['a', { plugin: 'armory', what: 'star farming' }]]);
  const wanted = new Map();
  const state = { submittedSkingroupIds: [], redeemedCollectionRewards: [] };
  const f = hub(t, 'auto-skin-collection', { collections: [name], maxSkin: 10, redeem: false, busy, wanted }, (_, url, opts) => {
    if (url.pathname === '/api/inventory') return inventory([skin('d', group.name)]);
    if (url.searchParams.has('all')) return ok({ skinCollections: [{ name }] });
    if (opts.method === 'POST') {
      assert.equal(busy.size, 0);
      assert.equal(f.requests.size, 0, 'own busy mark replaces the handoff request');
      state.submittedSkingroupIds.push(opts.body.id);
    }
    return ok({ skinCollectionSkingroups: [group], userSkinCollection: state });
  });
  assert.equal((await f.action('preview')).ok, true);
  const run = f.action('apply', f.approval().arg);
  assert.equal(f.requests.get('a'), 'Collection Completer');
  assert.match(JSON.stringify(f.blocks()), /Waiting for account · star farming/);
  assert.equal(f.posts.length, 0);
  wanted.set('a', { plugin: 'trader', what: 'later request' });
  t.mock.timers.tick(20 * 60_000);
  await Promise.resolve();
  assert.equal(f.requests.get('a'), 'Collection Completer', 'the handoff stays queued through a full Armory turn');
  assert.equal(f.posts.length, 0);
  busy.clear();
  t.mock.timers.tick(500);
  assert.match((await run).message, /1 of 1 jobs processed/);
  assert.deepEqual(f.posts.map(post => post.body.id), [group._id]);
  assert.equal(f.requests.size, 0);
  assert.equal(f.locks.size, 0);
});

test('Stopping a queued Collection Completer run clears its request without writing', async t => {
  const name = 'Fixture Case', group = { _id: oid('a'), name: 'Missing skin' };
  const busy = new Map([['a', { plugin: 'armory', what: 'star farming' }]]);
  const f = hub(t, 'auto-skin-collection', { collections: [name], maxSkin: 10, busy }, (_, url) => {
    if (url.pathname === '/api/inventory') return inventory([skin('d', group.name)]);
    if (url.searchParams.has('all')) return ok({ skinCollections: [{ name }] });
    return ok({ skinCollectionSkingroups: [group], userSkinCollection: null });
  });
  await f.action('preview');
  const run = f.action('apply', f.approval().arg);
  assert.equal(f.requests.size, 1);
  f.action('stop');
  await run;
  assert.equal(f.posts.length, 0);
  assert.equal(f.requests.size, 0);
  assert.equal(f.locks.size, 0);
  assert.equal(busy.size, 1);
  assert.match(JSON.stringify(f.blocks()), /Stopped/);
});

test('Collection progress shows all collection cards and all Hub accounts independently of run selection', async t => {
  const group = oid('a');
  const f = hub(t, 'auto-skin-collection', { accountIds: ['a', 'b', 'c'], senders: ['a'] }, (id, url) => {
    if (url.pathname === '/') return { kind: 'ok', body: '{"buildId":"fixture"}' };
    if (url.pathname.includes('/cases/')) return ok({ pageProps: { cases: [] } });
    if (url.pathname.endsWith('/armory.json')) return ok({ pageProps: { armoryRewards: [] } });
    assert(url.searchParams.has('all'));
    if (id === 'c') return { kind: 'not-running' };
    return ok({
      skinCollections: [{ name: 'One', skingroupIds: [group] }, { name: 'Two', skingroupIds: [oid('b')] }],
      userSkinCollection: id === 'a' ? { submittedSkingroupIds: [group], redeemedCollectionRewards: ['One'] } : null,
    });
  });
  f.action('show-collection-progress');
  assert.match((await f.action('collection-overview')).message, /2 of 3 Hub accounts/);
  const blocks = f.blocks().find(block => block.title === 'Collection progress').blocks;
  assert.equal(blocks.find(block => block.type === 'stats').items.find(item => item.label === 'Collections completed across accounts').value, 1);
  assert.deepEqual(blocks.filter(block => block.type === 'card').map(block => block.title), ['One', 'Two']);
  const first = blocks.find(block => block.title === 'One');
  assert.match(first.summary, /1\/3 accounts complete/);
  assert.deepEqual(first.blocks[0].rows, [['A', '1/1', 'Claimed'], ['B', '0/1', 'Incomplete'], ['C', '—', 'Unchecked']]);
});

test('Collection buying is capped and openings are verified without auto-sell', async t => {
  const name = 'Fixture Case', group = { _id: oid('a'), name: 'Missing skin' }, item = { _id: oid('c'), name, price: 0.1, rankNeeded: 2 };
  let held = 1;
  let inFlight;
  const f = hub(t, 'auto-skin-collection', { collections: [name], source: 'buy', spend: 1.39, opens: 8, reserve: 2 }, (_, url, opts) => {
    if (url.pathname === '/') return { kind: 'ok', body: '{"buildId":"fixture"}' };
    if (url.pathname.includes('/cases/cases.json')) return ok({ pageProps: { cases: JSON.stringify([item]) } });
    if (url.pathname.includes('/cases/collections.json')) return ok({ pageProps: { cases: '[]' } });
    if (url.pathname.endsWith('/armory.json')) return ok({ pageProps: { armoryRewards: '[]' } });
    if (url.searchParams.get('all') === 'true') return ok({ skinCollections: [{ name }] });
    if (url.pathname === '/api/skinCollection') return ok({ skinCollectionSkingroups: [group], userSkinCollection: null });
    if (url.pathname === '/api/me') return ok({ money: 20, rank: { id: 5 }, caseOpenCount: 2, inventorySize: 20, inventoryCount: 10 });
    if (url.pathname === '/api/cases') {
      if (opts.method === 'POST') { held += opts.body.amount; return ok({}); }
      return ok([{ _id: item._id, amount: held }]);
    }
    assert.equal(url.pathname, '/api/open/case');
    assert.equal(opts.body.autoOpen, false);
    if (!inFlight && f.posts.some(post => post.url === '/api/cases' && post.method === 'POST')) {
      inFlight = f.blocks().find(b => b.title === 'Run progress').blocks;
    }
    held -= Number(opts.body.count);
    return ok([]);
  });
  await f.action('preview');
  assert.deepEqual(f.preview(), [['A', name, '1 owned · open first', '—'], ['A', name, 'Buy as needed after owned cases', '$0.1 per case']]);
  assert.equal((await f.action('apply', f.approval().arg)).ok, true);
  assert.deepEqual(f.posts.map(post => post.body.amount ?? post.body.count), [
    '1', 2, '2', 2, '2', 2, '2', 2, '2', 2, '2', 2, '2', 1, '1',
  ]);
  assert.equal(held, 0);
  assert.deepEqual(inFlight[0].rows[0], ['A', name, { bar: 0, text: '0 / 1' }, 'Opening cases']);
  assert.deepEqual(inFlight[1].rows[0][2], { bar: 20 / 139, text: '$0.2 / $1.39' });
  const final = f.blocks().find(b => b.title === 'Run progress').blocks[0].rows[0];
  assert.deepEqual(final[2], { bar: 130 / 139, text: '$1.3 / $1.39' });
  assert.match(final.at(-1), /14 opened/);
});

test('All purchasable collections uses a separate Armory budget and opens Armory cases serially', async t => {
  const group = { _id: oid('a'), name: 'Missing skin' };
  const standard = { _id: oid('b'), name: 'Cash Case', price: 2, rankNeeded: 1 };
  const armory = { id: oid('c'), name: 'Armory Collection', type: 'collectionCase', creditPrice: 4 };
  const held = new Map([[armory.id, 1]]);
  let credits = 4, mustReadStock = false;
  const f = hub(t, 'auto-skin-collection', {
    targets: 'purchasable', source: 'buy', spend: 4, armory: true, armoryCredits: 7, opens: 5,
  }, (_, url, opts) => {
    if (url.pathname === '/') return { kind: 'ok', body: '{"buildId":"fixture"}' };
    if (url.pathname.endsWith('/cases/cases.json')) return ok({ pageProps: { cases: [standard] } });
    if (url.pathname.endsWith('/cases/collections.json')) return ok({ pageProps: { cases: [] } });
    if (url.pathname.endsWith('/armory.json')) return ok({ pageProps: { armoryRewards: [armory] } });
    if (url.searchParams.has('all')) return ok({ skinCollections: [standard, armory, { name: 'Retired Case' }] });
    if (url.pathname === '/api/skinCollection') {
      assert.notEqual(url.searchParams.get('collection'), 'Retired Case');
      return ok({ skinCollectionSkingroups: [group], userSkinCollection: null });
    }
    if (url.pathname === '/api/me') return ok({ money: 20, rank: 5, caseOpenCount: 4, inventorySize: 20, inventoryCount: 0 });
    if (url.pathname === '/api/armory') {
      if (opts.method === 'PATCH') {
        assert.deepEqual(opts.body, { id: armory.id, type: 'collectionCase', amount: 1 });
        credits -= 4;
        held.set(armory.id, 10);
      }
      return ok({ credits });
    }
    if (url.pathname === '/api/cases') {
      if (opts.method === 'POST') {
        held.set(opts.body.id, opts.body.amount);
        return ok({});
      }
      mustReadStock = false;
      return ok([...held].map(([_id, amount]) => ({ _id, amount })));
    }
    assert.match(url.pathname, /^\/api\/open\/(case|collectionCase)$/);
    assert.equal(mustReadStock, false);
    mustReadStock = true;
    held.set(opts.body.id, held.get(opts.body.id) - Number(opts.body.count));
    return ok([]);
  });
  await f.action('preview');
  assert.deepEqual(f.preview().map(row => [row[1], row[3]]), [[standard.name, '$2 per case'], [armory.name, '—'], [armory.name, '4 credits / 10 · 0 best-case minimum']]);
  assert.equal(f.posts.length, 0);
  const result = await f.action('apply', f.approval().arg);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.posts.filter(post => post.url.startsWith('/api/open')).map(post => post.body.count), ['1', '2', ...Array(10).fill('1')]);
  assert.equal(f.posts[0].body.id, armory.id);
  assert.equal(held.get(armory.id), 0);
  assert.equal(f.posts.filter(post => post.method === 'PATCH').length, 1);
  const final = f.blocks().find(b => b.title === 'Run progress').blocks[0].rows[0];
  assert.deepEqual(final[3], { bar: 4 / 7, text: '4 / 7' });
});

test('Collection run submits fresh drops, then claims the reward without buying or opening extra cases', async t => {
  const name = 'Armory Collection';
  const item = { id: oid('c'), name, creditPrice: 4, type: 'collectionCase' };
  const groups = [{ _id: oid('a'), name: 'First skin' }, { _id: oid('b'), name: 'Second skin' }];
  const state = { submittedSkingroupIds: [], redeemedCollectionRewards: [] };
  const drops = new Map();
  let stock = 1, credits = 20, opened = 0;
  const f = hub(t, 'auto-skin-collection', {
    collections: [name], armory: true, armoryCredits: 20, maxSkin: 20, opens: 100,
  }, (_, url, opts) => {
    if (url.pathname === '/') return { kind: 'ok', body: '{"buildId":"fixture"}' };
    if (url.pathname.includes('/cases/')) return ok({ pageProps: { cases: [] } });
    if (url.pathname.endsWith('/armory.json')) return ok({ pageProps: { armoryRewards: [item] } });
    if (url.searchParams.has('all')) return ok({ skinCollections: [{ name }] });
    if (url.pathname === '/api/skinCollection') {
      if (opts.method === 'POST') {
        assert(drops.delete(opts.body.id));
        state.submittedSkingroupIds.push(opts.body.id);
      }
      if (opts.method === 'PATCH') {
        assert.equal(state.submittedSkingroupIds.length, 2);
        state.redeemedCollectionRewards.push(opts.body.collectionName);
      }
      return ok({ skinCollectionSkingroups: groups, userSkinCollection: state });
    }
    if (url.pathname === '/api/me') return ok({ money: 20, rank: 5, caseOpenCount: 20, inventorySize: 50, inventoryCount: 0 });
    if (url.pathname === '/api/cases') return ok([{ _id: item.id, amount: stock }]);
    if (url.pathname === '/api/inventory') {
      const drop = drops.get(url.searchParams.get('skingroupId'));
      return inventory(drop ? [drop] : []);
    }
    if (url.pathname === '/api/armory') {
      if (opts.method === 'PATCH') {
        assert.equal(stock, 0);
        assert.equal(state.submittedSkingroupIds.length, 1);
        assert.equal(opts.body.amount, 1);
        credits -= 4;
        stock += 10;
      }
      return ok({ credits });
    }
    assert.equal(url.pathname, '/api/open/collectionCase');
    assert.equal(opts.body.count, '1');
    const group = groups[opened++];
    const drop = skin(opened === 1 ? 'd' : 'e', group.name, { skingroupId: group._id });
    drops.set(group._id, drop);
    stock--;
    return ok([drop]);
  });
  await f.action('preview');
  assert(f.preview().some(row => row[3] === '4 credits / 10 · 4 best-case minimum'));
  assert.equal(f.posts.length, 0);
  assert.equal((await f.action('apply', f.approval().arg)).ok, true);
  assert.deepEqual(f.posts.map(post => [post.method, post.url.split('?')[0]]), [
    ['POST', '/api/open/collectionCase'], ['POST', '/api/skinCollection'],
    ['PATCH', '/api/armory'], ['POST', '/api/open/collectionCase'],
    ['POST', '/api/skinCollection'], ['PATCH', '/api/skinCollection'],
  ]);
  assert.equal(opened, 2);
  assert.equal(stock, 9);
  assert.deepEqual(state.redeemedCollectionRewards, [name]);
});

test('Favourites trades send exact approved IDs to the selected account and verify receipt', async t => {
  const tradeId = oid('d');
  const received = [];
  const trades = [];
  let joined = false, hostAccepted = false, guestAccepted = false;
  const id = acct => acct === 'a' ? 'sender-user' : 'receiver-user';
  const item = skin('a', 'Keep one', { isFavorite: true });
  const other = skin('b', 'Never send', {});
  let senderId, receiverId;
  const queues = { a: [], b: [] };
  function notify(type, list = ['a']) {
    for (const account of list) queues[account].push({ ev: type, data: {
      _id: tradeId, hostTokens: 0, guestTokens: 0,
      host: { user: { userId: id('a') }, hasAccepted: hostAccepted },
      guest: joined ? { user: { userId: id('b') }, hasAccepted: guestAccepted } : null,
    } });
  }
  const f = hub(t, 'auto-trade-favourites', {
    accountIds: ['a', 'b'], senders: ['a'], receiver: 'b', maxPrice: 10,
    socket: acct => ({
      emit(event, body) {
        trades.push([acct, event, body]);
        if (event === 'watchTrade') {
          if (acct === 'a') { senderId = body; notify('tradeInfo'); }
          else { receiverId = body; joined = true; notify('tradeInfo', ['a', 'b']); }
        }
        if (event === 'tradeAddSkins') {
          assert.deepEqual(body.skinIds, [item._id]);
          notify('tradeInfo', ['a', 'b']);
        }
        if (event === 'tradeAccept') {
          if (acct === 'a') hostAccepted = true;
          else guestAccepted = true;
          notify('tradeAccepted');
        }
        if (event === 'tradeConfirm') {
          assert(hostAccepted && guestAccepted);
          received.push(item);
          notify('tradeConfirmed');
        }
        return true;
      },
      async wait(events) {
        const index = queues[acct].findIndex(entry => events.includes(entry.ev));
        return index >= 0 ? queues[acct].splice(index, 1)[0] : null;
      },
      close() {},
    }),
  }, (acct, url) => {
    if (url.pathname === '/api/me') return ok({ dailyTradesLeft: 10, inventorySize: 100, inventoryCount: 1, tradeItems: 50 });
    if (url.pathname === '/api/user/profile') return ok({ userId: id(acct) });
    if (url.pathname === '/api/trading') return ok({ _id: tradeId });
    return inventory(acct === 'a' ? [item, other] : received);
  });
  await f.action('preview');
  assert.deepEqual(f.preview(), [['A', 'B', 'Keep one', '$5']]);
  assert.equal(f.posts.length, 0);
  const result = await f.action('apply', f.approval().arg);
  assert.equal(result.ok, true, result.error);
  assert.equal(senderId, receiverId);
  assert.equal(trades.at(-1)[1], 'tradeConfirm');
  assert.equal(received.length, 1);
});

test('Scheduled writes require Live and On, and completed scans respect the interval', async t => {
  const currentTime = Date.now;
  let time = currentTime();
  Date.now = () => time;
  t.after(() => { Date.now = currentTime; });
  const stock = [skin('a', 'Test item')], stored = [];
  const f = hub(t, 'auto-sort-su', {
    rules: [{ kind: 'name', match: 'Test', unit: 'Keep' }], runMode: 'practice', on: true, minutes: 5,
  }, (_, url, opts) => {
    if (url.pathname.endsWith('storageUnits')) return ok([{ _id: oid('f'), name: 'Keep', skinCount: stored.length }]);
    if (url.pathname === '/api/inventory') return inventory([...stock]);
    if (opts.method === 'POST') { stored.push(stock.shift()); return ok(null); }
    return inventory([...stored]);
  });
  time += 60_000;
  await f.callback();
  assert.equal(f.posts.length, 0);
  await f.action('preview');
  assert.equal(f.approval(), undefined);
  f.change('runMode', 'live');
  f.change('on', false);
  time += 60_000;
  await f.callback();
  assert.equal(f.posts.length, 0);
  f.change('on', true);
  time += 60_000;
  await f.callback();
  assert.equal(f.posts.length, 1);
  stock.push(skin('b', 'Test two'));
  time += 60_000;
  await f.callback();
  assert.equal(f.posts.length, 1);
  time += 240_000;
  await f.callback();
  assert.equal(f.posts.length, 2);
});
