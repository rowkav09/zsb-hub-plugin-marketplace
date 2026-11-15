'use strict';

const { findSkins, LABELS } = require('./inventory');

const MAX_ACTIVE = 6;
const emptyCounters = () => ({ forged: 0, ok: 0, failed: 0, skipped: 0, legendary: 0, unconfirmed: 0 });
const dateKey = () => new Date().toISOString().slice(0, 10);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const displayName = account => account.name || account.id;

function address(ctx, id) {
  const network = ctx.network.state();
  const routeId = network.accounts.find(account => account.id === id)?.route;
  const route = network.routes.find(entry => entry.id === routeId);
  if (!route || route.down) throw Error('Account route unavailable.');
  return { routeId, ip: route.group?.startsWith('ip:') ? route.group : 'Unknown exit IP' };
}

function gate(ctx, lane) {
  const id = lane.account.id;
  if (!ctx.settings.runsOn('accounts', id) || !ctx.accounts.get(id)?.healthy) throw Error('The selected account is unavailable.');
  if (ctx.accounts.busy(id) || ctx.accounts.wanted(id)) throw Error('Another plugin needs this account.');
  const current = address(ctx, id);
  if (current.routeId !== lane.address.routeId || current.ip !== lane.address.ip) throw Error('The account changed route. Scan it again.');
}

function readInventory(ctx, lane, config, live, tiers) {
  return findSkins(async path => {
    if (!live()) throw Error('Stopped.');
    gate(ctx, lane);
    const response = await ctx.request(lane.account.id, path, { timeoutMs: 15000, tries: 1 });
    if (!live()) throw Error('Stopped.');
    gate(ctx, lane);
    return response;
  }, config, tiers);
}

function matches(original, current) {
  return !!current && original.label === current.label && original.tracked === current.tracked;
}

async function send(ctx, id, skin) {
  let answer;
  try {
    answer = await ctx.request(id, '/api/inventory/forge', {
      method: 'POST', body: { skinId: skin.id }, timeoutMs: 15000, tries: 1,
    });
  } catch {
    return { category: 'unconfirmed' };
  }
  if (answer?.kind === 'api' && answer.status === 400) return { category: 'skipped', detail: 'Site refused the forge.' };
  if (answer?.kind !== 'ok') return { category: 'unconfirmed' };
  switch (answer.json?.message) {
    case 'Reforge successful.': return { category: 'ok', upgraded: answer.json.skin };
    case 'Reforge failed.': return { category: 'failed' };
    default: return { category: 'unconfirmed' };
  }
}

async function executeLane(ctx, row, batch) {
  const { lane, chosen } = row;
  const { config, live, record } = batch, id = lane.account.id;
  let locked = false;
  try {
    gate(ctx, lane);
    ctx.accounts.setBusy(id, 'Auto Forge');
    locked = true;
    const recheck = tiers => readInventory(ctx, lane, config, live, tiers);
    const initial = new Map((await recheck()).map(item => [item.id, item]));
    const reservedIds = new Set(chosen.map(input => input.skin.id));
    const tried = new Set();
    let nextTime = Date.now();
    for (const { skin, attempts } of chosen) {
      if (!live()) return;
      let candidate = initial.get(skin.id);
      if (!matches(skin, candidate) || candidate.tier !== skin.tier || candidate.value > skin.value) {
        record(lane.account, skin, 'skipped', 'Approved input changed or is no longer eligible.');
        continue;
      }
      for (let remaining = attempts; remaining > 0 && live(); remaining--) {
        if (nextTime > Date.now()) await sleep(nextTime - Date.now());
        if (!live()) return;
        gate(ctx, lane);
        const key = candidate.id + '/' + candidate.tier;
        if (tried.has(key)) break;
        tried.add(key);
        const outcome = await send(ctx, id, candidate);
        nextTime = Date.now() + config.gap;
        const quality = candidate.tier + 1;
        if (outcome.category === 'unconfirmed') batch.halt();
        const message = {
          ok: 'Upgraded to ' + LABELS[quality],
          failed: 'Forge failed.',
          skipped: outcome.detail,
          unconfirmed: 'Unconfirmed. Inspect this account before running another batch.',
        };
        record(lane.account, candidate, outcome.category, message[outcome.category], true, outcome.category === 'ok' && quality === 3);
        if (outcome.category !== 'ok' || remaining === 1 || !live()) break;
        const upgrade = outcome.upgraded;
        if (upgrade?.quality !== quality || typeof upgrade._id !== 'string' || !upgrade._id
          || (upgrade._id !== skin.id && reservedIds.has(upgrade._id))) break;
        const current = (await recheck([quality])).find(item => item.id === upgrade._id);
        if (!matches(skin, current)) {
          record(lane.account, candidate, 'skipped', 'Upgraded item is outside the filters or value limit.');
          break;
        }
        candidate = current;
      }
    }
  } catch (error) {
    if (live()) record(lane.account, chosen[0].skin, 'skipped', error.message);
  } finally {
    if (locked && !batch.closed()) ctx.accounts.setBusy(id, null);
  }
}

async function execute(ctx, plan, callbacks) {
  const counters = emptyCounters();
  const batch = {
    ...callbacks,
    record(account, skin, category, detail, attempted, legendary) {
      if (batch.closed()) return;
      counters[category]++;
      if (attempted) counters.forged++;
      if (legendary) counters.legendary++;
      callbacks.save({ account: displayName(account), label: skin.label, quality: LABELS[skin.tier], detail,
        category, attempted, legendary });
    },
  };
  const exits = new Map();
  for (const row of plan.lanes) {
    if (!row.chosen.length) continue;
    const ip = row.lane.address.ip;
    if (!exits.has(ip)) exits.set(ip, []);
    exits.get(ip).push(row);
  }
  // A wave takes at most the configured lanes from each exit and six globally.
  while (batch.live() && exits.size) {
    const wave = [];
    for (const [ip, rows] of exits) {
      wave.push(...rows.splice(0, Math.min(batch.config.parallel, MAX_ACTIVE - wave.length)));
      if (!rows.length) exits.delete(ip);
      if (wave.length === MAX_ACTIVE) break;
    }
    await Promise.all(wave.map(row => executeLane(ctx, row, batch)));
  }
  return counters;
}

module.exports = { address, dateKey, displayName, emptyCounters, execute, readInventory };
