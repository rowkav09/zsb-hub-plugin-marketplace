'use strict';

const BUNDLE_SIZE = 10;

// Case Clicker's Fever odds and Perfect World's disclosed Armory skin-collection model.
const CASE = { 'Mil-Spec Grade': .7992, Restricted: .1598, Classified: .032, Covert: .0064 };
const ARMORY = { 'Industrial Grade': .80026, 'Mil-Spec Grade': .16005, Restricted: .03201, Classified: .0064, Covert: .00128 };
const COLLECTIONS = new Set([
  'The Arabesque Collection', 'The Spy Tech Collection', 'The Overpass 2024 Collection',
  'The Graphic Design Collection', 'The Sport & Field Collection',
]);

function model(item, groups) {
  const tiers = item.type === 'case' ? CASE : COLLECTIONS.has(item.name) ? ARMORY : null;
  if (!tiers || groups.some(group => !Object.hasOwn(tiers, group.rarity))) return null;
  const counts = new Map();
  for (const { rarity } of groups) counts.set(rarity, (counts.get(rarity) || 0) + 1);
  if (counts.size !== Object.keys(tiers).length) return null;
  return groups.map(group => ({ id: group._id, chance: tiers[group.rarity] / counts.get(group.rarity) }));
}

function expectedCredits(skins, owned, price) {
  const histogram = new Map();
  for (const { chance } of skins) histogram.set(chance, (histogram.get(chance) || 0) + 1);
  const tiers = [...histogram];
  let expected = 0;
  // Tail sum over bundles. Inclusion-exclusion handles duplicate drops and groups
  // skins with the same chance to avoid enumerating every subset of individual skins.
  function addSubsets(index, probability, coefficient) {
    if (index === tiers.length) {
      if (!probability) return;
      const miss = Math.log1p(-Math.min(1, probability));
      const afterOwned = owned ? Math.exp(owned * miss) : 1;
      expected -= coefficient * afterOwned / -Math.expm1(BUNDLE_SIZE * miss);
      return;
    }
    const [chance, count] = tiers[index];
    let ways = 1;
    for (let use = 0; use <= count; use++) {
      addSubsets(index + 1, probability + use * chance, coefficient * ways);
      ways *= -(count - use) / (use + 1);
    }
  }
  addSubsets(0, 0, 1);
  return Math.max(0, expected) * price;
}

module.exports = { model, expectedCredits };
