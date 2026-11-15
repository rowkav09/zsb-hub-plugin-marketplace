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
  const values = { runMode: 'live', on: false, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.default])), ...options };
  const actions = new Map(), locks = new Set(), posts = [];
  let draw, onChange, callback, data = {};
  const routes = new Map(accounts.map(a => [a.id, 'route-' + a.id]));
  const ctx = {
    accounts: {
      list: () => accounts,
      get: id => accounts.find(a => a.id === id),
      busy: () => null,
      wanted: () => null,
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
  t.after(() => { plugin.stop(); rmSync(dir, { force: true, recursive: true }); });
  const action = (name, args) => actions.get(name)(args);
  return {
    action, posts, locks, routes, callback, change: ctx.settings.set, data: () => data,
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
  const f = hub(t, 'auto-skin-collection', { collections: [name], maxSkin: 20 }, (_, url, opts) => {
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
});

test('Collection buying is capped and openings are verified without auto-sell', async t => {
  const name = 'Fixture Case', group = { _id: oid('a'), name: 'Missing skin' }, item = { _id: oid('c'), name, price: 4, rankNeeded: 2 };
  let held = 1;
  const f = hub(t, 'auto-skin-collection', { collections: [name], source: 'buy', spend: 9, opens: 8, reserve: 2 }, (_, url, opts) => {
    if (url.pathname === '/') return { kind: 'ok', body: '{"buildId":"fixture"}' };
    if (url.pathname.includes('/cases/cases.json')) return ok({ pageProps: { cases: JSON.stringify([item]) } });
    if (url.pathname.includes('/cases/collections.json')) return ok({ pageProps: { cases: '[]' } });
    if (url.searchParams.get('all') === 'true') return ok({ skinCollections: [{ name }] });
    if (url.pathname === '/api/skinCollection') return ok({ skinCollectionSkingroups: [group], userSkinCollection: null });
    if (url.pathname === '/api/me') return ok({ money: 20, rank: { id: 5 }, caseOpenCount: 2, inventorySize: 20, inventoryCount: 10 });
    if (url.pathname === '/api/cases') {
      if (opts.method === 'POST') { held += opts.body.amount; return ok({}); }
      return ok([{ _id: item._id, amount: held }]);
    }
    assert.equal(url.pathname, '/api/open/case');
    assert.equal(opts.body.autoOpen, false);
    held -= Number(opts.body.count);
    return ok([]);
  });
  await f.action('preview');
  assert.deepEqual(f.preview(), [['A', name, 'Open 3 · buy 2', '$8']]);
  assert.equal((await f.action('apply', f.approval().arg)).ok, true);
  assert.deepEqual(f.posts.map(post => post.body.amount ?? post.body.count), [2, '2', '1']);
  assert.equal(held, 0);
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
