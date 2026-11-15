'use strict';

const { randomUUID } = require('node:crypto');
const { MAPS, parseMap, presetIds, purchasePlan, snapshot } = require('./planning');

const TTL = 10 * 60_000;
const money = amount => '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 2 });

function start(ctx) {
  let preview = null;
  let task = null;
  let stopped = false;
  let message = '';
  let progress = '';
  let last = [];
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
    return {
      fit: setting('fit'),
      cashReserve: setting('cashReserve'),
      maxSpend: setting('maxSpend'),
      maxPoints: Math.floor(setting('maxPoints')),
    };
  }

  async function request(id, pathname) {
    if (!active()) throw Error('Stopped');
    const reason = blocker(id);
    if (reason) throw Error(reason);
    const result = await ctx.request(id, pathname, { timeoutMs: 15000 });
    if (result.kind !== 'ok') throw Error(pathname + ' unavailable (' + (result.status || result.kind) + ')');
    return result;
  }

  async function run(label, action) {
    if (task) return { ok: false, error: 'Wait for the current skillmap action to finish.' };
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

  ctx.panel.action('preview', () => run('Checking selected farm accounts…', async () => {
    preview = null;
    last = [];
    const ids = presetIds(setting('preset'), setting('customIds'));
    const rules = readRules();
    const accounts = ctx.accounts.list().filter(account => selected(account.id));
    if (!accounts.length) throw Error('Choose one or more farm accounts.');
    const rows = [];
    for (const account of accounts) {
      if (!active()) return 'Preview stopped.';
      progress = 'Reading skills for ' + (account.name || account.id) + '…';
      try {
        const state = await snapshot(ids, pathname => request(account.id, pathname));
        const plan = purchasePlan(ids, state, rules);
        const limits = [plan.blocked && 'rank', plan.limited && 'cash or points'].filter(Boolean).join(', ');
        const status = plan.steps.length ? (plan.complete ? 'Ready' : plan.pending + ' goals deferred · ' + limits)
          : plan.complete ? 'Already owned' : 'Waiting on ' + limits;
        rows.push({ account, ...plan, status });
      } catch (error) {
        rows.push({ account, status: error.message, total: 0, steps: [] });
      }
    }
    if (!active()) return 'Preview stopped.';
    const count = rows.reduce((total, row) => total + row.steps.length, 0);
    const total = rows.reduce((amount, row) => amount + row.total, 0);
    preview = { id: randomUUID(), at: Date.now(), rows, rules, count, total };
    return 'Preview ready. ' + count + ' skill purchase(s) for up to ' + money(total) + '.';
  }));

  ctx.panel.action('apply', id => run('Rechecking previewed purchases…', async () => {
    const plan = preview;
    if (!plan || plan.id !== id || !plan.count || Date.now() - plan.at > TTL) {
      throw Error('Create a fresh preview first.');
    }
    preview = null;
    let confirmed = 0;
    let uncertain = 0;
    for (const row of plan.rows) {
      if (!active() || uncertain) break;
      if (!row.steps.length) continue;
      const aid = row.account.id;
      const name = row.account.name || aid;
      const reason = blocker(aid);
      if (reason) {
        last.push([name, 0, reason]);
        continue;
      }

      ctx.accounts.setBusy(aid, 'Skillmap Presets');
      let purchased = 0;
      let detail = 'Complete';
      try {
        progress = 'Rechecking ' + name + '…';
        const approved = new Map(row.steps.map(skill => [skill.id, skill]));
        const get = pathname => request(aid, pathname);
        const current = await snapshot([...approved.keys()], get);
        const fresh = purchasePlan([...approved.keys()], current, { ...plan.rules, fit: false });
        if (!fresh.complete || fresh.steps.some(skill => {
          const previous = approved.get(skill.id);
          return !previous || previous.parent !== skill.parent || previous.map !== skill.map || skill.cost > previous.cost;
        })) throw Error('Plan changed · preview again');
        if (!fresh.steps.length) detail = 'Already owned';
        for (const skill of fresh.steps) {
          if (!active()) { detail = 'Stopped'; break; }
          const waiting = blocker(aid);
          if (waiting) { detail = waiting; break; }
          progress = 'Applying skills on ' + name + '…';
          // Never retry a purchase. Check the account's map before continuing.
          let answer;
          try {
            answer = await ctx.request(aid, '/api/skill', {
              method: 'POST', body: { mapName: skill.map, skillId: skill.id }, tries: 1, timeoutMs: 15000,
            });
          } catch {
            answer = { kind: 'unknown' };
          }
          const map = MAPS[skill.id[0]];
          let ownsSkill = false;
          try {
            const result = await get('/skillmaps/' + encodeURIComponent(map.path));
            ownsSkill = parseMap(result.body, map).owned.has(skill.id);
          } catch {
            // An absent observation is handled by the same unknown-outcome path.
          }
          if (ownsSkill) {
            purchased++;
            continue;
          }
          if (answer.status >= 400 && answer.status < 500 && answer.kind !== 'cf') {
            detail = 'Purchase refused · HTTP ' + answer.status;
          } else {
            uncertain++;
            detail = 'Purchase unconfirmed · refresh this account before retrying';
          }
          break;
        }
      } catch (error) {
        detail = error.message;
      } finally {
        ctx.accounts.setBusy(aid, null);
      }
      confirmed += purchased;
      last.push([name, purchased, detail]);
    }
    const summary = confirmed + ' confirmed purchase(s) · ' + uncertain + ' unconfirmed · review account outcomes below.';
    ctx.log(summary, uncertain ? 'warn' : 'info');
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

  ctx.panel.tab('Skillmap Presets', () => {
    const keys = ['accounts', 'preset', 'fit', 'cashReserve', 'maxSpend', 'maxPoints'];
    if (setting('preset') === 'custom') keys.splice(2, 0, 'customIds');
    const blocks = [
      { type: 'settings', keys },
      { type: 'buttons', items: [task
        ? { label: 'Stop', action: 'stop', danger: true }
        : { label: 'Preview skill purchases', action: 'preview', primary: true }] },
    ];
    if (progress || message) blocks.push({ type: 'notice', text: progress || message });
    if (preview) {
      blocks.push({
        type: 'stats', items: [
          { label: 'Accounts ready', value: preview.rows.filter(row => row.steps.length).length },
          { label: 'Skill points', value: preview.count },
          { label: 'Maximum spend', value: money(preview.total) },
        ],
      }, {
        type: 'table', columns: ['Account', 'Status', 'Skills', 'Cost'],
        rows: preview.rows.map(row => [row.account.name || row.account.id, row.status, row.steps.length, money(row.total)]),
      }, {
        type: 'card', id: 'skill-preview', title: 'Purchase details', open: false,
        blocks: [{
          type: 'table', columns: ['Account', 'Map', 'Skill', 'Cost'],
          rows: preview.rows.flatMap(row => row.steps.map(skill => [row.account.name || row.account.id, skill.map, skill.name + ' (' + skill.id + ')', money(skill.cost)])),
        }],
      });
      if (!task && preview.count && Date.now() - preview.at <= TTL) {
        blocks.push({ type: 'buttons', items: [{
          label: 'Apply previewed purchases', action: 'apply', arg: preview.id, primary: true,
          confirm: 'Buy up to ' + preview.count + ' skills for ' + money(preview.total) + ' across the ready accounts?',
        }] });
      }
    }
    if (last.length) blocks.push({ type: 'table', columns: ['Account', 'Purchased', 'Outcome'], rows: last });
    return { blocks };
  });

  return () => { stopped = true; };
}

let cleanup;
module.exports = {
  start(ctx) { cleanup = start(ctx); },
  stop() { cleanup?.(); },
};
