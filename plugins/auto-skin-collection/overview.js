'use strict';

const { model, expectedCredits } = require('./odds');

const CATALOG = '/api/skinCollection?all=true';
const integer = n => Math.round(n).toLocaleString('en-US');

function renderOverview(report) {
  const { names, collections, failures, selected } = report;
  const rows = collections.flatMap(collection => collection.rows);
  const armory = collections.filter(collection => collection.item?.creditPrice);
  const unknown = armory.flatMap(collection => collection.rows).filter(row => row.expected == null).length;
  const expected = rows.reduce((sum, row) => sum + (row.expected ?? 0), 0);
  const makeCard = collection => {
    const complete = collection.rows.filter(row => row.complete).length;
    const missing = collection.rows.filter(row => row.expected == null).length;
    const total = collection.rows.reduce((sum, row) => sum + (row.expected ?? 0), 0);
    const isArmory = Boolean(collection.item?.creditPrice);
    const summary = [complete + '/' + collection.rows.length + ' complete',
      ...isArmory ? [missing
        ? (missing < collection.rows.length ? integer(total) + ' estimated credits · partial' : 'Estimate unavailable')
        : integer(total) + ' estimated credits'] : []];
    const fields = ['Account', 'Progress', 'Reward'];
    if (isArmory) fields.push('Owned cases', 'Estimated credits', 'Credit balance');
    return {
      type: 'card', id: 'collection-overview-' + collection.name, title: collection.name, open: false, summary: summary.join(' · '),
      blocks: [{
        type: 'table', columns: fields,
        rows: collection.rows.slice().sort((a, b) => Number(b.complete) - Number(a.complete) || a.name.localeCompare(b.name))
          .map(row => [row.name, row.submitted + '/' + collection.ids.length, row.claimed ? 'Claimed' : row.complete ? 'Ready to claim' : 'Incomplete',
            ...isArmory ? [row.owned ?? '—', row.expected == null ? '—' : integer(row.expected), row.balance ?? '—'] : []]),
      }],
    };
  };
  const cards = collections.map(makeCard);
  return [{
    type: 'stats', items: [
      { label: 'Accounts checked', value: names.length + '/' + selected },
      { label: 'Collections completed across accounts', value: rows.filter(row => row.complete).length },
      { label: 'Estimated Armory credits' + (unknown || failures.length ? ' (partial)' : ''),
        value: armory.length && unknown < armory.flatMap(collection => collection.rows).length ? integer(expected) : '—' },
    ],
  }, {
    type: 'text',
    text: 'Estimates use submitted skins, owned cases and published CS2 rarity odds for the simulator. Each skin in a tier is treated as equally likely. Credits are an average across possible drops.',
  },
  ...cards.filter((_, index) => collections[index].item?.creditPrice),
  {
    type: 'card', id: 'other-collections', title: 'Other collections', open: false,
    summary: (collections.length - armory.length) + ' collections',
    blocks: cards.filter((_, index) => !collections[index].item?.creditPrice),
  },
  ...(failures.length ? [{ type: 'table', columns: ['Account or collection', 'Could not check'], rows: failures }] : [])];
}

