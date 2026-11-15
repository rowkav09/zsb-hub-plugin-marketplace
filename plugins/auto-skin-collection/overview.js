'use strict';

const { model, expectedCredits } = require('./odds');

const CATALOG = '/api/skinCollection?all=true';
const integer = n => Math.round(n).toLocaleString('en-US');

function renderOverview(report) {
  const { checked, collections, failures, unavailable, total, estimating } = report;
  const rows = collections.flatMap(collection => collection.rows);
  const armory = collections.filter(collection => collection.item?.creditPrice);
  const unknown = armory.flatMap(collection => collection.rows).filter(row => row.expected == null).length;
  const expected = rows.reduce((sum, row) => sum + (row.expected ?? 0), 0);
  const makeCard = collection => {
    const complete = collection.rows.filter(row => row.complete).length;
    const missing = collection.rows.filter(row => row.expected == null).length;
    const credits = collection.rows.reduce((sum, row) => sum + (row.expected ?? 0), 0);
    const isArmory = Boolean(collection.item?.creditPrice);
    const summary = [complete + '/' + total + ' accounts complete',
      ...unavailable.length ? [unavailable.length + ' unchecked'] : [],
      ...isArmory ? [missing
        ? (missing < collection.rows.length ? integer(credits) + ' estimated credits · partial'
          : estimating ? 'Estimating credits…' : 'Estimate unavailable')
        : integer(credits) + ' estimated credits' + (unavailable.length ? ' · partial' : '')] : []];
    const fields = ['Account', 'Progress', 'Reward'];
    if (isArmory) fields.push('Owned cases', 'Estimated credits', 'Credit balance');
    return {
      type: 'card', id: 'collection-overview-' + collection.name, title: collection.name, open: false, summary: summary.join(' · '),
      blocks: [{
        type: 'table', columns: fields,
        rows: [
          ...collection.rows.slice().sort((a, b) => Number(b.complete) - Number(a.complete) || a.name.localeCompare(b.name))
            .map(row => [row.name, row.submitted + '/' + collection.ids.length, row.claimed ? 'Claimed' : row.complete ? 'Ready to claim' : 'Incomplete',
              ...isArmory ? [row.owned ?? '—', row.expected == null ? '—' : integer(row.expected), row.balance ?? '—'] : []]),
          ...unavailable.map(name => [name, '—', 'Unchecked', ...isArmory ? ['—', '—', '—'] : []]),
        ],
      }],
    };
  };
  const sorted = collections.slice().sort((a, b) =>
    Number(!!b.item?.creditPrice) - Number(!!a.item?.creditPrice) || a.name.localeCompare(b.name));
  return [{
    type: 'stats', items: [
      { label: 'Collections', value: collections.length || '—' },
      { label: 'Accounts checked', value: checked + '/' + total },
      { label: 'Collections completed across accounts', value: rows.filter(row => row.complete).length },
      { label: 'Estimated Armory credits' + (unknown || failures.length ? ' (partial)' : ''),
        value: estimating ? 'Calculating…'
          : armory.length && unknown < armory.flatMap(collection => collection.rows).length ? integer(expected) : '—' },
    ],
  }, {
    type: 'text',
    text: 'Estimates use submitted skins, owned cases and published CS2 rarity odds for the simulator. Each skin in a tier is treated as equally likely. Credits are an average across possible drops.',
  },
  ...sorted.map(makeCard),
  ...(failures.length ? [{ type: 'table', columns: ['Account or collection', 'Could not check'], rows: failures }] : [])];
}

