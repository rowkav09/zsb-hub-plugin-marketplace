'use strict';

const { PriceData } = require('./cco-price-data');
const { desktopChart } = require('./desktop-chart');

const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const money = value => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const nonnegative = value => Number.isFinite(value) && value >= 0;
const validSample = sample => ['at','inventory','cash','tokens'].every(key => nonnegative(sample?.[key]));

function start(ctx) {
  const prices = new PriceData();
  const data = ctx.data.get();
  let samples = Array.isArray(data?.samples) ? data.samples.filter(validSample).map(({ at, inventory, cash, tokens }) => ({ at, inventory, cash, tokens })) : [];
  let stopped = false, working = false, revision = 0, notice = '', errors = [], status = '';
  let next = Date.now() + 60_000;
  const rate = () => Number(ctx.settings.get('tokensPerDollar'));

  const chart = desktopChart();
  const syncChart = () => chart.sync(samples, rate());
  void syncChart();
  ctx.every(10_000, syncChart);
  ctx.settings.onChange(key => { if (key === 'tokensPerDollar') void syncChart(); });

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
      let nextRead = 0, rateLimitUntil = 0;
      async function pauseForRead() {
        const start = Math.max(nextRead, rateLimitUntil, Date.now());
        nextRead = start + 240;
        while (Date.now() < Math.max(start, rateLimitUntil)) {
          check();
          await ctx.sleep(Math.min(1000, Math.max(start, rateLimitUntil) - Date.now()));
        }
      }
      async function worker() {
        while (position < accounts.length) {
          const account = accounts[position++];
          const route = () => ctx.network.state().accounts.find(row => row.id === account.id)?.route;
          const expected = route();
          async function read(path) {
            check();
            if (!expected || route() !== expected) throw Error('Account route unavailable or changed.');
            for (let attempt = 0; attempt < 5; attempt++) {
              await pauseForRead();
              check();
              if (route() !== expected) throw Error('Account route changed.');
              const reply = await ctx.request(account.id, path, { method: 'GET', tries: 1, timeoutMs: 15000 });
              if (route() !== expected) throw Error('Account route changed.');
              if (reply?.kind === 'ok') return reply.json;
              if (reply?.status !== 429 || attempt === 4) {
                throw Error(path.split('?')[0] + ' · ' + (reply?.status || reply?.kind));
              }
              const wait = Math.max(8000 * 2 ** attempt, Number(reply.retryAfter) * 1000 || 0);
              rateLimitUntil = Math.max(rateLimitUntil, Date.now() + wait);
              status = 'Waiting for the inventory API rate limit…';
            }
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
      void syncChart();
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
  ctx.panel.action('stop', () => { revision++; return { message: 'Stopping this snapshot.' }; });
  ctx.every(60_000, () => { if (!working && Date.now() >= next) return capture(); });
  ctx.panel.tab('Farm Value', () => {
    const last = samples.at(-1);
    return { blocks: [
      { type: 'buttons', items: [
        ...(working ? [{ action: 'stop', label: 'Stop snapshot', danger: true }] : [{ action: 'capture', label: 'Capture snapshot', primary: true }]),
      ] },
      ...(status || notice ? [{ type: 'notice', text: status || notice }] : []),
      ...(last ? [{ type: 'stats', items: [
        { label: 'Inventory', value: money(last.inventory) }, { label: 'Cash', value: money(last.cash) },
        { label: 'Tokens', value: last.tokens.toLocaleString('en-US') },
        { label: 'Combined value', value: money(last.inventory + last.cash + last.tokens / rate()) },
      ] }] : []),
      { type: 'card', id: 'farm-value-history', title: 'Value history', open: true,
        blocks: [{ type: 'notice', text: 'Open the Farm Value tab in the desktop app to view the line chart.' }] },
      { type: 'card', id: 'farm-value-settings', title: 'Snapshot settings', open: false,
        keys: ['tokensPerDollar', 'minutes'] },
      ...(errors.length ? [{ type: 'table', columns: ['Account', 'Snapshot error'], rows: errors }] : []),
    ] };
  });
  return () => { stopped = true; chart.stop(); };
}

let stop;
module.exports = { start(ctx) { stop = start(ctx); }, stop() { stop?.(); } };
