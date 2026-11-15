'use strict';

const MILESTONES = [
  { key: 'starter', label: 'Starter ranks', rank: 1, maps: ['a', 'b'] },
  { key: 'guardian', label: 'Master Guardian I', rank: 11, maps: ['c', 'd'] },
  { key: 'global', label: 'Global Elite', rank: 18, maps: ['e'] },
  { key: 'premier', label: '5,000 Premier', rank: 18, rating: 5000, maps: ['f'] },
];
const MAPS = {
  a: { path: 'de_dust_2', name: 'Dust II', rank: 1 },
  b: { path: 'Mirage', name: 'Mirage', rank: 7 },
  c: { path: 'Inferno', name: 'Inferno', rank: 11 },
  d: { path: 'Ancient', name: 'Ancient', rank: 15 },
  e: { path: 'Anubis', name: 'Anubis', rank: 18 },
  f: { path: 'Cobblestone', name: 'Cobblestone', rank: 18, premier: 2 },
};

const idOf = value => value?.id ?? value;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const cash = value => Number.isFinite(value) && value >= 0;
const skillId = value => typeof value === 'string' && /^[a-f]\d{1,4}$/.test(value);
const itemId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const cents = value => Math.round(value * 100);

function pageData(body) {
  const script = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(body || '');
  if (!script) throw Error('Case Clicker page data is unavailable.');
  return JSON.parse(script[1]);
}

const unpack = value => typeof value === 'string' ? JSON.parse(value) : value;

