'use strict';

const { availablePrice, bounded, createBatch, idOk, money, notFavorite, Unconfirmed } = require('./farm-batch');

const COLLECTION = '/api/skinCollection';
const ARMORY = '/api/armory';
const ARMORY_BUNDLE = 10;
const fold = value => value.trim().toLowerCase();
const baseName = value => fold(value.replace(/^StatTrak(?:™)?\s+|^Souvenir\s+/i, ''));

function limits(api) {
  const names = (api.get('collections') || []).map(fold);
  const all = api.get('targets') === 'purchasable';
  if (!all && !names.length) throw Error('Enter at least one exact collection name.');
  const useArmory = api.get('armory') === true;
  const credits = bounded(api.get('armoryCredits'), 0, 1000);
  if (useArmory && !credits) throw Error('Set a positive Armory credit budget first.');
  const maxSkin = api.get('maxSkin'), spend = api.get('spend'), reserve = api.get('reserve');
  if (![maxSkin, spend, reserve].every(value => Number.isFinite(value) && value >= 0)) throw Error('Enter valid cost limits.');
  const source = api.get('source');
  if (source === 'buy' && spend <= 0) throw Error('Set a positive purchase budget first.');
  return {
    all, names, useArmory, credits, maxSkin, source, spend, reserve, redeem: api.get('redeem') === true,
    submissions: bounded(api.get('submissions'), 1, 80, 25), opens: bounded(api.get('opens'), 1, 100, 10),
  };
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
  const result = await api.inventory(id, route, 10, { skingroupId: group._id, favoriteSkinsFilter: 'none' });
  // The game chooses a physical item for a submitted skin group. Approve the whole
  // set of possible inputs, including duplicates, or skip when the set cannot be bounded.
  const items = result.items.filter(item => item.skingroupId == null
    ? typeof item.name === 'string' && baseName(item.name) === baseName(group.name)
    : item.skingroupId === group._id);
  if (!result.complete || !items.length || items.length !== result.items.length
    || !items.every(item => notFavorite(item) && availablePrice(item, maxSkin))) return [];
  return items.map(item => ({ id: item._id, price: item.price })).sort((a, b) => a.id.localeCompare(b.id));
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

function openingPlan(item, held, allowed, cashBudget, creditBudget, canBuy) {
  if (!item || !allowed) return null;
  const owned = Math.min(allowed, held);
  const buy = canBuy && listedForCash(item)
    ? Math.min(allowed - owned, Math.floor(cashBudget / item.price)) : 0;
  const credits = !held && !buy && item.creditPrice && item.creditPrice <= creditBudget ? item.creditPrice : 0;
  const opens = owned + buy + (credits ? Math.min(allowed, ARMORY_BUNDLE) : 0);
  return opens ? {
    caseId: item._id, type: item.type, opens, buy, price: buy ? item.price : 0, credits,
    single: !!item.creditPrice,
  } : null;
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
  const items = rules.all || canOpen ? await shop(api, id, route, canOpen) : new Map();
  const targets = catalog.filter(entry => {
    const key = fold(entry.name), item = items.get(key);
    return rules.all ? listedForCash(item) || (rules.useArmory && !!item?.creditPrice) : rules.names.includes(key);
  });
  let supply, openings = 0, spend = 0, credits = 0, submitted = 0;
  for (const entry of targets) {
    const current = await progress(api, id, route, entry.name);
    const missing = current.groups.filter(group => !current.completed.has(group._id));
    const submit = [], rows = [];
    let skipped = 0;
    for (const group of missing) {
      if (!rules.maxSkin || submitted >= rules.submissions) break;
      const items = await candidates(api, id, route, group, rules.maxSkin);
      if (!items.length) { skipped++; continue; }
      const value = Math.max(...items.map(item => item.price));
      submit.push({ group, items });
      submitted++;
      rows.push([name, entry.name, 'Submit ' + group.name + ' · site chooses 1 of ' + items.length, money(value)]);
    }
    const claim = rules.redeem && submit.length === missing.length && !current.rewards.has(entry.name);
    if (claim) rows.push([name, entry.name, 'Claim completed reward', '—']);
    let open = null;
    const item = items.get(fold(entry.name));
    if (item && (rules.source !== 'inventory' || (rules.useArmory && item.creditPrice)) && missing.length > submit.length && openings < rules.opens) {
      try {
        if (!supply) {
          const owned = await stock(api, id, route);
          const me = await api.read(id, route, '/api/me');
          supply = {
            owned, room: inventoryRoom(me), rank: me?.rank?.id ?? me?.rank,
            cash: Number.isFinite(me?.money) ? Math.max(0, me.money - rules.reserve) : 0,
            credits: rules.useArmory ? await armoryCredits(api, id, route) : 0,
          };
        }
        const allowed = Math.min(rules.opens - openings, Math.max(0, supply.room - openings));
        const cashBudget = Math.max(0, Math.min(rules.spend, supply.cash) - spend);
        const creditBudget = Math.max(0, Math.min(rules.credits, supply.credits) - credits);
        const canBuy = rules.source === 'buy' && Number.isFinite(supply.rank)
          && Number.isFinite(item.rankNeeded) && supply.rank >= item.rankNeeded;
        open = openingPlan(item, supply.owned.get(item._id) || 0, allowed, cashBudget, creditBudget, canBuy);
        if (open) {
          openings += open.opens;
          spend += open.buy * open.price;
          credits += open.credits;
          const detail = 'Open ' + open.opens + (open.single ? ' one at a time' : '');
          if (open.credits) rows.push([name, entry.name, detail + ' · redeem 1 Armory bundle of 10', open.credits + ' credits']);
          else rows.push([name, entry.name, detail + ' · buy ' + open.buy, money(open.buy * open.price)]);
        }
      } catch (error) {
        plan.notes.push([name, entry.name + ' · ' + error.message]);
      }
    }
    plan.rows.push(...rows);
    if (submit.length || claim || open) plan.jobs.push({
      id, name: entry.name, route, submit, claim, open, result: [name, entry.name],
    });
    if (skipped || (!submit.length && missing.length && !open)) {
      plan.notes.push([name, entry.name + ' · ' + (missing.length - submit.length) + ' gaps remain after the planned submissions.']);
    }
  }
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

async function openCases(api, job, rules) {
  const { id, route, open } = job;
  const readStock = async () => (await stock(api, id, route)).get(open.caseId) || 0;
  let held = await readStock();
  const me = await api.read(id, route, '/api/me');
  const planned = open.opens;
  if (inventoryRoom(me) < planned) return 'Inventory room changed · openings skipped.';
  if (open.credits && !held) {
    const item = (await shop(api, id, route, true)).get(fold(job.name));
    const balance = await armoryCredits(api, id, route);
    if (item?._id !== open.caseId || item.type !== open.type || item.creditPrice !== open.credits
      || balance < open.credits) return 'Armory price or balance changed · openings skipped.';
    if (await api.write(id, route, ARMORY, 'PATCH', { id: open.caseId, type: open.type, amount: 1 }) === null) {
      return 'The Armory refused the redemption.';
    }
    held = await readBack(readStock, count => count === ARMORY_BUNDLE, 'Armory redemption unconfirmed for ' + job.name + '. Check case stock.');
    await readBack(() => armoryCredits(api, id, route), value => value === balance - open.credits,
      'Armory credit balance unconfirmed for ' + job.name + '. Check the credit balance.');
  }
  if (open.buy) {
    const item = (await shop(api, id, route, false)).get(fold(job.name));
    const cost = open.buy * item?.price;
    const rank = me?.rank?.id ?? me?.rank;
    if (item?._id !== open.caseId || item.type !== open.type || !listedForCash(item) || !Number.isFinite(cost)
      || item.price > open.price || !Number.isFinite(me?.money) || me.money - cost < rules.reserve
      || !Number.isFinite(rank) || !Number.isFinite(item.rankNeeded) || rank < item.rankNeeded) return 'Shop quote or balance changed · openings skipped.';
    if (await api.write(id, route, '/api/cases', 'POST', { id: open.caseId, type: open.type, amount: open.buy }) === null) {
      return 'The site refused the case purchase.';
    }
    held = await readBack(readStock, count => count >= held + open.buy, 'Purchase unconfirmed for ' + job.name + '. Check case stock.');
  }
  let opened = 0;
  const want = Math.min(planned, held);
  const perCall = open.single ? 1 : bounded(me.caseOpenCount, 1, 100, 1);
  while (opened < want) {
    const count = Math.min(perCall, want - opened);
    const result = await api.write(id, route, '/api/open/' + open.type, 'POST', {
      id: open.caseId, quickOpen: true, count: String(count), useEventTickets: false, caseOpenMultiplier: 1, autoOpen: false,
    });
    if (result === null) return 'Opened ' + opened + ' · the site refused the next call.';
    held = await readBack(readStock, total => total === held - count, 'Opening unconfirmed for ' + job.name + '. Check case stock.');
    opened += count;
  }
  return 'Opened ' + opened + ' · next scan can submit new drops.';
}

async function apply(api, job, plan) {
  return api.lock([[job.id, job.route]], async () => {
    const { id, route, name } = job;
    let state = await progress(api, id, route, name);
    let submitted = 0;
    for (const { group, items } of job.submit) {
      if (state.completed.has(group._id) || !state.groups.some(current => current._id === group._id)) continue;
      const live = await candidates(api, id, route, group, plan.rules.maxSkin);
      const approved = new Map(items.map(item => [item.id, item.price]));
      if (!live.length || live.some(item => !approved.has(item.id) || item.price > approved.get(item.id))) continue;
      if (await api.write(id, route, COLLECTION, 'POST', { id: group._id, collection: name }) === null) continue;
      state = await readBack(() => progress(api, id, route, name),
        value => value.completed.has(group._id), 'Collection submission unconfirmed for ' + group.name + '.');
      submitted++;
    }
    const complete = state.groups.every(group => state.completed.has(group._id));
    let claimed = false;
    if (job.claim && complete && !state.rewards.has(name)) {
      if (await api.write(id, route, COLLECTION, 'PATCH', { collectionName: name }) !== null) {
        await readBack(() => progress(api, id, route, name),
          value => value.rewards.has(name), 'Collection reward unconfirmed for ' + name + '.');
        claimed = true;
      }
    }
    const result = [submitted + ' submitted', ...(claimed ? ['reward claimed'] : [])];
    if (!complete && job.open) result.push(await openCases(api, job, plan.rules));
    return result.join(' · ');
  });
}

let stop;
module.exports = {
  start(ctx) {
    stop = createBatch(ctx, {
      title: 'Auto Skin Collection Completer', tab: 'Skin Collections',
      keys: ['runMode', 'on', 'accounts', 'targets', 'collections', 'maxSkin', 'submissions', 'redeem', 'source', 'armory', 'armoryCredits', 'opens', 'spend', 'reserve', 'minutes'],
      columns: ['Account', 'Collection', 'Operation', 'Maximum value'], resultColumns: ['Account', 'Collection'],
      applyLabel: 'Run previewed collection jobs',
      confirm: plan => 'Run ' + plan.jobs.length + ' collection jobs? Submissions consume skins. Purchases and openings follow the preview.',
      scan, apply,
    });
  },
  stop() { stop?.(); },
};
