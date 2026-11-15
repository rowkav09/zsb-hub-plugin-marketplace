'use strict';

const { bounded, createBatch, favorite, idOk, Unconfirmed } = require('./farm-batch');

const STORAGE = '/api/inventory/storageUnits';
const CAPACITY = 1000;
const RARITIES = ['Consumer Grade', 'Industrial Grade', 'Mil-Spec Grade', 'Restricted', 'Classified', 'Covert'];
const named = item => String(item.name || item._id);
const text = value => typeof value === 'string' ? value.trim() : '';
const fold = value => text(value).toLowerCase();

function compile(rules) {
  if (!Array.isArray(rules) || !rules.length) throw Error('Add at least one storage rule.');
  return rules.map((rule, index) => {
    const kind = rule.kind;
    const match = text(rule.match);
    const unit = text(rule.unit);
    if (!unit || !['fade', 'rank1', 'rank10', 'pattern', 'name', 'rarity', 'favourite'].includes(kind)
      || (['pattern', 'name', 'rarity'].includes(kind) && !match)) {
      throw Error('Fill in the match and storage unit for rule ' + (index + 1) + '.');
    }
    if (kind === 'rarity' && !RARITIES.includes(match)) throw Error('Use the exact inventory rarity label in rule ' + (index + 1) + '.');
    return { ...rule, kind, match, unit, index, priority: bounded(rule.priority, 1, 999, 10) };
  }).sort((a, b) => a.priority - b.priority || a.index - b.index);
}

function unitsOf(body) {
  if (!Array.isArray(body)) throw Error('Storage unit list unavailable.');
  return body.filter(unit => idOk(unit?._id) && unit.name && Number.isSafeInteger(unit.skinCount) && unit.skinCount >= 0);
}

function destination(units, rule) {
  const matches = units.filter(unit => fold(unit.name) === fold(rule.unit));
  return matches.length === 1 ? matches[0] : null;
}

function criteria(rule) {
  switch (rule.kind) {
    case 'rank1':
    case 'rank10': return { filterFloatRanks: 'all', sort: 'rank' };
    case 'fade': return { patterns: '100% Fade' };
    case 'pattern': return { patterns: rule.match };
    case 'name': return { search: rule.match };
    case 'rarity': return { rarity: rule.match };
    case 'favourite': return { favoriteSkinsFilter: 'only' };
  }
}

function rankMatch(ranks, limit) {
  if (!ranks || typeof ranks !== 'object' || Array.isArray(ranks)) return false;
  return Object.values(ranks).some(rank => Number.isSafeInteger(rank) && rank >= 1 && rank <= limit);
}

function matchesFlag(item, rule) {
  if (item.isTerminal || item.isSticker || item.isKeychain) return false;
  if (rule.kind === 'name') return fold(item.name).includes(fold(rule.match));
  if (rule.kind === 'favourite') return favorite(item);
  if (rule.kind === 'rank1' || rule.kind === 'rank10') return rankMatch(item.floatRanks, rule.kind === 'rank1' ? 1 : 10);
  // Pattern and rarity use the exact labels accepted by the site's inventory filters.
  return true;
}

