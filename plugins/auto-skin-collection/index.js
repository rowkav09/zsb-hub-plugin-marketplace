'use strict';

const { availablePrice, bounded, createBatch, idOk, money, notFavorite, Unconfirmed } = require('./farm-batch');

const { startOverview } = require('./overview');
const { createRunProgress } = require('./run-progress');

const COLLECTION = '/api/skinCollection';
const ARMORY = '/api/armory';
const ARMORY_BUNDLE = 10;
const cents = value => Math.floor(value * 100 + 1e-7);
const priceCents = value => Math.ceil(value * 100 - 1e-7);
const fold = value => value.trim().toLowerCase();
const baseName = value => fold(value.replace(/^StatTrak(?:™)?\s+|^Souvenir\s+/i, '')
  .replace(/\s*\((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, ''));

function limits(api) {
  const names = (api.get('collections') || []).map(fold);
  const all = api.get('targets') === 'purchasable';
  if (!all && !names.length) throw Error('Enter at least one exact collection name.');
  const useArmory = api.get('armory') === true;
  const credits = useArmory ? Math.floor(api.get('armoryCredits')) : 0;
  const maxSkin = api.get('maxSkin'), spend = api.get('spend'), reserve = api.get('reserve');
  if (![maxSkin, spend, reserve].every(value => Number.isFinite(value) && value >= 0)
    || ![credits, cents(spend), cents(reserve)].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Error('Enter valid cost limits.');
  }
  const source = api.get('source');
  return {
    all, names, useArmory, credits, maxSkin, source, cashBudget: source === 'buy' ? cents(spend) : 0,
    reserve, redeem: api.get('redeem') === true,
  };
}

function runSettings(ctx) {
  const get = key => ctx.settings.get(key);
  const chosen = ctx.accounts.list().filter(account => ctx.settings.runsOn('accounts', account.id)).length;
  const armory = get('armory') === true;
  const source = get('source');
  return [
    { type: 'card', id: 'collection-run-accounts', title: 'Accounts', summary: chosen + ' selected', open: !chosen, keys: ['accounts'] },
    { type: 'settings', keys: ['targets', ...(get('targets') === 'named' ? ['collections'] : []), 'armory'] },
    {
      type: 'card', id: 'collection-run-limits', title: 'Run limits', open: false,
      summary: (get('maxSkin') ? money(get('maxSkin')) + ' per skin' : 'Submissions paused') +
        (source === 'buy' ? ' · ' + money(get('spend')) + ' case budget' : '') +
        (armory ? ' · ' + get('armoryCredits') + ' Armory credits' : ''),
      keys: ['maxSkin', 'source',
        ...(source === 'buy' ? ['spend', 'reserve'] : []), ...(armory ? ['armoryCredits'] : []), 'redeem'],
    },
  ];
}

function collectionState(body) {
  if (!Array.isArray(body?.skinCollectionSkingroups) || !body.skinCollectionSkingroups.length
    || !Object.hasOwn(body, 'userSkinCollection')) throw Error('Collection progress unavailable.');
  const info = body.userSkinCollection;
  if (info !== null && (!Array.isArray(info?.submittedSkingroupIds) || !Array.isArray(info?.redeemedCollectionRewards))) {
    throw Error('Collection ownership unavailable.');
  }
  const groups = body.skinCollectionSkingroups;
  if (!groups.every(group => idOk(group?._id) && typeof group.name === 'string')) throw Error('Invalid collection contents.');
  return { groups, completed: new Set(info?.submittedSkingroupIds || []), rewards: new Set(info?.redeemedCollectionRewards || []) };
}

async function progress(api, id, route, name) {
  return collectionState(await api.read(id, route, COLLECTION + '?collection=' + encodeURIComponent(name)));
}

async function candidates(api, id, route, group, maxSkin) {
  const copies = new Map();
  let pages;
  let withinCap = true;
  // The site's submission accepts a group ID. Read every matching copy with the
  // inventory's Any-favourite filter and require an explicit false for every copy.
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ skingroupId: group._id, showUpgradedSkins: 'true', sort: 'price', page });
    const result = await api.read(id, route, '/api/inventory?' + query);
    const items = result?.skins;
    if (!Array.isArray(items)) return { copies: [] };
    if (page === 1 && items.length === 0) return { copies: [] };
    if (!Number.isSafeInteger(result.pages) || result.pages < page || (pages && result.pages !== pages) || !items.length) {
      return { copies: [] };
    }
    pages = result.pages;
    for (const item of items) {
      const matching = item?.skingroupId == null
        ? typeof item?.name === 'string' && baseName(item.name) === baseName(group.name)
        : item.skingroupId === group._id;
      if (!matching || !idOk(item._id) || copies.has(item._id)) return { copies: [] };
      if (!notFavorite(item)) return { copies: [], protected: true };
      withinCap &&= availablePrice(item, maxSkin);
      copies.set(item._id, { id: item._id, price: item.price });
    }
    if (pages === page) return { copies: withinCap ? [...copies.values()] : [] };
  }
  return { copies: [] };
}

