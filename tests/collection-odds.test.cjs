'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { model, expectedCredits } = require('../plugins/auto-skin-collection/odds');

test('Armory costs account for duplicates, owned cases and bundle rounding', () => {
  const skins = [{ chance: 0.25 }, { chance: 0.25 }];
  const expected = owned => 4 * (2 * .75 ** owned / (1 - .75 ** 10) - .5 ** owned / (1 - .5 ** 10));
  assert(Math.abs(expectedCredits(skins, 0, 4) - expected(0)) < 1e-9);
  assert(Math.abs(expectedCredits(skins, 12, 4) - expected(12)) < 1e-9);
  assert.equal(expectedCredits([], 0, 4), 0);
  assert.equal(expectedCredits([{ chance: 1 }], 1, 4), 0);
});

test('splits the disclosed rarity probability over all skins in that tier', () => {
  const groups = ['Industrial Grade', 'Mil-Spec Grade', 'Restricted', 'Classified', 'Covert', 'Covert']
    .map((rarity, index) => ({ _id: String(index), rarity }));
  const item = { type: 'collectionCase', name: 'The Spy Tech Collection' };
  const chances = model(item, groups);
  assert.equal(chances[4].chance, .00128 / 2);
  assert.equal(chances[5].chance, .00128 / 2);
  assert.equal(model({ ...item, name: 'Unknown odds' }, groups), null);
});