async function scan(api) {
  const rules = compile(api.get('rules'));
  const accounts = api.selected('accounts');
  if (!accounts.length) throw Error('Select farm accounts.');
  const jobs = [], rows = [], notes = [];
  const pages = bounded(api.get('pages'), 1, 20, 3);
  const limit = bounded(api.get('items'), 1, 100, 20);
  for (const account of accounts) {
    const { id, name } = account;
    const route = api.route(id);
    try {
      const units = unitsOf(await api.read(id, route, STORAGE));
      const room = new Map(units.map(unit => [unit._id, Math.max(0, CAPACITY - unit.skinCount)]));
      const seen = new Set();
      let patternNames;
      let planned = 0;
      for (const rule of rules.filter(rule => !rule.account || rule.account === id)) {
        if (planned === limit) break;
        const unit = destination(units, rule);
        if (rule.kind === 'pattern' || rule.kind === 'fade') {
          if (!patternNames) {
            const names = await api.read(id, route, '/api/patternNames');
            if (!Array.isArray(names)) throw Error('The site pattern list is unavailable.');
            patternNames = new Set(names);
          }
          const pattern = rule.kind === 'fade' ? '100% Fade' : rule.match;
          if (!patternNames.has(pattern)) {
            notes.push([name, 'Rule ' + rule.priority + ' · unknown pattern "' + pattern + '".']);
            break;
          }
        }
        const found = await api.inventory(id, route, pages, criteria(rule));
        const items = [];
        for (const item of found.items) {
          if (seen.has(item._id) || !matchesFlag(item, rule)) continue;
          seen.add(item._id);
          if (!unit || !room.get(unit._id) || planned === limit) continue;
          room.set(unit._id, room.get(unit._id) - 1);
          items.push({ id: item._id, name: named(item), label: item.name });
          rows.push([name, named(item), unit.name, rule.priority]);
          planned++;
        }
        if (!unit) notes.push([name, 'Priority ' + rule.priority + ' · missing or duplicate storage name "' + rule.unit + '".']);
        if (!found.complete) notes.push([name, 'Priority ' + rule.priority + ' · scan reached the page cap.']);
        if (items.length) jobs.push({ id, route, rule, unit: unit._id, items, result: [name, unit.name] });
      }
    } catch (error) {
      notes.push([name, error.message]);
    }
  }
  return { jobs, rows, notes, pages };
}

async function apply(api, job, plan) {
  return api.lock([[job.id, job.route]], async () => {
    const { id, route, rule } = job;
    const units = unitsOf(await api.read(id, route, STORAGE));
    const unit = destination(units, rule);
    if (!unit || unit._id !== job.unit || unit.skinCount >= CAPACITY) return 'Storage full, renamed or unavailable.';
    const lookup = await api.inventory(id, route, plan.pages, criteria(rule));
    const candidates = new Map(lookup.items.filter(skin => matchesFlag(skin, rule)).map(skin => [skin._id, skin]));
    const move = [];
    for (const item of job.items) {
      if (move.length >= CAPACITY - unit.skinCount) break;
      if (!candidates.has(item.id) || named(candidates.get(item.id)) !== item.name) continue;
      if (rule.kind === 'rank1' || rule.kind === 'rank10') {
        const live = await api.read(id, route, '/api/inventory/skin/rank?skinId=' + encodeURIComponent(item.id));
        if (!rankMatch(live?.floatRanks, rule.kind === 'rank1' ? 1 : 10)) continue;
      }
      move.push(item);
    }
    if (!move.length) return 'No previewed skins still qualify.';
    for (const skin of move) {
      // Verify the exact ID in the destination, including when the site refuses a repeat.
      await api.write(id, route, STORAGE + '/skins', 'POST', { storageUnitId: unit._id, skinIds: [skin.id] });
      try {
        const stored = await api.inventory(id, route, 12, { id: unit._id, ...(skin.label ? { search: skin.label } : {}) }, STORAGE + '/skins');
        if (!stored.items.some(item => item._id === skin.id)) throw Error('Skin absent from unit.');
      } catch {
        throw new Unconfirmed('Storage move unconfirmed for ' + skin.name + '. Check ' + unit.name + '.');
      }
    }
    return move.length + ' stored · ' + (job.items.length - move.length) + ' skipped.';
  });
}

const spec = {
  title: 'Auto Sort SU', tab: 'Storage Sort',
  keys: ['runMode', 'on', 'accounts', 'rules', 'items', 'pages', 'minutes'],
  columns: ['Account', 'Skin', 'Storage unit', 'Priority'],
  resultColumns: ['Account', 'Storage unit'],
  applyLabel: 'Sort previewed skins',
  confirm: plan => 'Move ' + plan.rows.length + ' skins into the shown storage units?',
  scan, apply,
};

let stop;
module.exports = { start(ctx) { stop = createBatch(ctx, spec); }, stop() { stop?.(); } };