async function shop(api, id, route, includeArmory) {
  const home = await api.request(id, route, '/');
  const build = /"buildId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(home?.body || '')?.[1];
  if (home?.kind !== 'ok' || !build) throw Error('Shop build data unavailable.');
  const items = new Map();
  for (const [file, type] of [['cases', 'case'], ['collections', 'collectionCase']]) {
    const body = await api.read(id, route, '/_next/data/' + build + '/en/cases/' + file + '.json?cases=' + file);
    const raw = body?.pageProps?.cases;
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) throw Error('Shop list unavailable.');
    for (const item of list) if (idOk(item?._id) && typeof item.name === 'string') items.set(fold(item.name), { ...item, type });
  }
  if (includeArmory) {
    const body = await api.read(id, route, '/_next/data/' + build + '/en/armory.json');
    const raw = body?.pageProps?.armoryRewards;
    const rewards = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(rewards)) throw Error('Armory rewards unavailable.');
    for (const reward of rewards) {
      if (!idOk(reward?.id) || typeof reward.name !== 'string'
        || !['case', 'collectionCase'].includes(reward.type)
        || !Number.isSafeInteger(reward.creditPrice) || reward.creditPrice < 1) continue;
      const key = fold(reward.name), item = items.get(key);
      if (item && (item._id !== reward.id || item.type !== reward.type)) continue;
      items.set(key, { ...item, _id: reward.id, type: reward.type, creditPrice: reward.creditPrice });
    }
  }
  return items;
}

async function armoryCredits(api, id, route) {
  const { credits } = await api.read(id, route, ARMORY);
  if (!Number.isSafeInteger(credits) || credits < 0) throw Error('Armory credit balance unavailable.');
  return credits;
}

const listedForCash = item => item && !item.isNonBuyable && Number.isFinite(item.price) && item.price > 0;

async function stock(api, id, route) {
  const items = await api.read(id, route, '/api/cases');
  if (!Array.isArray(items)) throw Error('Case inventory unavailable.');
  return new Map(items.filter(item => idOk(item?._id) && Number.isSafeInteger(item.amount) && item.amount >= 0)
    .map(item => [item._id, item.amount]));
}

function inventoryRoom(profile) {
  if (!Number.isSafeInteger(profile?.inventorySize) || !Number.isSafeInteger(profile.inventoryCount)) return 0;
  return Math.max(0, profile.inventorySize - profile.inventoryCount);
}