function parseCatalog(data) {
  const cases = unpack(data?.pageProps?.cases);
  if (!Array.isArray(cases) || !cases.length) throw Error('The weapon case catalog is unavailable.');
  return cases.filter(item => itemId(item?._id) && typeof item.name === 'string' &&
    cash(item.price) && item.price > 0 && whole(item.rankNeeded))
    .map(item => ({
      id: item._id, name: item.name, price: item.price, rank: item.rankNeeded, buyable: item.isNonBuyable === false,
    }))
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

function skillMap(body, prefix) {
  const map = MAPS[prefix];
  const data = pageData(body).props?.pageProps;
  const tree = unpack(data?.skillmap);
  const owned = unpack(data?.skillIds);
  if (tree?.name !== map.name || !Array.isArray(tree.skills) || !Array.isArray(owned) ||
    !(whole(tree.requiredRankId) || whole(tree.requiredPremierId))) {
    throw Error(map.name + ' skill data is unavailable.');
  }
  const skills = new Map();
  for (const node of tree.skills) {
    if (!skillId(node?.id) || node.id[0] !== prefix || skills.has(node.id) ||
      !cash(node.cost) || (node.requiredPrevSkillId !== null && !skillId(node.requiredPrevSkillId))) {
      throw Error(map.name + ' has an invalid skill definition.');
    }
    let frequency = 0;
    let price = 0;
    for (const reward of Array.isArray(node.rewards) ? node.rewards : []) {
      const [type, raw] = String(reward).split(';');
      const amount = Number(raw);
      if (!cash(amount)) continue;
      if (type === '15') frequency += amount;
      if (type === '19') price += amount;
    }
    skills.set(node.id, {
      id: node.id, name: node.name, cost: node.cost, parent: node.requiredPrevSkillId,
      map: map.name, frequency, price,
    });
  }
  return { skills, owned: new Set(owned), rank: tree.requiredRankId, premier: tree.requiredPremierId };
}

function unlocked(map, account) {
  return (!map.rank || idOf(account.rank) >= map.rank) &&
    (!map.premier || idOf(account.premierRank) >= map.premier);
}

function milestoneOf(account) {
  return [...MILESTONES].reverse().find(stage => idOf(account.rank) >= stage.rank &&
    (!stage.rating || account.premierRating >= stage.rating));
}

function customIds(text) {
  const ids = [...new Set(String(text || '').toLowerCase().split(/[\s,]+/).filter(Boolean))];
  if (!ids.length || ids.length > 250 || ids.some(id => !skillId(id))) {
    throw Error('Enter valid skill IDs for each custom milestone, for example a1, a2, b12.');
  }
  return ids;
}

function relevantMaps(stage, preferences, account) {
  const mode = preferences[stage.key];
  const previousStages = MILESTONES.slice(0, MILESTONES.indexOf(stage) + 1).reverse();
  const prefixes = mode === 'custom' ? preferences[stage.key + 'Ids'].map(id => id[0])
    : mode === 'skip' ? [] : previousStages.flatMap(item => item.maps);
  return [...new Set(prefixes)].filter(prefix => unlocked(MAPS[prefix], account));
}

function nextSkill(stage, preferences, maps, account) {
  const mode = preferences[stage.key];
  if (mode === 'skip' || !whole(account.skillPoints) || !account.skillPoints) return null;

  function missingPath(map, id) {
    const path = [];
    const visited = new Set();
    while (id && !map.owned.has(id)) {
      const node = map.skills.get(id);
      if (!node || visited.has(id)) throw Error('Check the skill ID or prerequisite for ' + id + '.');
      visited.add(id);
      path.unshift(node);
      id = node.parent;
    }
    return path;
  }

  const options = [];
  if (mode === 'custom') {
    for (const id of preferences[stage.key + 'Ids']) {
      const map = maps.get(id[0]);
      if (!map || !unlocked(map, account)) continue;
      const path = missingPath(map, id);
      if (path.length && path.length <= account.skillPoints) return { skill: path[0], goal: path.at(-1) };
    }
    return null;
  }

  for (const [prefix, map] of maps) {
    if (!unlocked(map, account)) continue;
    const tier = MILESTONES.findIndex(item => item.maps.includes(prefix));
    for (const node of map.skills.values()) {
      if (!(node.frequency || node.price)) continue;
      const path = missingPath(map, node.id);
      if (!path.length || path.length > account.skillPoints) continue;
      const gain = path.reduce((total, value) => total + (mode === 'value'
        ? value.price + value.frequency / 20 : value.frequency + value.price / 20), 0);
      const cost = path.reduce((total, value) => total + value.cost, 0);
      const score = gain / path.length / (1 + Math.log10(1 + cost) / 5);
      options.push({ skill: path[0], goal: node, tier, score });
    }
  }
  return options.sort((a, b) => b.tier - a.tier || b.score - a.score || a.skill.cost - b.skill.cost)[0] || null;
}

function planCases(catalog, owned, account, options, reserved) {
  const stock = new Map(owned.map(item => [item._id, item.amount]));
  const openRoom = whole(account.inventorySize) && whole(account.inventoryCount)
    ? Math.max(0, account.inventorySize - account.inventoryCount) : 0;
  if (!openRoom) return { wait: 'Inventory needs space.' };
  // Leave room for rank/XP to be rechecked between batches and avoid excess stock purchases.
  const batch = Math.min(openRoom, 10, Math.max(1, Math.floor(account.caseOpenCount || 1)));
  const choices = catalog.filter(item => item.rank <= idOf(account.rank) &&
    (options.case === 'cheapest' || item.id === options.case));
  if (!choices.length) return { wait: 'Waiting for the chosen case to unlock.' };
  const inStock = choices.find(item => whole(stock.get(item.id)) && stock.get(item.id) > 0 &&
    (options.case !== 'cheapest' || !options.caseMax || cents(item.price) <= cents(options.caseMax)));
  if (inStock) return { kind: 'open', item: inStock, count: Math.min(batch, stock.get(inStock.id)) };
  const buy = choices.find(item => item.buyable && cents(item.price) <= cents(options.caseMax));
  if (!buy) return { wait: 'Waiting for owned cases or a case within the price limit.' };
  const available = Math.max(0, cents(account.money) - cents(options.keepCash) - cents(reserved));
  const count = Math.min(batch, Math.floor(available / cents(buy.price)));
  if (!count) return { wait: reserved ? 'Saving for the next skill.' : 'Waiting for case money.' };
  return { kind: 'buy', item: buy, count, cost: count * cents(buy.price) / 100 };
}

module.exports = {
  MILESTONES, MAPS, cash, whole, itemId, pageData, parseCatalog, skillMap, milestoneOf,
  customIds, relevantMaps, nextSkill, planCases,
};