function startOverview(ctx, { shop, stock, progress, armoryCredits }) {
  let stopped = false;
  let working = false;
  let initial = false;
  let report;
  let notice = '';

  async function scan() {
    const accounts = ctx.accounts.list();
    if (!accounts.length) throw Error('Add an account in Hub to check collections.');
    const routes = new Map(ctx.network.state().accounts.map(account => [account.id, account.route]));
    async function request(id, route, pathname) {
      if (stopped || ctx.stopping) throw Error('Collection overview scan stopped.');
      if (!route || ctx.network.state().accounts.find(account => account.id === id)?.route !== route) throw Error('Account route unavailable.');
      const reply = await ctx.request(id, pathname, { method: 'GET', tries: 2, timeoutMs: 12000 });
      if (ctx.network.state().accounts.find(account => account.id === id)?.route !== route) throw Error('Account route changed.');
      if (reply?.kind !== 'ok') throw Error(pathname.split('?')[0] + ' · ' + (reply?.status || reply?.kind || 'no response'));
      return reply;
    }
    const api = { request, read: async (...args) => (await request(...args)).json };
    const result = { checked: 0, collections: [], failures: [], unavailable: [], total: accounts.length, estimating: false };
    const seeds = new Map();
    let next = 0;
    async function readAccounts() {
      for (;;) {
        const account = accounts[next++];
        if (!account || stopped || ctx.stopping) return;
        const { id } = account, route = routes.get(id), name = account.name || id;
        try {
          const bulk = await api.read(id, route, CATALOG);
          const meta = bulk?.userSkinCollection;
          if (!Array.isArray(bulk?.skinCollections) || !Object.hasOwn(bulk, 'userSkinCollection')
            || (meta !== null && (!Array.isArray(meta?.submittedSkingroupIds) || !Array.isArray(meta?.redeemedCollectionRewards)))) {
            throw Error('Collection progress unavailable.');
          }
          seeds.set(id, { id, route, name, list: bulk.skinCollections,
            submitted: new Set(meta?.submittedSkingroupIds), claimed: new Set(meta?.redeemedCollectionRewards), rows: new Map() });
        } catch (error) { result.failures.push([name, error.message]); }
      }
    }
    await Promise.all([readAccounts(), readAccounts(), readAccounts()]);
    const good = accounts.map(account => seeds.get(account.id)).filter(Boolean);
    result.checked = good.length;
    result.unavailable = accounts.filter(account => !seeds.has(account.id)).map(account => account.name || account.id);
    if (!good.length) return result;
    const seed = good[0];
    for (const entry of seed.list) {
      if (typeof entry?.name !== 'string' || !Array.isArray(entry.skingroupIds) || !entry.skingroupIds.length) continue;
      const ids = entry.skingroupIds;
      const rows = good.map(account => {
        const count = ids.filter(group => account.submitted.has(group)).length;
        const row = { name: account.name, submitted: count, complete: count === ids.length, claimed: account.claimed.has(entry.name) };
        account.rows.set(entry.name, row);
        return row;
      });
      result.collections.push({ name: entry.name, ids, rows });
    }
    if (stopped || ctx.stopping) return result;
    // Publish the completion counts while the extra Armory lookups are in flight.
    result.estimating = true;
    report = result;
    let shopItems = new Map();
    try {
      shopItems = await shop(api, seed.id, seed.route, true);
    } catch (error) { result.failures.push(['Armory', error.message]); }
    for (const collection of result.collections) collection.item = shopItems.get(collection.name.trim().toLowerCase());
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
        if (!account || stopped || ctx.stopping) return;
        const { id, route, name, submitted, rows } = account;
        let owned, balance;
        if (armory.length) {
          try {
            owned = await stock(api, id, route);
            balance = await armoryCredits(api, id, route);
          } catch (error) { result.failures.push([name, error.message]); }
        }
        for (const collection of armory) {
          const row = rows.get(collection.name);
          row.balance = balance;
          row.owned = owned ? owned.get(collection.item._id) || 0 : undefined;
          const odds = models.get(collection.name);
          if (row.complete) row.expected = 0;
          else if (odds && row.owned !== undefined) {
            const missing = odds.filter(skin => !submitted.has(skin.id));
            const key = JSON.stringify([row.owned, collection.item.creditPrice, missing.map(skin => skin.chance).sort()]);
            if (!estimates.has(key)) estimates.set(key, expectedCredits(missing, row.owned, collection.item.creditPrice));
            row.expected = estimates.get(key);
          }
        }
      }
    }
    await Promise.all([buildRows(), buildRows(), buildRows()]);
    result.estimating = false;
    return result;
  }

  async function refresh() {
    if (working) return { ok: false, message: 'An overview scan is already running.' };
    working = true;
    try {
      const fresh = await scan();
      if (stopped || ctx.stopping) return { message: 'Collection overview scan stopped.' };
      report = fresh;
      notice = '';
      return { message: 'Checked ' + report.checked + ' of ' + report.total + ' Hub accounts.' };
    } catch (error) {
      notice = error.message;
      return { ok: false, message: notice };
    } finally {
      working = false;
    }
  }
  function loadOnce() {
    if (initial || working || report || stopped || ctx.stopping || !ctx.accounts.list().some(account => account.healthy)) return;
    initial = true;
    return refresh();
  }
  ctx.panel.action('collection-overview', refresh);
  ctx.on('report', loadOnce);
  void ctx.sleep(1500).then(loadOnce);
  return {
    blocks: () => [{ type: 'section', title: 'Collection progress', blocks: [
      ...(working ? [{ type: 'notice', text: report?.estimating ? 'Calculating Armory estimates…' : 'Checking account completion…' }]
        : [{ type: 'buttons', items: [{ action: 'collection-overview', label: 'Refresh collection progress' }] }]),
      ...(notice ? [{ type: 'notice', text: notice }] : []),
      ...(!working && !notice && !report ? [{ type: 'text', text: 'Shows every collection and completion counts across your Hub accounts.' }] : []),
      ...(report ? renderOverview(report) : []),
    ] }],
    refresh,
    stop: () => { stopped = true; },
  };
}

module.exports = { startOverview };
