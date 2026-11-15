'use strict';

const { randomUUID } = require('node:crypto');
const TTL = 10 * 60_000;
const idOk = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const favorite = item => item?.isFavorite === true || item?.favorite === true || item?.favorited === true || item?.isFavourite === true;
const notFavorite = item => item?.isFavorite === false && !favorite(item);
const bounded = (value, minimum, maximum, fallback = minimum) =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
const availablePrice = (item, max) => Number.isFinite(item?.price) && item.price >= 0 && item.price <= max;
const money = value => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });

class Unconfirmed extends Error {}

function createBatch(ctx, spec) {
  let preview;
  let task;
  let stopped = false;
  let nextRun = Date.now() + 60_000;
  let notice = '';
  let results = [];
  let needsReview = !!ctx.data.get()?.needsReview;
  const get = key => ctx.settings.get(key);
  const healthy = id => !!ctx.accounts.get(id)?.healthy;
  const selected = key => ctx.accounts.list().filter(account => ctx.settings.runsOn(key, account.id));
  const route = id => ctx.network.state().accounts.find(account => account.id === id)?.route;
  const account = id => ctx.accounts.get(id);
  const active = () => !stopped && !ctx.stopping && !task?.cancelled;

  function requireRunning() {
    if (!active()) throw Error('Stopped.');
  }

  function check(id, expected) {
    requireRunning();
    if (!healthy(id)) throw Error('Account is not clicking normally.');
    if (!expected || route(id) !== expected) throw Error('Account route unavailable or changed.');
    if (ctx.accounts.busy(id) || ctx.accounts.wanted(id)) throw Error('Another plugin is using this account.');
  }

  async function request(id, expected, pathname, opts = {}) {
    check(id, expected);
    const result = await ctx.request(id, pathname, { ...opts, tries: 1, timeoutMs: 15000 });
    requireRunning();
    if (route(id) !== expected) throw Error('Account route changed during the request.');
    return result;
  }

  async function read(id, expected, pathname) {
    const result = await request(id, expected, pathname);
    if (result?.kind !== 'ok') throw Error(pathname.split('?')[0] + ' unavailable (' + (result?.status || result?.kind || 'no response') + ').');
    return result.json;
  }

  async function write(id, expected, pathname, method, body) {
    check(id, expected);
    let result;
    try {
      result = await request(id, expected, pathname, { method, body });
    } catch {
      throw new Unconfirmed('A site write is unconfirmed. Check the account before continuing.');
    }
    if (result?.kind === 'ok') return result.json ?? {};
    if (result?.kind === 'api' && result.status === 400) return null;
    throw new Unconfirmed('A site write is unconfirmed (' + (result?.status || result?.kind || 'no response') + ').');
  }

  async function inventory(id, expected, maxPages, query = {}, pathname = '/api/inventory') {
    const items = new Map();
    for (let page = 1; page <= maxPages; page++) {
      const filters = new URLSearchParams({ sort: 'price', showUpgradedSkins: 'true', ...query, page });
      const body = await read(id, expected, pathname + '?' + filters);
      if (!Array.isArray(body?.skins)) throw Error('Invalid inventory response.');
      for (const item of body.skins) if (idOk(item?._id)) items.set(item._id, item);
      if (!body.skins.length || (Number.isSafeInteger(body.pages) && page >= body.pages)) {
        return { items: [...items.values()], complete: true };
      }
      if (!Number.isSafeInteger(body.pages) || body.pages < 1) throw Error('Inventory page count unavailable.');
    }
    return { items: [...items.values()], complete: false };
  }

  async function lock(bindings, fn) {
    for (const [id, expected] of bindings) check(id, expected);
    for (const [id] of bindings) ctx.accounts.setBusy(id, spec.title);
    try {
      return await fn();
    } finally {
      if (!stopped && !ctx.stopping) for (const [id] of bindings) ctx.accounts.setBusy(id, null);
    }
  }

  function saveReview(value) {
    ctx.data.set({ needsReview: value });
    needsReview = value;
  }

  function disarm() {
    if (get('on')) ctx.settings.set('on', false);
  }

  const api = { get, selected, account, route, check, request, read, write, inventory, lock, requireRunning,
    socket: (id, expected) => { check(id, expected); return ctx.socket(id); },
  };

  async function run(label, action) {
    if (task) return { ok: false, error: 'Wait for the current operation to finish.' };
    task = { label, cancelled: false };
    try {
      notice = await action();
      return { ok: true, message: notice };
    } catch (error) {
      if (error instanceof Unconfirmed && !stopped && !ctx.stopping) disarm();
      notice = error.message;
      return { ok: false, error: notice };
    } finally {
      task = null;
    }
  }

  async function scan() {
    const plan = await spec.scan(api);
    requireRunning();
    return { ...plan, at: Date.now(), token: randomUUID() };
  }

  async function execute(plan) {
    let done = 0;
    // Leave a review flag on disk during writes so an interrupted run will pause at launch.
    saveReview(true);
    for (const job of plan.jobs) {
      if (!active()) break;
      try {
        const outcome = await spec.apply(api, job, plan);
        results.push([...job.result, outcome]);
        done++;
      } catch (error) {
        results.push([...job.result, error.message]);
        if (error instanceof Unconfirmed) throw error;
      }
    }
    if (!stopped && !ctx.stopping) saveReview(false);
    const summary = done + ' of ' + plan.jobs.length + ' jobs processed.';
    ctx.log(spec.title + ' · ' + summary);
    return summary;
  }

  ctx.panel.action('preview', () => run('Scanning selected accounts…', async () => {
    preview = undefined;
    preview = await scan();
    return preview.jobs.length + ' job(s) ready. Review the preview before applying.';
  }));

  ctx.panel.action('apply', token => run('Applying approved jobs…', async () => {
    if (needsReview) throw Error('Review the previous run before applying.');
    const plan = preview;
    if (!plan || !plan.jobs.length || plan.token !== token || Date.now() - plan.at > TTL) throw Error('Create a fresh preview first.');
    if (ctx.power.practice()) throw Error('Switch Mode to Live, then create a fresh preview.');
    preview = undefined;
    results = [];
    return execute(plan);
  }));

  ctx.panel.action('stop', () => {
    if (task) task.cancelled = true;
    disarm();
    return { ok: true, message: 'Stopping and turning off scheduled runs.' };
  });

  ctx.panel.action('review', () => {
    if (task) return { ok: false, error: 'Wait for the current operation to finish.' };
    saveReview(false);
    preview = undefined;
    return { ok: true, message: 'Review acknowledged. Create a new preview.' };
  });

  ctx.settings.onChange(() => {
    preview = undefined;
    if (task) task.cancelled = true;
    nextRun = Date.now() + 60_000;
  });

  ctx.every(15_000, async () => {
    if (preview && Date.now() - preview.at > TTL) preview = undefined;
    if (task || needsReview || preview?.jobs.length || !ctx.power.live() || Date.now() < nextRun) return;
    nextRun = Date.now() + bounded(get('minutes'), 5, 240, 30) * 60_000;
    await run('Scheduled run…', async () => {
      results = [];
      const plan = await scan();
      return plan.jobs.length ? execute(plan) : 'Scheduled scan found no eligible jobs.';
    });
  });

  ctx.panel.tab(spec.tab, () => {
    if (preview && Date.now() - preview.at > TTL) preview = undefined;
    const blocks = [
      { type: 'settings', keys: spec.keys },
      { type: 'buttons', items: task ? [{ label: 'Stop', action: 'stop', danger: true }]
        : [{ label: 'Preview', action: 'preview', primary: true }] },
    ];
    if (task || notice) blocks.push({ type: 'notice', text: task?.label || notice });
    if (needsReview && !task) {
      blocks.push({ type: 'notice', text: 'Review the last operation and check the affected account before continuing.' },
        { type: 'buttons', items: [{ label: 'Acknowledge review', action: 'review', confirm: 'Have you checked the result of the previous operation?' }] });
    }
    if (preview) {
      blocks.push({ type: 'table', columns: spec.columns, rows: preview.rows });
      if (preview.notes.length) blocks.push({ type: 'table', columns: ['Account', 'Status'], rows: preview.notes });
      if (!task && !needsReview && preview.jobs.length && !ctx.power.practice()) blocks.push({
        type: 'buttons', items: [{ label: spec.applyLabel, action: 'apply', arg: preview.token, primary: true, confirm: spec.confirm(preview) }],
      });
    }
    if (results.length) blocks.push({ type: 'table', columns: [...spec.resultColumns, 'Result'], rows: results });
    return { blocks };
  });

  return () => { stopped = true; };
}

module.exports = { availablePrice, bounded, createBatch, favorite, idOk, money, notFavorite, Unconfirmed };