function startOverview(ctx, { shop, stock, progress, armoryCredits }) {
  let stopped = false;
  let working = false;
  let report;
  let notice = '';
  let revision = 0;
  ctx.settings.onChange(key => { if (key === 'accounts') { revision++; report = undefined; } });

  async function scan() {
    const accounts = ctx.accounts.list().filter(account => ctx.settings.runsOn('accounts', account.id));
    if (!accounts.length) throw Error('Choose farm accounts first.');
    const run = revision;
    const routes = new Map(ctx.network.state().accounts.map(account => [account.id, account.route]));
    async function request(id, route, pathname) {
      if (stopped || ctx.stopping || run !== revision) throw Error('Collection overview scan stopped.');
      if (!route || ctx.network.state().accounts.find(account => account.id === id)?.route !== route) throw Error('Account route unavailable.');
      const reply = await ctx.request(id, pathname, { method: 'GET', tries: 2, timeoutMs: 12000 });
      if (ctx.network.state().accounts.find(account => account.id === id)?.route !== route) throw Error('Account route changed.');
      if (reply?.kind !== 'ok') throw Error(pathname.split('?')[0] + ' · ' + (reply?.status || reply?.kind || 'no response'));
      return reply;
    }
    const api = { request, read: async (...args) => (await request(...args)).json };
    const result = { names: [], collections: [], failures: [], selected: accounts.length };
    const seeds = new Map();
    let next = 0;
    async function readAccounts() {
      for (;;) {
        const account = accounts[next++];
        if (!account || stopped || revision !== run) return;
        const { id } = account, route = routes.get(id), name = account.name || id;
        try {
          const bulk = await api.read(id, route, CATALOG);
          const meta = bulk?.userSkinCollection;
          if (!Array.isArray(bulk?.skinCollections) || !Object.hasOwn(bulk, 'userSkinCollection')
            || (meta !== null && (!Array.isArray(meta?.submittedSkingroupIds) || !Array.isArray(meta?.redeemedCollectionRewards)))) {
            throw Error('Collection progress unavailable.');
          }
          seeds.set(id, { id, route, name, list: bulk.skinCollections,
            submitted: new Set(meta?.submittedSkingroupIds), claimed: new Set(meta?.redeemedCollectionRewards) });
        } catch (error) { result.failures.push([name, error.message]); }
      }
    }
    await Promise.all([readAccounts(), readAccounts(), readAccounts()]);
    const good = [...seeds.values()];
    if (!good.length) return result;
    const seed = good[0];
    let shopItems = new Map();
    try {
      shopItems = await shop(api, seed.id, seed.route, true);
    } catch (error) { result.failures.push(['Armory', error.message]); }
    for (const entry of seed.list) {
      if (typeof entry?.name !== 'string' || !Array.isArray(entry.skingroupIds) || !entry.skingroupIds.length) continue;
      result.collections.push({ name: entry.name, ids: entry.skingroupIds, item: shopItems.get(entry.name.trim().toLowerCase()), rows: [] });
    }
    const armory = result.collections.filter(collection => collection.item?.creditPrice);
    const models = new Map();
    for (const collection of armory) {
      try {
        const state = await progress(api, seed.id, seed.route, collection.name);
        const odds = model({ ...collection.item, name: collection.name }, state.groups);
        if (odds && odds.length === collection.ids.length && odds.every(skin => collection.ids.includes(skin.id))) {
          models.set(collection.name, odds);
        }
      } catch (error) { result.failures.push([collection.name, error.message]); }
    }

    const estimates = new Map();
    next = 0;
    async function buildRows() {
      for (;;) {
        const account = good[next++];
        if (!account || stopped || revision !== run) return;
        const { id, route, name, submitted, claimed } = account;
        let owned, balance;
        if (armory.length) {
          try {
            owned = await stock(api, id, route);
            balance = await armoryCredits(api, id, route);
          } catch (error) { result.failures.push([name, error.message]); }
        }
        result.names.push(name);
        for (const collection of result.collections) {
          const count = collection.ids.filter(group => submitted.has(group)).length;
          const done = count === collection.ids.length;
          const row = { name, submitted: count, complete: done, claimed: claimed.has(collection.name), balance };
          if (collection.item?.creditPrice) {
            row.owned = owned ? owned.get(collection.item._id) || 0 : undefined;
            const odds = models.get(collection.name);
            if (done) row.expected = 0;
            else if (odds && row.owned !== undefined) {
              const missing = odds.filter(skin => !submitted.has(skin.id));
              const key = JSON.stringify([row.owned, collection.item.creditPrice, missing.map(skin => skin.chance).sort()]);
              if (!estimates.has(key)) estimates.set(key, expectedCredits(missing, row.owned, collection.item.creditPrice));
              row.expected = estimates.get(key);
            }
          }
          collection.rows.push(row);
        }
      }
    }
    await Promise.all([buildRows(), buildRows(), buildRows()]);
    return result;
  }

  ctx.panel.action('collection-overview', async () => {
    if (working) return { ok: false, message: 'An overview scan is already running.' };
    const before = revision;
    working = true;
    try {
      const fresh = await scan();
      if (stopped || revision !== before) return { message: 'Collection overview scan stopped.' };
      report = fresh;
      notice = '';
      return { message: 'Checked ' + report.names.length + ' of ' + report.selected + ' selected farm accounts.' };
    } catch (error) {
      notice = error.message;
      return { ok: false, message: notice };
    } finally {
      working = false;
    }
  });
  return {
    blocks: () => [{ type: 'section', title: 'Collection progress', blocks: [
      ...(working ? [{ type: 'notice', text: 'Reading collection progress and Armory balances…' }]
        : [{ type: 'buttons', items: [{ action: 'collection-overview', label: 'Refresh collection progress' }] }]),
      ...(notice ? [{ type: 'notice', text: notice }] : []),
      ...(report ? renderOverview(report) : []),
    ] }],
    stop: () => { stopped = true; },
  };
}

module.exports = { startOverview };
