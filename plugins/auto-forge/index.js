'use strict';

const { randomUUID } = require('node:crypto');
const { allocate, configuration, formatValue, LABELS, MAX_SCAN_AGE, picker } = require('./inventory');
const { address, dateKey, displayName, emptyCounters, execute, readInventory } = require('./execution');

const RESULT_LIMIT = 100;
const SETTINGS = ['accounts', 'target', 'type', 'maxPrice', 'perAccount', 'batchLimit', 'perIp', 'delay', 'pages'];

function open(ctx) {
  const previous = ctx.data.get() || {};
  let journal = {
    day: dateKey(),
    today: { ...emptyCounters(), ...(previous.day === dateKey() ? previous.today : {}) },
    recent: Array.isArray(previous.recent) ? previous.recent.slice(0, RESULT_LIMIT) : [],
    pending: previous.pending === true,
  };
  let snapshot, approval, operation, notice;
  let disabled = false;
  const closed = () => disabled || ctx.stopping;
  const live = () => !closed() && operation?.stopping !== true;
  const read = key => ctx.settings.get(key);
  const selectedNames = () => {
    const value = read('skins');
    return Array.isArray(value) ? value.filter(name => typeof name === 'string' && !!name.trim()).map(name => name.trim()) : [];
  };
  const fresh = () => snapshot && Date.now() - snapshot.time <= MAX_SCAN_AGE;

  function clear() { approval = snapshot = undefined; }

  function refreshApproval() {
    approval = fresh() ? {
      token: randomUUID(),
      ...allocate(snapshot, new Set(selectedNames().map(name => name.toLowerCase()))),
    } : undefined;
  }

  function save() { ctx.data.set(journal); }

  if (!previous.day) save();

  function rollDay() {
    if (journal.day !== dateKey()) journal = { ...journal, day: dateKey(), today: emptyCounters() };
  }

  function record(outcome) {
    if (closed()) return;
    rollDay();
    journal.today[outcome.category]++;
    if (outcome.attempted) journal.today.forged++;
    if (outcome.legendary) journal.today.legendary++;
    journal.recent.unshift([outcome.account, outcome.label, outcome.quality, outcome.detail]);
    journal.recent = journal.recent.slice(0, RESULT_LIMIT);
    try { save(); } catch {
      operation.stopping = true;
      operation.review = true;
    }
  }

  async function doAction(label, fn) {
    if (operation) return { ok: false, error: 'Wait for the current operation to finish.' };
    operation = { label, stopping: false, review: false };
    try {
      notice = await fn();
      return { ok: true, message: notice };
    } catch (error) {
      notice = error.message;
      return { ok: false, error: notice };
    } finally {
      operation = undefined;
    }
  }

  ctx.panel.action('scan', () => doAction('Scanning inventory…', async () => {
    clear();
    const config = configuration(read);
    const accounts = ctx.accounts.list().filter(account => ctx.settings.runsOn('accounts', account.id));
    if (!accounts.length) throw Error('Choose at least one farm account.');
    const lanes = [];
    for (const account of accounts) {
      const lane = { account, skins: [], status: '' };
      lanes.push(lane);
      if (!live()) return 'Scan stopped.';
      try {
        lane.address = address(ctx, account.id);
        lane.skins = await readInventory(ctx, lane, config, live);
        if (!lane.skins.length) lane.status = 'No eligible skins found.';
      } catch (error) {
        lane.status = error.message;
      }
    }
    if (!live()) return 'Scan stopped.';
    snapshot = { config, lanes, time: Date.now() };
    refreshApproval();
    return 'Choose skin names or inspect the proposed batch.';
  }));

  ctx.panel.action('pick', id => {
    if (operation || !fresh()) return { ok: false, error: 'Scan before picking names.' };
    const names = selectedNames();
    const match = picker(snapshot, names).find(item => item.id === id);
    if (!match || (!match.on && names.length >= 20)) return { ok: false, error: 'Choose up to 20 names from the scan.' };
    return ctx.settings.set('skins', match.on ? names.filter(name => name.toLowerCase() !== id) : [...names, match.title]);
  });

  ctx.panel.action('forge', id => doAction('Forging confirmed inputs…', async () => {
    if (journal.pending) throw Error('Acknowledge review of the previous batch first.');
    if (!fresh() || !approval?.attempts || approval.token !== id) throw Error('Run a fresh preview before forging.');
    const { config } = snapshot;
    const plan = approval;
    clear();
    journal.pending = true;
    save();
    const results = await execute(ctx, plan, {
      config, closed, live,
      halt() { operation.stopping = operation.review = true; },
      save: record,
    });
    if (!closed() && !operation.review) {
      journal.pending = false;
      save();
    }
    const summary = results.forged + ' attempted · ' + results.ok + ' successful · ' + results.failed + ' failed · '
      + results.skipped + ' skipped · ' + results.legendary + ' reached Legendary · ' + results.unconfirmed + ' unconfirmed';
    ctx.log(summary, results.unconfirmed ? 'warn' : 'info');
    return summary + (operation.stopping ? '. Batch stopped.' : '.');
  }));

  ctx.panel.action('stop', () => {
    if (operation) operation.stopping = true;
    return { ok: true, message: 'Stopping after in-flight requests.' };
  });

  ctx.panel.action('review', () => {
    if (operation) return { ok: false, error: 'The current operation is still running.' };
    journal.pending = false;
    save();
    clear();
    return { ok: true, message: 'Review acknowledged. Scan before forging again.' };
  });

  ctx.settings.onChange(key => {
    if (operation) operation.stopping = true;
    if (key === 'skins' && !operation) refreshApproval();
    else clear();
  });

  ctx.panel.tab('Forge', () => {
    rollDay();
    const blocks = [
      { type: 'settings', keys: SETTINGS },
      { type: 'buttons', items: operation ? [{ label: 'Stop', action: 'stop', danger: true }]
        : [{ label: 'Scan inventories', action: 'scan', primary: true }] },
      { type: 'stats', items: [
        { label: 'Attempts today', value: journal.today.forged }, { label: 'Successful', value: journal.today.ok },
        { label: 'Failed', value: journal.today.failed }, { label: 'Reached Legendary', value: journal.today.legendary },
      ] },
    ];
    if (operation || notice) blocks.push({ type: 'notice', text: operation?.label || notice });
    if (journal.pending && !operation) {
      blocks.push({ type: 'notice', text: 'Check the previous batch in-game before forging again.' }, {
        type: 'buttons', items: [{ label: 'Acknowledge review', action: 'review', confirm: 'Have you checked what happened to the previous batch?' }],
      });
    }
    blocks.push({ type: 'card', id: 'skins', title: 'Skin names', open: false, keys: ['skins'],
      blocks: fresh() ? [{ type: 'picker', multi: true, action: 'pick', items: picker(snapshot, selectedNames()) }] : [] });
    if (approval && fresh()) {
      const detail = approval.lanes.flatMap(row => row.chosen.map(({ skin, attempts }) =>
        [displayName(row.lane.account), skin.label, LABELS[skin.tier], formatValue(skin.value), attempts]));
      const value = approval.lanes.reduce((total, row) => total + row.chosen.reduce((sum, entry) => sum + entry.skin.value, 0), 0);
      blocks.push({ type: 'table', columns: ['Account', 'Status', 'Inputs', 'Attempts'],
        rows: approval.lanes.map(row => [displayName(row.lane.account), row.lane.status ||
          (row.chosen.length ? 'Ready' : row.ready.length ? 'Batch cap reached' : 'No matching names'), row.chosen.length, row.reserved]) },
      { type: 'card', id: 'forge-preview', title: 'Skins in this batch', open: false,
        blocks: [{ type: 'table', columns: ['Account', 'Skin', 'Quality', 'Starting value', 'Max attempts'], rows: detail }] });
      if (!operation && !journal.pending && approval.attempts) {
        blocks.push({ type: 'buttons', items: [{ label: 'Forge previewed skins', action: 'forge', arg: approval.token, primary: true,
          confirm: 'Approve up to ' + approval.attempts + ' attempts for ' + detail.length + ' skins starting at '
            + formatValue(value) + ' combined? Forging can consume skins.',
        }] });
      }
    }
    if (journal.recent.length) blocks.push({ type: 'card', id: 'recent', title: 'Recent forges', open: false,
      blocks: [{ type: 'table', columns: ['Account', 'Skin', 'Quality', 'Result'], rows: journal.recent }] });
    return { blocks };
  });

  return () => { disabled = true; };
}

let close;
module.exports = { start(ctx) { close = open(ctx); }, stop() { close?.(); } };