async function scanAccount(api, account, rules, plan) {
  const { id } = account;
  const name = account.name || id, route = api.route(id);
  const list = await api.read(id, route, COLLECTION + '?all=true');
  if (!Array.isArray(list?.skinCollections)) throw Error('Collection list unavailable.');
  const catalog = list.skinCollections.filter(entry => typeof entry?.name === 'string');
  if (!rules.all) {
    for (const configured of rules.names) {
      if (!catalog.some(entry => fold(entry.name) === configured)) plan.notes.push([name, 'Unknown collection: ' + configured]);
    }
  }
  const canOpen = rules.source !== 'inventory' || rules.useArmory;
  let items = new Map(), held = new Map();
  try {
    if (rules.all || canOpen) items = await shop(api, id, route, canOpen);
    if (canOpen) held = await stock(api, id, route);
  } catch (error) {
    if (rules.all && !items.size) throw error;
    plan.notes.push([name, error.message]);
  }
  const targets = catalog.filter(entry => {
    const key = fold(entry.name), item = items.get(key);
    return rules.all ? listedForCash(item) || (rules.useArmory && !!item?.creditPrice) : rules.names.includes(key);
  });
  const entries = [];
  let armoryMinimum = 0, armoryTargets = 0, armoryOwned = 0;
  for (const { name: collection } of targets) {
    try {
      const current = await progress(api, id, route, collection);
      const missing = current.groups.filter(group => !current.completed.has(group._id));
      const submit = [];
      const protectedGroups = new Set();
      for (const group of rules.maxSkin ? missing : []) {
        const result = await candidates(api, id, route, group, rules.maxSkin);
        if (result.protected) protectedGroups.add(group._id);
        const { copies } = result;
        if (!copies.length) continue;
        submit.push({ group, copies });
        const value = Math.max(...copies.map(item => item.price));
        plan.rows.push([name, collection, 'Submit ' + group.name + ' · site chooses 1 of ' + copies.length, money(value)]);
      }
      const claim = rules.redeem && !current.rewards.has(collection);
      if (claim && submit.length === missing.length) plan.rows.push([name, collection, 'Claim completed reward', '—']);
      const gap = missing.length - submit.length;
      const fillableGap = gap - protectedGroups.size;
      if (protectedGroups.size) plan.notes.push([name, collection + ' · ' + protectedGroups.size + ' group(s) skipped for favourite protection.']);
      const quote = items.get(fold(collection));
      const item = quote && (rules.source !== 'inventory' || (rules.useArmory && quote.creditPrice)) ? quote : null;
      const count = held.get(item?._id) || 0;
      const cash = listedForCash(item) && priceCents(item.price) > 0 && priceCents(item.price) <= rules.cashBudget;
      const armory = rules.useArmory && !!item?.creditPrice;
      if (fillableGap && item) {
        if (count) {
          plan.rows.push([name, collection, count + ' owned · open first' + (item.creditPrice ? ' · one at a time' : ''), '—']);
        }
        if (cash) plan.rows.push([name, collection, 'Buy as needed after owned cases', money(item.price) + ' per case']);
        if (armory) {
          const minimum = Math.ceil(Math.max(0, fillableGap - count) / ARMORY_BUNDLE) * item.creditPrice;
          armoryMinimum += minimum;
          armoryOwned += count;
          armoryTargets++;
          plan.rows.push([name, collection, 'Armory · ' + fillableGap + ' eligible gaps after planned submissions · ' + count + ' owned',
            item.creditPrice + ' credits / 10 · ' + minimum + ' best-case minimum']);
        }
      }
      const open = fillableGap > 0 && item && (count || cash || (armory && item.creditPrice <= rules.credits));
      if (submit.length || (claim && !missing.length) || open) entries.push({
        name: collection, ids: new Set(current.groups.map(group => group._id)), state: current, submit, claim, protectedGroups,
        item: open ? item : null,
      });
      if (fillableGap && !open) plan.notes.push([name, collection + ' · ' + fillableGap + ' eligible gaps with no planned openings.']);
    } catch (error) {
      api.requireRunning();
      plan.notes.push([name, collection + ' · ' + error.message]);
    }
  }
  plan.notes.push([name, 'Run budget · ' + money(rules.cashBudget / 100) + ' cash · ' + rules.credits + ' Armory credits.']);
  if (armoryTargets) {
    try {
      const balance = await armoryCredits(api, id, route);
      const cap = Math.min(balance, rules.credits);
      plan.notes.push([name, 'Armory · ' + armoryMinimum + ' credits best-case minimum after ' + armoryOwned
        + ' owned Armory cases · ' + cap + ' credits available under this run’s cap. Duplicate and rare drops can increase the cost.']);
    } catch (error) {
      plan.notes.push([name, 'Armory balance unavailable · best-case minimum ' + armoryMinimum + ' credits.']);
    }
  }
  if (entries.length) plan.jobs.push({ id, route, entries, result: [name] });
}

