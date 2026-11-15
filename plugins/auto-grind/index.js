'use strict';

const { hubControls } = require('./hub');
const {
  MILESTONES, cash, whole, itemId, milestoneOf, customIds, relevantMaps, nextSkill, planCases,
} = require('./planning');
const { routedSite, cheapDropIds, refused } = require('./site');

const COMPATIBLE = ['1.2.8', '1.2.11'];
const CASE_OPTIONS = ['case', 'caseMax', 'target', 'continueOpening', 'keepCash', 'sellMax'];
const DEFAULT_CASE = { value: 'cheapest', label: 'Cheapest unlocked weapon case' };
const SHOP_TTL = 5 * 60_000;
const MAP_TTL = 2 * 60_000;
const money = value => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const number = value => value.toLocaleString('en-US');
const success = message => ({ message });
const fail = error => ({ ok: false, error });
let cleanup;

function run(ctx, hub) {
  let jobs = ctx.data.get()?.jobs || {};
  let stopped = false;
  let catalog = [];
  let catalogAt = 0;
  let working = null;
  let preview = null;
  const due = new Map();
  const views = new Map();
  const mapsByAccount = new Map();
  const waiting = new Set();
  const setting = key => ctx.settings.get(key);
  const chosen = () => setting('account');
  const removed = id => !Object.hasOwn(jobs, id) || !ctx.accounts.get(id);
  const paused = job => !!(job.paused || job.pending);
  const active = (id, job) => !stopped && !ctx.stopping && !removed(id) && jobs[id] === job && !job.paused;

  function writeJob(id, job) {
    const next = { ...jobs };
    if (job) next[id] = job;
    else delete next[id];
    ctx.data.set({ jobs: next });
    jobs = next;
  }

  function releaseWant(id) {
    if (waiting.delete(id)) ctx.accounts.want?.(id, null);
  }

  function options() {
    const values = Object.fromEntries(CASE_OPTIONS.map(key => [key, setting(key)]));
    if (values.case !== 'cheapest' && !itemId(values.case)) throw Error('Choose a case from the case catalog.');
    for (const key of ['caseMax', 'target', 'keepCash', 'sellMax']) {
      if (!cash(values[key])) throw Error('Check the amount entered for ' + key + '.');
    }
    values.target = Math.floor(values.target);
    for (const { key } of MILESTONES) {
      const mode = values[key] = setting(key);
      if (mode === 'custom') values[key + 'Ids'] = customIds(setting(key + 'Ids'));
    }
    return values;
  }

  async function getCatalog(api, refresh = false) {
    if (refresh || Date.now() - catalogAt >= SHOP_TTL || !catalog.length) {
      const items = await api.catalog();
      if (!items.length) throw Error('No weapon cases were found in the catalog.');
      catalog = items;
      catalogAt = Date.now();
      ctx.settings.setOptions('case', [DEFAULT_CASE, ...items.map(item => ({
        value: item.id, label: item.name + ' · ' + money(item.price) + (item.buyable ? '' : ' · owned only'),
      }))]);
    }
    return catalog;
  }

  function updateView(id, changes) {
    views.set(id, { ...views.get(id), ...changes });
  }

  function rememberProgress(id, me, stage) {
    const boost = Array.isArray(me.activeSpecialEffects) && me.activeSpecialEffects.find(item =>
      item.name === 'Big Click Boost' && Date.parse(item.activeTill) > Date.now());
    updateView(id, {
      rank: me.rank?.name || stage.label, rating: cash(me.premierRating) ? me.premierRating : null,
      stage: stage.label, boostEnd: boost ? Date.parse(boost.activeTill) : null,
    });
  }

  async function readSkill(id, api, stage, prefs, me) {
    const prefixes = relevantMaps(stage, prefs, me);
    if (!whole(me.skillPoints) || !me.skillPoints || !prefixes.length) return null;
    const stamp = JSON.stringify([prefixes, me.skillPoints, me.rank?.id, me.premierRank?.id]);
    let cache = mapsByAccount.get(id);
    if (!cache || cache.stamp !== stamp || Date.now() - cache.at >= MAP_TTL) {
      const maps = new Map();
      for (const prefix of prefixes) maps.set(prefix, await api.map(prefix));
      cache = { maps, stamp, at: Date.now() };
      mapsByAccount.set(id, cache);
    }
    return nextSkill(stage, prefs, cache.maps, me);
  }

  async function enroll(id, applySettings = false) {
    if (stopped || !ctx.accounts.get(id)) return fail('Choose an account in Hub.');
    if (working === id) return fail('Wait for the current batch to finish.');
    const current = Object.hasOwn(jobs, id) ? jobs[id] : null;
    if (current && !applySettings && !paused(current)) return success('Auto Grind is already active for this account.');
    if (current && paused(current)) return fail('Review this account in Auto Grind and choose Resume.');
    try {
      const prefs = options();
      writeJob(id, { opened: 0, spent: 0, skills: 0, ...current, prefs, paused: false, pending: null });
    } catch (error) {
      return fail(error.message);
    }
    due.set(id, 0);
    mapsByAccount.delete(id);
    const account = ctx.accounts.get(id);
    updateView(id, { status: account.running ? 'Starting Auto Grind…' : 'Waiting for Hub clicking.' });
    if (applySettings && !account.running) {
      try { await hub.start(id); }
      catch (error) { updateView(id, { status: error.message + ' Start the account in Hub when ready.' }); }
    }
    return success('Auto Grind enabled for ' + account.name + (ctx.accounts.get(id)?.running ? '.' : ' · queued until Hub starts it.'));
  }

  // Record a single write before sending it. An interrupted or ambiguous change is held for review.
  async function change(id, job, pending, send, settle) {
    if (!active(id, job) || !ctx.accounts.get(id)?.healthy || ctx.accounts.busy(id) || ctx.accounts.wanted?.(id)) return false;
    const inFlight = { ...job, pending };
    writeJob(id, inFlight);
    const result = await send();
    if (stopped || ctx.stopping) return false;
    if (result?.kind === 'rate' || refused(result)) {
      writeJob(id, job);
      if (result.kind === 'rate') {
        due.set(id, Date.now() + Math.max(30, Math.min(900, Number(result.retryAfter) || 0)) * 1000);
        updateView(id, { status: 'Waiting for the site’s rate limit.' });
      } else {
        due.set(id, Date.now() + 30_000);
        updateView(id, { status: pending.label + ' refused by the site · HTTP ' + result.status });
        catalogAt = 0;
        mapsByAccount.delete(id);
      }
      return false;
    }
    const completed = await settle(result);
    if (stopped || ctx.stopping) return false;
    if (!completed) {
      updateView(id, { status: 'Check outcome before resuming · ' + pending.label });
      return false;
    }
    writeJob(id, { ...job, ...completed, pending: null });
    return true;
  }

  async function advance(id, job) {
    const prefs = job.prefs;
    const account = ctx.accounts.get(id);
    if (account.type !== 'auto') await hub.auto(id);
    if (!active(id, job)) return;
    const api = routedSite(ctx, id);
    const me = await api.me();
    const stage = me && milestoneOf(me);
    if (!stage || !cash(me.money) || !whole(me.skillPoints)) throw Error('Waiting for verified rank, cash and skill points.');
    rememberProgress(id, me, stage);
    const targetReached = cash(me.premierRating) && me.premierRating >= prefs.target && me.rank.id >= 18;
    const next = await readSkill(id, api, stage, prefs, me);
    const reserve = next?.skill.cost ?? 0;
    updateView(id, { reserve, next: next?.skill, goal: next?.goal });
    if (!active(id, job)) return;

    if (next && Math.floor(me.money * 100 + 1e-7) >= Math.round((reserve + prefs.keepCash) * 100)) {
      const { skill } = next;
      const prefix = skill.id[0];
      const fresh = await api.map(prefix);
      const node = fresh.skills.get(skill.id);
      if (!node || node.cost !== skill.cost || node.parent !== skill.parent ||
        (fresh.rank && me.rank?.id < fresh.rank) || (fresh.premier && !(me.premierRank?.id >= fresh.premier)) ||
        fresh.owned.has(skill.id) || (node.parent && !fresh.owned.has(node.parent))) {
        mapsByAccount.delete(id);
        updateView(id, { status: 'Refreshing skill ownership and prices.' });
        return;
      }
      updateView(id, { status: 'Buying ' + skill.name + '…' });
      await change(id, job, { label: 'Skill ' + skill.id }, () => api.skill(skill), async () => {
        const refreshed = await api.map(prefix);
        if (!refreshed.owned.has(skill.id)) return null;
        mapsByAccount.delete(id);
        updateView(id, { status: 'Bought ' + skill.map + ' · ' + skill.name, reserve: 0, next: null });
        ctx.log('Applied ' + skill.map + ' · ' + skill.name + ' (' + skill.id + ')', 'ok', id);
        return { skills: job.skills + 1 };
      });
      return;
    }

    if (targetReached && !prefs.continueOpening) {
      due.set(id, Date.now() + 60_000);
      updateView(id, { status: next ? 'Target reached · saving for the next skill' : 'Target reached · Hub Auto continues' });
      return;
    }

    const shop = await getCatalog(api);
    const stock = await api.stock();
    const plan = planCases(shop, stock, me, prefs, reserve);
    if (plan.wait) {
      due.set(id, Date.now() + 30_000);
      updateView(id, { status: plan.wait });
      return;
    }
    const { item, count } = plan;
    updateView(id, { status: (plan.kind === 'buy' ? 'Buying ' : 'Opening ') + number(count) + ' × ' + item.name });
    if (plan.kind === 'buy') {
      await change(id, job, { label: 'Buy ' + number(count) + ' × ' + item.name }, () => api.buy(plan),
        result => result?.kind === 'ok' ? { spent: Math.round((job.spent + plan.cost) * 100) / 100 } : null);
      return;
    }

    let drops;
    const opened = await change(id, job, { label: 'Open ' + number(count) + ' × ' + item.name }, () => api.open(plan, prefs.sellMax > 0),
      result => {
        if (result?.kind !== 'ok') return null;
        drops = result.json?.openedSkins;
        return { opened: job.opened + count };
      });
    if (!opened) return;
    for (const drop of cheapDropIds(drops, prefs.sellMax)) {
      if (stopped || ctx.stopping || !ctx.accounts.get(id)?.healthy || ctx.accounts.busy(id) || ctx.accounts.wanted?.(id)) break;
      const sold = await api.sell(drop);
      if (sold?.kind !== 'ok') break;
    }
    updateView(id, { status: 'Opened ' + number(count) + ' × ' + item.name });
  }

  async function tick() {
    if (working || stopped || ctx.stopping) return;
    const now = Date.now();
    const ids = Object.keys(jobs).filter(id => !paused(jobs[id]) && ctx.accounts.get(id)?.running && (due.get(id) || 0) <= now);
    const id = ids.sort((a, b) => (due.get(a) || 0) - (due.get(b) || 0))[0];
    if (!id) return;
    const job = jobs[id];
    due.set(id, now + 5_000);
    if (!ctx.accounts.get(id)?.healthy) {
      releaseWant(id);
      updateView(id, { status: 'Waiting for healthy Hub clicking.' });
      return;
    }
    const busy = ctx.accounts.busy(id);
    const wanted = ctx.accounts.wanted?.(id);
    if (busy || wanted) {
      if (busy && !wanted && !waiting.has(id) && ctx.accounts.want) {
        ctx.accounts.want(id, 'Auto Grind');
        waiting.add(id);
      }
      updateView(id, { status: 'Waiting for ' + (busy || wanted).what });
      return;
    }
    releaseWant(id);
    working = id;
    ctx.accounts.setBusy(id, 'Auto Grind');
    try {
      await advance(id, job);
    } catch (error) {
      due.set(id, Date.now() + (error.retryMs || 30_000));
      updateView(id, { status: error.message });
    } finally {
      ctx.accounts.setBusy(id, null);
      working = null;
    }
  }

  function toggle(id, action) {
    if (typeof id !== 'string' || !Object.hasOwn(jobs, id)) return fail('This account has no Auto Grind plan.');
    if (working === id) return fail('Wait for the current batch to finish.');
    const job = jobs[id];
    if (action === 'remove') writeJob(id, null);
    else writeJob(id, { ...job, paused: action === 'pause', pending: action === 'resume' ? null : job.pending });
    releaseWant(id);
    due.delete(id);
    mapsByAccount.delete(id);
    views.delete(id);
    return success(action === 'remove' ? 'Auto Grind plan removed.' : action === 'pause' ? 'Auto Grind paused.' : 'Auto Grind resumed.');
  }

  ctx.panel.action('refresh-cases', async () => {
    const account = ctx.accounts.get(chosen())?.healthy ? ctx.accounts.get(chosen())
      : ctx.accounts.list().find(item => item.healthy);
    if (!account) return fail('Start one Hub account to load the case catalog.');
    try {
      await getCatalog(routedSite(ctx, account.id), true);
      return success('Loaded ' + catalog.length + ' weapon cases.');
    } catch (error) { return fail(error.message); }
  });
  ctx.panel.action('preview', async () => {
    const account = ctx.accounts.get(chosen());
    if (!account?.healthy) return fail('Start the selected account in Hub to preview its plan.');
    try {
      const prefs = options();
      const api = routedSite(ctx, account.id);
      const me = await api.me();
      const stage = me && milestoneOf(me);
      if (!stage || !cash(me.money) || !whole(me.skillPoints)) throw Error('Waiting for verified rank, cash and skill points.');
      const next = await readSkill(account.id, api, stage, prefs, me);
      const reserve = next?.skill.cost ?? 0;
      const reached = me.rank.id >= 18 && me.premierRating >= prefs.target;
      const plan = reached && !prefs.continueOpening ? { wait: 'Premier target reached.' }
        : planCases(await getCatalog(api), await api.stock(), me, prefs, reserve);
      const cases = plan.wait || ((plan.kind === 'open' ? 'Open ' : 'Buy ') + number(plan.count) + ' × ' + plan.item.name + '.');
      const skill = next ? ' Next skill: ' + next.skill.map + ' · ' + next.skill.name + ' (' + money(reserve) + ').' : '';
      const text = account.name + ' · ' + stage.label + '. ' + cases + skill;
      preview = { id: account.id, text };
      return success(text);
    } catch (error) { return fail(error.message); }
  });
  ctx.panel.action('enroll', () => enroll(chosen(), true));
  ctx.panel.action('enroll-from-setup', ticket => {
    const handoff = ctx.shared.get('zsb-account-setup/auto-grind-enrollment');
    if (!handoff || ticket !== handoff.ticket || Date.now() - handoff.at > 30_000) return fail('Account Setup enrollment expired.');
    return enroll(handoff.id);
  });
  for (const action of ['pause', 'resume', 'remove']) ctx.panel.action(action, id => toggle(id, action));
  ctx.shared.set('enrollment', { version: 1 });
  ctx.on('started', id => { if (Object.hasOwn(jobs, id)) due.set(id, 0); });
  ctx.on('stopped', id => releaseWant(id));
  ctx.settings.onChange(() => { preview = null; });
  ctx.every(1500, tick);

  ctx.panel.tab('Auto Grind', () => {
    const accounts = ctx.accounts.list();
    const activeCount = accounts.filter(account => Object.hasOwn(jobs, account.id) && !paused(jobs[account.id])).length;
    const blocks = [
      { type: 'settings', keys: ['account', 'case', 'target'] },
      { type: 'buttons', items: [
        { label: 'Load case choices', action: 'refresh-cases' },
        { label: 'Preview plan', action: 'preview' },
        {
          label: 'Enable Auto Grind / save plan', action: 'enroll', primary: true,
          confirm: 'Set the selected account to Hub Auto and run this leveling plan? Auto Grind can spend in-game cash and skill points, open cases, and sell eligible new drops if enabled.',
        },
      ] },
      { type: 'card', id: 'limits', title: 'Case and cash settings', open: false,
        keys: ['caseMax', 'keepCash', 'sellMax', 'continueOpening'] },
      {
        type: 'card', id: 'milestones', title: 'Skillmaps by milestone', open: false,
        keys: MILESTONES.flatMap(({ key }) => setting(key) === 'custom' ? [key, key + 'Ids'] : [key]),
      },
      { type: 'stats', items: [
        { label: 'Active accounts', value: activeCount },
        { label: 'Cases opened', value: number(Object.values(jobs).reduce((sum, job) => sum + job.opened, 0)) },
        { label: 'Skills applied', value: number(Object.values(jobs).reduce((sum, job) => sum + job.skills, 0)) },
      ] },
    ];
    if (preview?.id === chosen()) blocks.push({ type: 'notice', text: preview.text });

    const states = accounts.filter(account => Object.hasOwn(jobs, account.id)).map(account => {
      const job = jobs[account.id];
      const view = views.get(account.id) || {};
      const cached = ctx.accounts.stats(account.id);
      const rating = view.rating ?? cached?.premier;
      const status = job.pending ? 'Review ' + job.pending.label : job.paused ? 'Paused'
        : !account.running ? 'Waiting for Hub clicking' : view.status || 'Queued';
      const next = view.next ? view.next.map + ' · ' + view.next.name + ' (' + view.next.id + ')' +
        (view.goal?.id && view.goal.id !== view.next.id ? ' → ' + view.goal.name : '') : '—';
      return {
        account, job, view, status, next, rating,
        rank: view.rank || cached?.rank?.name || 'Waiting for report',
      };
    });
    blocks.push({ type: 'table', columns: ['Account', 'Rank', 'Premier', 'Progress', 'Next skill', 'Reserved', 'Status', 'Control'], wrap: true,
      empty: 'Choose a Hub account and enable Auto Grind to start.',
      rows: states.map(({ account, job, view, status, next, rating, rank }) => [
        account.name, rank, (cash(rating) ? number(rating) : '—') + ' / ' + number(job.prefs.target),
        number(job.opened) + ' opened · ' + money(job.spent) + ' case spend',
        next, view.reserve ? money(view.reserve) : '—',
        status + (view.boostEnd > Date.now() ? ' · starter boost active' : ''),
        paused(job) ? { label: 'Resume', action: 'resume', arg: account.id,
          ...(job.pending ? { confirm: 'Check this change in Case Clicker first. Resume will read fresh case stock and skill ownership before deciding what to do next.' } : {}) }
          : { label: 'Pause', action: 'pause', arg: account.id },
      ]) });
    const selected = states.find(row => row.account.id === chosen());
    if (selected) blocks.push({ type: 'buttons', items: [{
      label: 'Remove selected plan', action: 'remove', arg: selected.account.id, danger: true,
      confirm: 'Remove Auto Grind tracking for this account? Hub clicking continues.',
    }] });
    return { blocks };
  });
  ctx.panel.badge(id => Object.hasOwn(jobs, id) && !paused(jobs[id]) ? 'Auto Grind' : null);

  return () => {
    stopped = true;
    for (const id of waiting) releaseWant(id);
  };
}

module.exports = {
  start(ctx) {
    if (!COMPATIBLE.includes(ctx.coreVersion)) {
      ctx.panel.tab('Auto Grind', () => ({ blocks: [{
        type: 'notice', text: 'This version of Auto Grind supports Hub ' + COMPATIBLE.join(' and ') + '.',
      }] }));
      return;
    }
    cleanup = run(ctx, hubControls(require('electron')));
  },
  stop() { cleanup?.(); cleanup = null; },
  run,
};
