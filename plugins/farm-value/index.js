'use strict';

const { BrowserWindow } = require('electron');
const { PriceData } = require('./cco-price-data');
const { chartDocument } = require('./chart');

const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const money = value => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const nonnegative = value => Number.isFinite(value) && value >= 0;
const validSample = sample => ['at','inventory','cash','tokens'].every(key => nonnegative(sample?.[key]));

function start(ctx) {
  const prices = new PriceData();
  const data = ctx.data.get();
  let samples = Array.isArray(data?.samples) ? data.samples.filter(validSample).map(({ at, inventory, cash, tokens }) => ({ at, inventory, cash, tokens })) : [];
  let stopped = false, working = false, revision = 0, chart, notice = '', errors = [], status = '';
  let next = Date.now() + 60_000;
  const rate = () => Number(ctx.settings.get('tokensPerDollar'));

  function showChart() {
    if (!samples.length) return { ok: false, message: 'Capture a complete snapshot first.' };
    if (!(rate() > 0) || !Number.isFinite(rate())) return { ok: false, message: 'Choose a positive token conversion.' };
    if (!chart || chart.isDestroyed()) {
      chart = new BrowserWindow({ width: 1040, height: 670, minWidth: 640, minHeight: 490, autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      chart.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      chart.webContents.on('will-navigate', event => event.preventDefault());
    }
    void chart.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(chartDocument(samples, rate()))).catch(() => {});
    chart.show();
    return { message: 'Farm Value history opened.' };
  }

  async function capture() {
    if (working) return { ok: false, message: 'A snapshot is already running.' };
    working = true;
    const run = revision;
    function check() {
      if (stopped || ctx.stopping || run !== revision) throw Error('Snapshot stopped.');
    }
    try {
      const accounts = ctx.accounts.list();
      if (!accounts.length) throw Error('Add the farm accounts to Hub first.');
      errors = [];
      status = 'Loading ChunkyCheese PriceData…';
      await prices.load();
      const totals = { at: Date.now(), inventory: 0, cash: 0, tokens: 0 };
      let position = 0, finished = 0;
      async function worker() {
        while (position < accounts.length) {
          const account = accounts[position++];
          const route = () => ctx.network.state().accounts.find(row => row.id === account.id)?.route;
          const expected = route();
          async function read(path) {
            check();
            if (!expected || route() !== expected) throw Error('Account route unavailable or changed.');
            const reply = await ctx.request(account.id, path, { method: 'GET', tries: 2, timeoutMs: 15000 });
            if (route() !== expected) throw Error('Account route changed.');
            if (reply?.kind !== 'ok') throw Error(path.split('?')[0] + ' · ' + (reply?.status || reply?.kind));
            return reply.json;
          }
          try {
            if (!account.healthy) throw Error('Account is not clicking.');
            const profile = await read('/api/me');
            if (!nonnegative(profile?.money) || !nonnegative(profile?.tokens)) throw Error('Cash or token balance unavailable.');
            const units = await read('/api/inventory/storageUnits');
            if (!Array.isArray(units) || units.some(unit => !validId(unit?._id))) throw Error('Storage units unavailable.');
            const list = new Set();
            let value = 0;
            const scopes = ['/api/inventory?', ...units.filter(unit => unit.skinCount !== 0)
              .map(unit => '/api/inventory/storageUnits/skins?id=' + unit._id + '&')];
            for (const scope of scopes) {
              let pages = 1;
              for (let page = 1; page <= pages; page++) {
                status = 'Reading inventories · ' + finished + '/' + accounts.length + ' accounts done · ' + account.name + ' (' + page + '/' + pages + ')';
                const part = await read(scope + 'showStickers=true&showUpgradedSkins=true&page=' + page);
                if (!Array.isArray(part?.skins) || !Number.isSafeInteger(part.pages) || part.pages < 0) throw Error('Inventory pagination unavailable.');
                if (page === 1) pages = part.pages;
                for (const skin of part.skins) {
                  if (!validId(skin?._id)) throw Error('Inventory item ID unavailable.');
                  if (list.has(skin._id)) continue;
                  const valuation = prices.calcDollarPrice(skin);
                  if (!nonnegative(valuation.calc)) throw Error('Inventory item value unavailable.');
                  list.add(skin._id);
                  value += valuation.calc;
                }
              }
            }
            totals.inventory += value;
            totals.cash += profile.money;
            totals.tokens += profile.tokens;
          } catch (error) {
            check();
            errors.push([account.name || account.id, error.message]);
          }
          finished++;
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      check();
      if (errors.length) {
        notice = 'Snapshot missed ' + errors.length + ' of ' + accounts.length + ' accounts. History needs a complete snapshot.';
        return { ok: false, message: notice };
      }
      samples = [...samples, { ...totals, at: Date.now() }].slice(-2160);
      ctx.data.set({ samples });
      notice = 'Captured ' + accounts.length + ' accounts.';
      if (chart && !chart.isDestroyed()) showChart();
      return { message: notice };
    } catch (error) {
      notice = error.message;
      return { ok: false, message: notice };
    } finally {
      working = false;
      status = '';
      next = Date.now() + Math.max(30, ctx.settings.get('minutes')) * 60_000;
    }
  }

  ctx.panel.action('capture', capture);
  ctx.panel.action('chart', showChart);
  ctx.panel.action('stop', () => { revision++; return { message: 'Stopping this snapshot.' }; });
  ctx.every(60_000, () => { if (!working && Date.now() >= next) return capture(); });
  ctx.panel.tab('Farm Value', () => {
    const last = samples.at(-1);
    return { blocks: [
      { type: 'settings', keys: ['tokensPerDollar', 'minutes'] },
      { type: 'buttons', items: [
        ...(working ? [{ action: 'stop', label: 'Stop snapshot', danger: true }] : [{ action: 'capture', label: 'Capture snapshot', primary: true }]),
        ...(last ? [{ action: 'chart', label: 'Open stacked history' }] : []),
      ] },
      ...(status || notice ? [{ type: 'notice', text: status || notice }] : []),
      ...(last ? [{ type: 'stats', items: [
        { label: 'Inventory', value: money(last.inventory) }, { label: 'Cash', value: money(last.cash) },
        { label: 'Tokens', value: last.tokens.toLocaleString('en-US') },
        { label: 'Combined value', value: money(last.inventory + last.cash + last.tokens / rate()) },
        { label: 'Snapshots', value: samples.length },
      ] }] : []),
      ...(errors.length ? [{ type: 'table', columns: ['Account', 'Snapshot error'], rows: errors }] : []),
    ] };
  });
  return () => { stopped = true; if (chart && !chart.isDestroyed()) chart.destroy(); };
}

let stop;
module.exports = { start(ctx) { stop = start(ctx); }, stop() { stop?.(); } };