async function scan(api) {
  const rules = limits(api);
  const plan = { jobs: [], rows: [], notes: [], rules };
  const accounts = api.selected('accounts');
  if (!accounts.length) throw Error('Choose farm accounts.');
  for (const account of accounts) {
    try {
      await scanAccount(api, account, rules, plan);
    } catch (error) {
      plan.notes.push([account.name || account.id, error.message]);
    }
  }
  return plan;
}

async function readBack(read, test, message) {
  try {
    const value = await read();
    if (test(value)) return value;
  } catch {
    // The preceding site write might still have taken effect.
  }
  throw new Unconfirmed(message);
}

function checkGroups(entry, state) {
  if (state.groups.length !== entry.ids.size || state.groups.some(group => !entry.ids.has(group._id))) {
    throw Error('Collection contents changed. Run another preview.');
  }
}

async function submitSkins(api, run, entry, drops) {
  const { id, route, rules } = run;
  if (rules.maxSkin) {
    const pending = entry.state.groups.filter(group => !entry.state.completed.has(group._id));
    const approved = new Map(entry.submit.map(({ group, copies }) => [group._id, copies]));
    // Quick opens report skins in an array. When names are present, inspect just the groups that dropped.
    const identifiable = drops?.length && drops.every(drop => idOk(drop?.skingroupId) || typeof drop?.name === 'string');
    const dropped = identifiable ? drops : null;
    for (const group of pending) {
      if (entry.protectedGroups.has(group._id)) continue;
      const previewed = approved.get(group._id);
      if (drops === undefined && !previewed) continue;
      if (dropped && !dropped.some(drop => drop.skingroupId === group._id
        || (typeof drop.name === 'string' && baseName(drop.name) === baseName(group.name)))) continue;
      const result = await candidates(api, id, route, group, rules.maxSkin);
      if (result.protected) entry.protectedGroups.add(group._id);
      const live = result.copies;
      if (!live.length) continue;
      if (drops === undefined) {
        const prices = new Map(previewed.map(item => [item.id, item.price]));
        if (live.some(item => !prices.has(item.id) || item.price > prices.get(item.id))) continue;
      }
      run.phase = 'Submitting ' + group.name;
      if (await api.write(id, route, COLLECTION, 'POST', { id: group._id, collection: entry.name }) === null) continue;
      entry.state = await readBack(() => progress(api, id, route, entry.name),
        value => value.completed.has(group._id), 'Collection submission unconfirmed for ' + group.name + '.');
      run.submitted++;
      checkGroups(entry, entry.state);
    }
  }
  entry.complete = entry.state.groups.every(group => entry.state.completed.has(group._id));
  if (entry.claim && entry.complete && !entry.state.rewards.has(entry.name)) {
    run.phase = 'Claiming reward';
    if (await api.write(id, route, COLLECTION, 'PATCH', { collectionName: entry.name }) === null) {
      entry.note = 'The site refused the reward claim';
      return;
    }
    entry.state = await readBack(() => progress(api, id, route, entry.name),
      value => value.rewards.has(entry.name), 'Collection reward unconfirmed for ' + entry.name + '.');
    run.claimed++;
  }
}

