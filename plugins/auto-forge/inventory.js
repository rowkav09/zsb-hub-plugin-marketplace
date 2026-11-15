'use strict';

const LABELS = ['Common', 'Rare', 'Epic', 'Legendary'];
const MAX_SCAN_AGE = 600_000;
const safeInteger = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
const formatValue = value => '$' + value.toLocaleString('en-GB', { maximumFractionDigits: 2 });

function configuration(read) {
  const cap = read('maxPrice'), mode = read('target'), type = read('type');
  if (!Number.isFinite(cap) || cap <= 0) throw Error('Enter a positive maximum skin value.');
  if (!['0', '1', '2', 'any', 'all'].includes(mode)) throw Error('Select a forge mode.');
  if (!['normal', 'stattrak', 'any'].includes(type)) throw Error('Select a skin type.');
  return {
    cap, mode, type,
    tiers: mode === 'all' || mode === 'any' ? [0, 1, 2] : [Number(mode)],
    accountLimit: safeInteger(read('perAccount'), 1, 50, 5),
    batchLimit: safeInteger(read('batchLimit'), 1, 250, 25),
    parallel: safeInteger(read('perIp'), 1, 6, 1),
    gap: safeInteger(read('delay'), 0, 10000, 600),
    pages: safeInteger(read('pages'), 1, 25, 3),
  };
}

function skinFrom(item, tier, config) {
  if (typeof item?._id !== 'string' || !item._id || item._id.length > 128 || typeof item.name !== 'string' || !item.name
    || item.isFavorite !== false || item.favorite || item.favorited || item.isFavourite || item.souvenir || item.isSouvenir
    || (item.hasPattern !== true && !(item.hasPattern == null && Number.isInteger(item.patternId)))
    || item.quality !== tier || typeof item.statTrak !== 'boolean'
    || !Number.isFinite(item.price) || item.price < 0 || item.price > config.cap) return;
  if (config.type === 'normal' && item.statTrak || config.type === 'stattrak' && !item.statTrak) return;
  return { id: item._id, label: item.name, tier, value: item.price, tracked: item.statTrak };
}

async function findSkins(request, config, tiers = config.tiers) {
  const byId = new Map();
  for (const tier of tiers) {
    for (let page = 1; page <= config.pages; page++) {
      const query = new URLSearchParams({
        page, quality: tier, sort: 'price', favoriteSkinsFilter: 'none', showUpgradedSkins: 'true',
      });
      const response = await request('/api/inventory?' + query);
      if (response?.kind !== 'ok') throw Error('Inventory unavailable (' + (response?.status || response?.kind || 'no reply') + ').');
      const { skins, pages } = response.json || {};
      if (!Array.isArray(skins)) throw Error('Unexpected inventory response.');
      if (skins.length && (!Number.isSafeInteger(pages) || pages < 1)) throw Error('Inventory page count missing.');
      for (const item of skins) {
        const skin = skinFrom(item, tier, config);
        if (skin) byId.set(skin.id, skin);
      }
      if (page >= pages || !skins.length) break;
    }
  }
  return [...byId.values()].sort((a, b) => a.value - b.value || a.id.localeCompare(b.id));
}

function allocate(snapshot, names) {
  const available = snapshot.lanes.map(lane => ({
    lane, ready: lane.skins.filter(skin => !names.size || names.has(skin.label.toLowerCase())), chosen: [], reserved: 0,
  }));
  let room = snapshot.config.batchLimit;
  // Allocate in rounds so a single farm account cannot fill the preview first.
  for (let position = 0; room && position < snapshot.config.accountLimit; position++) {
    for (const row of available) {
      const skin = row.ready[position];
      const free = snapshot.config.accountLimit - row.reserved;
      if (!skin || !free || !room) continue;
      const attempts = Math.min(room, free, snapshot.config.mode === 'all' ? 3 - skin.tier : 1);
      row.chosen.push({ skin, attempts });
      row.reserved += attempts;
      room -= attempts;
    }
  }
  return { lanes: available, attempts: snapshot.config.batchLimit - room };
}

function picker(snapshot, chosenNames) {
  const counts = new Map([...chosenNames].map(label => [label.toLowerCase(), { label, count: 0, on: true }]));
  for (const lane of snapshot.lanes) {
    for (const skin of lane.skins) {
      const key = skin.label.toLowerCase();
      const entry = counts.get(key) || { label: skin.label, count: 0, on: false };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts].sort((a, b) => Number(b[1].on) - Number(a[1].on) || b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 60).map(([id, { label, count, on }]) => ({ id, title: label, on, sub: count + ' eligible' }));
}

module.exports = { allocate, configuration, findSkins, formatValue, LABELS, MAX_SCAN_AGE, picker };
