'use strict';

const { randomUUID } = require('node:crypto');

const TTL = 10 * 60_000;
const money = amount => '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
const sum = items => items.reduce((total, item) => total + item.price, 0);
const integer = (value, max) => Math.max(1, Math.min(max, Math.floor(value) || 1));

function eligible(skin, rules) {
  return skin && typeof skin._id === 'string' && skin._id.length > 0 && skin._id.length <= 128
    && typeof skin.name === 'string' && skin.name.length > 0
    && skin.isFavorite === false && !skin.favorite && !skin.favorited && !skin.isFavourite
    && typeof skin.statTrak === 'boolean' && skin.hasPattern === true && !skin.souvenir && !skin.isSouvenir
    && ['any', skin.statTrak === true ? 'stattrak' : 'normal'].includes(rules.skinType)
    && Number.isInteger(skin.quality) && skin.quality >= 0 && skin.quality <= 2
    && (rules.quality === 'any' || rules.quality === String(skin.quality))
    && Number.isFinite(skin.price) && skin.price >= 0 && skin.price <= rules.maxPrice
    && skin.name.toLowerCase().includes(rules.name);
}

function start(ctx) {
  let preview = null;
  let task = null;
  let stopped = false;
  let last = [];
  let message = '';
  let progress = '';
  const setting = key => ctx.settings.get(key);
  const selected = id => ctx.settings.runsOn('accounts', id);
  const active = () => !stopped && !ctx.stopping && !task?.cancelled;
  const blocker = id => {
    if (!selected(id)) return 'Account selection changed';
    if (!ctx.accounts.get(id)?.healthy) return 'Account is not clicking normally';
    if (ctx.accounts.busy(id) || ctx.accounts.wanted(id)) return 'Another plugin is using this account';
    return '';
  };

  function readRules() {
    const maxPrice = setting('maxPrice');
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw Error('Set a maximum skin value above zero first.');
    return {
      maxPrice,
      name: String(setting('name') || '').trim().toLowerCase().slice(0, 120),
      quality: setting('quality'),
      skinType: setting('skinType'),
      pages: integer(setting('pages'), 25),
      perAccount: integer(setting('perAccount'), 50),
      batchLimit: integer(setting('batchLimit'), 250),
    };
  }

  async function inventory(id, rules) {
    const seen = new Map();
    for (let page = 1; page <= rules.pages && active(); page++) {
      const reason = blocker(id);
      if (reason) throw Error(reason);
      const query = new URLSearchParams({ page, sort: 'price', favoriteSkinsFilter: 'none', showUpgradedSkins: 'true' });
      if (rules.quality !== 'any') query.set('quality', rules.quality);
      if (rules.name) query.set('search', rules.name);
      const result = await ctx.request(id, '/api/inventory?' + query, { timeoutMs: 15000 });
      if (result.kind !== 'ok' || !Array.isArray(result.json?.skins)) {
        throw Error('Inventory unavailable (' + (result.status || result.kind) + ')');
      }
      for (const skin of result.json.skins) {
        if (eligible(skin, rules)) {
          seen.set(skin._id, { id: skin._id, name: skin.name, price: skin.price, quality: skin.quality });
        }
      }
      if (!result.json.skins.length) break;
      if (!Number.isSafeInteger(result.json.pages) || result.json.pages < 1) throw Error('Inventory response has no page count.');
      if (page >= result.json.pages) break;
    }
    return [...seen.values()].sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  }

  async function run(label, action) {
    if (task) return { ok: false, error: 'Wait for the current forge action to finish.' };
    task = { cancelled: false };
    progress = label;
    try {
      message = await action();
      return { message };
    } catch (error) {
      message = error.message;
      return { ok: false, error: message };
    } finally {
      task = null;
      progress = '';
    }
  }

  ctx.panel.action('scan', () => run('Reading farm inventories…', async () => {
    preview = null;
    last = [];
    const rules = readRules();
    const accounts = ctx.accounts.list().filter(account => selected(account.id));
    if (!accounts.length) throw Error('Choose one or more farm accounts.');
    const rows = [];
    for (const account of accounts) {
      if (!active()) return 'Scan stopped.';
      progress = 'Scanning ' + (account.name || account.id) + '…';
      const reason = blocker(account.id);
      const row = { account, options: [], items: [], status: reason };
      rows.push(row);
      if (reason) continue;
      try {
        row.options = (await inventory(account.id, rules)).slice(0, rules.perAccount);
        if (!row.options.length) row.status = 'No eligible skins in scanned pages';
      } catch (error) {
        row.status = error.message;
      }
    }
    if (!active()) return 'Scan stopped.';
    // Give each farm account a place in the batch before filling additional slots.
    let count = 0;
    for (let index = 0; index < rules.perAccount && count < rules.batchLimit; index++) {
      for (const row of rows) {
        if (count === rules.batchLimit) break;
        if (row.options[index]) {
          row.items.push(row.options[index]);
          count++;
        }
      }
    }
    for (const row of rows) {
      if (row.options.length && !row.items.length) row.status = 'Batch cap reached';
    }
    preview = { id: randomUUID(), at: Date.now(), rules, rows, count };
    return 'Preview ready. ' + count + ' selected skin(s).';
  }));

  ctx.panel.action('forge', id => run('Preparing forge batch…', async () => {
    const plan = preview;
    if (!plan || plan.id !== id || !plan.count || Date.now() - plan.at > TTL) {
      throw Error('Scan again for a fresh preview.');
    }
    preview = null;
    const totals = { attempted: 0, succeeded: 0, failed: 0, uncertain: 0 };
    for (const { account, items } of plan.rows) {
      if (!active() || totals.uncertain) break;
      if (!items.length) continue;
      const aid = account.id;
      const name = account.name || aid;
      const reason = blocker(aid);
      if (reason) {
        last.push([name, '—', reason]);
        continue;
      }
      ctx.accounts.setBusy(aid, 'Forge Queue');
      try {
        progress = 'Rechecking ' + name + '…';
        const current = new Map((await inventory(aid, plan.rules)).map(item => [item.id, item]));
        for (const item of items) {
          if (!active()) break;
          const reason = blocker(aid);
          if (reason) {
            last.push([name, '—', reason]);
            break;
          }
          const refreshed = current.get(item.id);
          if (!refreshed || refreshed.quality !== item.quality || refreshed.price > item.price) {
            last.push([name, item.name, 'Skipped · item changed or is no longer eligible']);
            continue;
          }
          progress = 'Forging on ' + name + '…';
          totals.attempted++;
          // Forge can change or consume the skin. Send the request once.
          let result;
          try {
            result = await ctx.request(aid, '/api/inventory/forge', {
              method: 'POST', body: { skinId: item.id }, tries: 1, timeoutMs: 15000,
            });
          } catch {
            result = { kind: 'unknown' };
          }
          const outcome = result.json?.message;
          if (result.kind === 'ok' && outcome === 'Reforge successful.') {
            totals.succeeded++;
            last.push([name, item.name, 'Forged']);
          } else if (result.kind === 'ok' && outcome === 'Reforge failed.') {
            totals.failed++;
            last.push([name, item.name, 'Forge failed']);
          } else if (result.kind === 'api' && result.status === 400) {
            totals.failed++;
            last.push([name, item.name, 'Refused · HTTP 400']);
            break;
          } else {
            totals.uncertain++;
            last.push([name, item.name, 'Result unconfirmed · inspect inventory before retrying']);
            break;
          }
        }
      } catch (error) {
        last.push([name, '—', error.message]);
      } finally {
        ctx.accounts.setBusy(aid, null);
      }
    }
    const summary = totals.attempted + ' attempted · ' + totals.succeeded + ' forged · ' + totals.failed + ' failed'
      + ' · ' + totals.uncertain + ' unconfirmed · ' + (plan.count - totals.attempted) + ' skipped or left in the preview';
    ctx.log(summary, totals.uncertain ? 'warn' : 'info');
    return summary;
  }));

  ctx.panel.action('stop', () => {
    if (task) task.cancelled = true;
    return { message: 'Stopping after the current request.' };
  });
  ctx.settings.onChange(() => {
    preview = null;
    if (task) task.cancelled = true;
  });

  ctx.panel.tab('Forge Queue', () => {
    const blocks = [
      { type: 'settings', keys: ['accounts', 'name', 'quality', 'skinType', 'maxPrice', 'perAccount', 'batchLimit', 'pages'] },
      { type: 'buttons', items: [task
        ? { label: 'Stop', action: 'stop', danger: true }
        : { label: 'Scan inventories', action: 'scan', primary: true }] },
    ];
    if (progress || message) blocks.push({ type: 'notice', text: progress || message });
    if (preview) {
      const items = preview.rows.flatMap(row => row.items);
      blocks.push({
        type: 'stats', items: [
          { label: 'Accounts ready', value: preview.rows.filter(row => row.items.length).length },
          { label: 'Forge attempts', value: preview.count },
          { label: 'Input skin value', value: money(sum(items)) },
        ],
      }, {
        type: 'table', columns: ['Account', 'Status', 'Skins', 'Input value'],
        rows: preview.rows.map(row => [row.account.name || row.account.id, row.status || 'Ready', row.items.length, money(sum(row.items))]),
      }, {
        type: 'card', id: 'forge-preview', title: 'Skins in this batch', open: false,
        blocks: [{
          type: 'table', columns: ['Account', 'Skin', 'Quality', 'Value'],
          rows: preview.rows.flatMap(row => row.items.map(item => [row.account.name || row.account.id, item.name, item.quality, money(item.price)])),
        }],
      });
      if (!task && preview.count && Date.now() - preview.at <= TTL) {
        blocks.push({ type: 'buttons', items: [{
          label: 'Forge previewed skins', action: 'forge', arg: preview.id, primary: true,
          confirm: 'Attempt to forge ' + preview.count + ' skins worth ' + money(sum(items)) + '? Forging changes or can consume the input skin.',
        }] });
      }
    }
    if (last.length) blocks.push({ type: 'table', columns: ['Account', 'Skin', 'Result'], rows: last });
    return { blocks };
  });

  return () => { stopped = true; };
}

let cleanup;
module.exports = {
  start(ctx) { cleanup = start(ctx); },
  stop() { cleanup?.(); },
  eligible,
};