async function buyStock(api, run, entry, me, count, readStock) {
  const { id, route, rules } = run;
  const { item } = entry;
  if (rules.cashBudget > run.cashCents && listedForCash(item)) {
    const current = (await shop(api, id, route, false)).get(fold(entry.name));
    const rank = me?.rank?.id ?? me?.rank;
    if (current?._id === item._id && current.type === item.type && listedForCash(current) && current.price <= item.price
      && Number.isFinite(me?.money) && Number.isFinite(rank) && Number.isFinite(current.rankNeeded) && rank >= current.rankNeeded) {
      const unitCost = priceCents(current.price);
      const available = Math.min(rules.cashBudget - run.cashCents, cents(me.money - rules.reserve));
      const quantity = unitCost > 0 ? Math.min(count, Math.floor(available / unitCost)) : 0;
      if (quantity > 0) {
        run.phase = 'Buying cases';
        if (await api.write(id, route, '/api/cases', 'POST', { id: item._id, type: item.type, amount: quantity }) === null) {
          entry.note = 'The site refused the case purchase';
          return 0;
        }
        const held = await readBack(readStock, total => total === quantity, 'Case purchase unconfirmed for ' + entry.name + '.');
        run.cashCents += quantity * unitCost;
        return held;
      }
    }
  }
  if (!rules.useArmory || !item.creditPrice || item.creditPrice > rules.credits - run.credits) return 0;
  const current = (await shop(api, id, route, true)).get(fold(entry.name));
  const balance = await armoryCredits(api, id, route);
  if (current?._id !== item._id || current.type !== item.type || current.creditPrice !== item.creditPrice
    || balance < item.creditPrice) return 0;
  run.phase = 'Redeeming Armory cases';
  if (await api.write(id, route, ARMORY, 'PATCH', { id: item._id, type: item.type, amount: 1 }) === null) {
    entry.note = 'The site refused the Armory redemption';
    return 0;
  }
  const held = await readBack(readStock, total => total === ARMORY_BUNDLE, 'Armory redemption unconfirmed for ' + entry.name + '.');
  await readBack(() => armoryCredits(api, id, route), credits => credits === balance - item.creditPrice,
    'Armory credit balance unconfirmed for ' + entry.name + '.');
  run.credits += item.creditPrice;
  return held;
}

async function workThroughCases(api, run, entry, buy) {
  const { id, route } = run;
  const { item } = entry;
  const hasGap = () => !entry.complete && entry.state.groups.some(group =>
    !entry.state.completed.has(group._id) && !entry.protectedGroups.has(group._id));
  if (!item || entry.note || !hasGap()) return;
  const readStock = async () => (await stock(api, id, route)).get(item._id) || 0;
  let held = await readStock();
  while (hasGap()) {
    if (!held && !buy) return;
    const me = await api.read(id, route, '/api/me');
    const room = inventoryRoom(me);
    if (!room) {
      entry.note = 'Inventory has no room for another drop';
      return;
    }
    // Armory cases always open individually. Shop cases retain the account's normal batch size.
    const perCall = item.creditPrice ? 1 : bounded(me.caseOpenCount, 1, 100, 1);
    const count = Math.min(perCall, room);
    if (!held) held = await buyStock(api, run, entry, me, count, readStock);
    if (!held) return;
    const quantity = Math.min(held, count);
    run.phase = item.creditPrice ? 'Opening Armory case' : 'Opening cases';
    const drops = await api.write(id, route, '/api/open/' + item.type, 'POST', {
      id: item._id, quickOpen: true, count: String(quantity), useEventTickets: false, caseOpenMultiplier: 1, autoOpen: false,
    });
    if (drops === null) {
      entry.note = 'The site refused the opening';
      return;
    }
    held = await readBack(readStock, total => total === held - quantity, 'Opening unconfirmed for ' + entry.name + '. Check case stock.');
    run.opened += quantity;
    await submitSkins(api, run, entry, Array.isArray(drops) ? drops : null);
  }
}

