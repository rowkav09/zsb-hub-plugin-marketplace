'use strict';

const PRESETS = require('./presets.json');
const MAPS = {
  a: { name: 'Dust II', path: 'de_dust_2' },
  b: { name: 'Mirage', path: 'Mirage' },
  c: { name: 'Inferno', path: 'Inferno' },
  d: { name: 'Ancient', path: 'Ancient' },
  e: { name: 'Anubis', path: 'Anubis' },
  f: { name: 'Cobblestone', path: 'Cobblestone' },
};
const validId = value => typeof value === 'string' && /^[a-f]\d{1,4}$/.test(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const cash = value => Number.isFinite(value) && value >= 0;
const rankId = rank => rank?.id ?? rank;

function presetIds(key, custom) {
  if (Object.hasOwn(PRESETS, key)) return PRESETS[key];
  if (key !== 'custom') throw Error('Choose a build.');
  const list = [...new Set(String(custom || '').toLowerCase().split(/[\s,]+/).filter(Boolean))];
  if (!list.length || list.length > 250 || list.some(id => !validId(id))) {
    throw Error('Enter up to 250 valid skill IDs, such as a1 or f27.');
  }
  return list;
}

function parseMap(body, map) {
  if (typeof body !== 'string' || body.length > 10_000_000) throw Error(map.name + ': invalid skillmap page');
  const match = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(body);
  if (!match) throw Error(map.name + ': skillmap data unavailable');
  const props = JSON.parse(match[1]).props?.pageProps;
  const unpack = value => typeof value === 'string' ? JSON.parse(value) : value;
  const raw = unpack(props?.skillmap);
  const owned = unpack(props?.skillIds);
  const rank = raw?.requiredRankId ?? null;
  const premier = raw?.requiredPremierId ?? null;
  if (!Array.isArray(raw?.skills) || !raw.skills.length || raw.skills.length > 1000
    || !Array.isArray(owned) || owned.length > 2000 || owned.some(id => !validId(id))
    || (rank === null && premier === null) || (rank !== null && !whole(rank)) || (premier !== null && !whole(premier))) {
    throw Error(map.name + ': invalid skillmap or ownership data');
  }
  const skills = new Map();
  for (const node of raw.skills) {
    if (!validId(node?.id) || !cash(node.cost) || (node.requiredPrevSkillId !== null && !validId(node.requiredPrevSkillId))
      || skills.has(node.id)) throw Error(map.name + ': invalid skill definition');
    skills.set(node.id, {
      id: node.id, cost: node.cost, parent: node.requiredPrevSkillId,
      name: typeof node.name === 'string' ? node.name : node.id,
      map: map.name, rank, premier,
    });
  }
  return { skills, owned: new Set(owned.filter(id => skills.has(id))) };
}

async function snapshot(ids, get) {
  const maps = [...new Set(ids.map(id => id[0]))];
  const skills = new Map();
  const owned = new Set();
  for (const prefix of maps) {
    const map = MAPS[prefix];
    const { body } = await get('/skillmaps/' + encodeURIComponent(map.path));
    const state = parseMap(body, map);
    for (const [id, skill] of state.skills) {
      if (id[0] !== prefix) throw Error(map.name + ': found a skill from a different map');
      skills.set(id, skill);
    }
    for (const id of state.owned) owned.add(id);
  }
  const { json: account } = await get('/api/me');
  if (!cash(account?.money) || !whole(account.skillPoints)) throw Error('Current balance or skill points are unavailable.');
  return { skills, owned, account };
}

function purchasePlan(ids, state, rules) {
  const { skills, owned, account } = state;
  const budget = Math.min(rules.maxSpend, Math.max(0, account.money - rules.cashReserve));
  const pointBudget = Math.min(account.skillPoints, rules.maxPoints);
  const rank = rankId(account.rank);
  const premier = rankId(account.premierRank);
  const chosen = new Set(owned);
  const steps = [];
  let total = 0;
  let blocked = 0;
  let limited = 0;

  function pathTo(id, visiting = new Set()) {
    if (chosen.has(id)) return [];
    const skill = skills.get(id);
    if (!skill || visiting.has(id)) throw Error('Missing or cyclic prerequisite for ' + id);
    if ((skill.rank !== null && (!whole(rank) || rank < skill.rank))
      || (skill.premier !== null && skill.premier > 0 && (!whole(premier) || premier < skill.premier))) return null;
    visiting.add(id);
    const path = skill.parent ? pathTo(skill.parent, visiting) : [];
    return path && [...path, skill];
  }

  for (const id of ids) {
    const path = pathTo(id);
    if (!path) {
      blocked++;
      continue;
    }
    const cost = path.reduce((sum, skill) => sum + skill.cost, 0);
    if (steps.length + path.length > pointBudget || total + cost > budget) {
      limited++;
      continue;
    }
    for (const skill of path) {
      steps.push(skill);
      chosen.add(skill.id);
    }
    total += cost;
  }

  const pending = ids.filter(id => !chosen.has(id)).length;
  if (!rules.fit && pending) return { steps: [], total: 0, pending, blocked, limited, complete: false };
  return { steps, total, pending, blocked, limited, complete: pending === 0 };
}

module.exports = { MAPS, parseMap, presetIds, purchasePlan, snapshot };
