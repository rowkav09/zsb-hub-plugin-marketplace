const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('../plugins/auto-grind');
const manifest = require('../plugins/auto-grind/plugin.json');
const { milestoneOf, planCases, relevantMaps, nextSkill, skillMap } = require('../plugins/auto-grind/planning');
const { cheapDropIds } = require('../plugins/auto-grind/site');

const caseId = '535346787db930593e69cd6d';
const otherId = '605346787db930593e69cd6d';
const base = { rank: { id: 1 }, premierRating: 1000, premierRank: { id: 1 }, money: 20, skillPoints: 3,
  inventorySize: 100, inventoryCount: 0, caseOpenCount: 10 };
const options = { case: caseId, caseMax: 5, keepCash: 2 };
const catalog = [
  { id: caseId, name: 'Selected Case', price: 3.1, rank: 1, buyable: true },
  { id: otherId, name: 'Other Case', price: 4, rank: 1, buyable: true },
];

function page(props) {
  return '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: props } }) + '</script>';
}
function skillPage(owned, firstCost = 12) {
  return page({
    skillIds: JSON.stringify(owned),
    skillmap: JSON.stringify({ name: 'Dust II', requiredRankId: 1, skills: [
      { id: 'a1', name: 'First', requiredPrevSkillId: null, cost: firstCost, rewards: ['11;2'] },
      { id: 'a2', name: 'Second', requiredPrevSkillId: 'a1', cost: 20, rewards: ['15;2'] },
    ] }),
  });
}

test('case purchases use only cash above the next skill and user reserve, and owned stock opens first', () => {
  assert.deepEqual(planCases(catalog, [], base, options, 12), { kind: 'buy', item: catalog[0], count: 1, cost: 3.1 });
  assert.deepEqual(planCases(catalog, [{ _id: caseId, amount: 2 }], base, options, 100), {
    kind: 'open', item: catalog[0], count: 2,
  });
  assert.match(planCases(catalog, [{ _id: otherId, amount: 10 }], base, options, 16).wait, /Saving/);
  assert.match(planCases(catalog, [], { ...base, inventoryCount: 100 }, options, 0).wait, /Inventory/);
});

test('skill planning applies actual unlocks, points, prerequisites and user priority', () => {
  const prefs = { starter: 'custom', starterIds: ['f1', 'a2'], guardian: 'frequency', global: 'frequency', premier: 'frequency' };
  assert.deepEqual(relevantMaps(milestoneOf(base), prefs, base), ['a']);
  for (const [rank, rating, tier, expected] of [
    [11, 2200, 1, ['c', 'a', 'b']],
    [18, 4999, 1, ['e', 'c', 'd', 'a', 'b']],
    [18, 5000, 2, ['f', 'e', 'c', 'd', 'a', 'b']],
  ]) {
    const me = { rank: { id: rank }, premierRating: rating, premierRank: { id: tier } };
    assert.deepEqual(relevantMaps(milestoneOf(me), prefs, me), expected);
  }
  const maps = new Map([['a', skillMap(skillPage([]), 'a')]]);
  assert.equal(nextSkill(milestoneOf(base), prefs, maps, base).skill.cost, 12);
  assert.equal(nextSkill(milestoneOf(base), prefs, maps, { ...base, skillPoints: 1 }), null);
});

test('optional sales only include common identified drops from the open response', () => {
  const common = { _id: caseId, rarity: 'Mil-Spec Grade', price: 0.5, float: 0.15 };
  assert.deepEqual(cheapDropIds([common, { ...common, _id: otherId, patternName: 'Fade' }], 1), [caseId]);
  assert.deepEqual(cheapDropIds([{ ...common, isFavorite: true }, { ...common, float: 0.0001 }], 1), []);
  assert.deepEqual(cheapDropIds([common], 0), []);
});

function setup(request) {
  const account = { id: 'alt', name: 'Fixture', type: 'money', running: true, healthy: true };
  const settings = Object.fromEntries(Object.entries(manifest.settings).map(([key, spec]) => [key, spec.default]));
  Object.assign(settings, { account: 'alt', case: caseId, starter: 'skip' });
  const actions = {};
  let tick;
  let data = {};
  let autoCalls = 0;
  const ctx = {
    accounts: {
      list: () => [account], get: id => id === account.id ? account : null,
      stats: () => null, setBusy() {}, busy: () => null, wanted: () => null,
    },
    settings: { get: key => settings[key], setOptions() {}, onChange() {} },
    data: { get: () => structuredClone(data), set: value => { data = structuredClone(value); } },
    shared: { get: () => null, set() {} },
    panel: { action: (key, fn) => { actions[key] = fn; }, tab() {}, badge() {} },
    on() {}, every: (_ms, fn) => { tick = fn; }, log() {}, request,
  };
  function start() { return run(ctx, { auto() { autoCalls++; account.type = 'auto'; } }); }
  return { actions, settings, start, tick: () => tick(), data: () => data, autoCalls: () => autoCalls };
}

test('enrollment sets Hub Auto and an ambiguous purchase stays paused across a reload', async () => {
  let posts = 0;
  const fixture = setup(async (_id, route, opts) => {
    if (route === '/api/me') return { kind: 'ok', json: base };
    if (route === '/cases/cases') return { kind: 'ok', body: page({ cases: catalog.map(item => ({
      _id: item.id, name: item.name, price: item.price, rankNeeded: item.rank, isNonBuyable: false,
    })) }) };
    if (route === '/api/cases' && !opts.method) return { kind: 'ok', json: [] };
    if (route === '/api/cases' && opts.method === 'POST') {
      posts++;
      return { kind: 'timeout', status: 0 };
    }
    throw Error('Unexpected request ' + route);
  });
  const stop = fixture.start();
  await fixture.tick();
  assert.equal(fixture.autoCalls(), 0);
  assert.match((await fixture.actions.enroll()).message, /enabled/);
  await fixture.tick();
  assert.equal(fixture.autoCalls(), 1);
  assert.equal(posts, 1);
  assert.match(fixture.data().jobs.alt.pending.label, /Buy/);
  stop();
  fixture.start();
  await fixture.tick();
  assert.equal(posts, 1);
  assert.match(fixture.actions.resume('alt').message, /resumed/);
});