async function apply(api, job, run) {
  const { entries } = run;
  return api.lock([[job.id, job.route]], async () => {
    async function attempt(entry, phase, action) {
      if (entry.note) return;
      run.current = entry;
      run.phase = phase;
      try {
        await action();
      } catch (error) {
        if (error instanceof Unconfirmed) throw error;
        api.requireRunning();
        entry.note = error.message;
      }
    }
    for (const entry of entries) {
      await attempt(entry, 'Checking inventory', async () => {
        entry.state = await progress(api, job.id, job.route, entry.name);
        checkGroups(entry, entry.state);
        await submitSkins(api, run, entry);
      });
    }
    // Check owned cases for every target before charging either currency.
    for (const entry of entries) await attempt(entry, 'Checking owned cases', () => workThroughCases(api, run, entry, false));
    for (const entry of entries) await attempt(entry, 'Checking budget and stock', () => workThroughCases(api, run, entry, true));
    const summary = [run.opened + ' opened', run.submitted + ' submitted', run.claimed + ' claimed',
      money(run.cashCents / 100), run.credits + ' Armory credits'];
    for (const entry of entries) {
      if (entry.note) summary.push(entry.name + ' · ' + entry.note);
      if (entry.protectedGroups.size) summary.push(entry.name + ' · ' + entry.protectedGroups.size + ' group(s) skipped for favourite protection');
    }
    return summary.join(' · ');
  });
}

let stop;
module.exports = {
  start(ctx) {
    let view = 'progress';
    let needsRefresh = false;
    let applying = false;
    const progressDisplay = createRunProgress();
    const overview = startOverview(ctx, { shop, stock, progress, armoryCredits });
    ctx.panel.action('show-collection-progress', () => {
      view = 'progress';
      if (needsRefresh) {
        needsRefresh = false;
        void overview.refresh();
      }
    });
    ctx.panel.action('show-collection-run', () => { view = 'run'; });
    const panel = {
      ...ctx.panel,
      action(name, fn) {
        if (name === 'stop') {
          ctx.panel.action(name, () => { fn(); return { message: 'Stopping after the current request.' }; });
        } else if (name === 'apply') {
          ctx.panel.action(name, async token => {
            if (applying) return fn(token);
            applying = true;
            try {
              const result = await fn(token);
              progressDisplay.end();
              if (result.ok) {
                if (view === 'progress') void overview.refresh();
                else needsRefresh = true;
              }
              return result;
            } finally {
              applying = false;
            }
          });
        } else ctx.panel.action(name, fn);
      },
      tab: (title, render) => ctx.panel.tab(title, () => ({ blocks: [
        { type: 'buttons', items: [
          { label: 'Collection progress', action: 'show-collection-progress', primary: view === 'progress' },
          { label: 'Run once', action: 'show-collection-run', primary: view === 'run' },
        ] },
        ...(view === 'progress' ? overview.blocks() : [
          ...progressDisplay.blocks(),
          ...(applying ? [] : runSettings(ctx)),
          ...render().blocks.filter(block => block.type !== 'settings'),
        ]),
      ] })),
    };
    // Reuse the approval and review flow without the shared runner's schedule.
    const stopBatch = createBatch({
      ...ctx, get stopping() { return ctx.stopping; }, panel,
      every() {},
      power: { practice: () => false },
      settings: { ...ctx.settings, get: key => key === 'on' ? false : ctx.settings.get(key) },
    }, {
      title: 'Auto Skin Collection Completer', tab: 'Skin Collections',
      keys: [],
      columns: ['Account', 'Collection', 'Operation', 'Maximum value'], resultColumns: ['Account'],
      applyLabel: 'Run previewed jobs once',
      confirm: plan => 'Work on ' + plan.jobs.length + ' account(s)? Submit eligible existing skins and new drops, then claim completed rewards. '
        + 'Per account, spend up to ' + money(plan.rules.cashBudget / 100)
        + ' plus ' + plan.rules.credits + ' Armory credits within the enabled sources.',
      scan,
      async apply(api, job, plan) {
        const run = progressDisplay.begin(plan, job);
        try {
          const summary = await apply(api, job, run);
          run.phase = 'Finished';
          return summary;
        } catch (error) {
          run.phase = error instanceof Unconfirmed ? 'Review required' : error.message;
          throw error;
        } finally {
          run.current = null;
        }
      },
    });
    stop = () => { overview.stop(); stopBatch(); };
  },
  stop() { stop?.(); },
};
