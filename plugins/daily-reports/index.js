/**
 * DAILY REPORTS
 *
 * One report per day. A day is this PC's own calendar day, so every user's report closes at their local midnight.
 * Each minute it looks at the chosen accounts (none chosen = all):
 *   - the clicker's latest /api/me numbers (ctx.accounts.stats): the day's change in networth, money, tokens, XP, rank;
 *   - whether the account is clicking, having a problem or stopped: minutes of each, and every stretch it was down
 *     (2 minutes or longer), with logouts counted from the clicker's events;
 *   - clicks sent (the clicker's 'click' events);
 *   - what the other plugins did, read from their saved files next to this plugin's (their "today" counters reset at
 *     00:00 UTC, so the report adds up how much they grew between looks instead of copying them).
 * Time the app (or this plugin) wasn't running can't be seen; it's listed as "not recorded".
 * Days chain together: a day starts from the numbers the last one ended on, so nothing between them is lost.
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_MS = 60 * 1000;
const GAP_MS = 3 * 60 * 1000;          // no look for this long = the app or plugin was off
const MIN_DOWN_MS = 2 * 60 * 1000;     // shorter stretches (a quick reconnect) aren't listed
const MAX_EPISODES = 300;
const PAST_CARDS = 7;

// Other plugins' saved numbers: read(json) -> { day (null = running totals), v: { key: number } } | null.
const SOURCES = [
    { id: 'opener', name: 'Opener', read: (s) => s.today && { day: s.today.day, v: pick(s.today, ['opened', 'spent', 'value', 'xp', 'ranks']) },
      text: (v) => [`${count(v.opened)} opened`, `${money(v.spent)} spent`, `drops ${money(v.value)}` + (v.spent ? ` (${Math.round(100 * v.value / v.spent)}%)` : ''), `${count(v.xp)} XP`, v.ranks ? plural(v.ranks, 'rank-up') : ''] },
    { id: 'converter', name: 'Converter', read: (s) => s.today && { day: s.today.day, v: { ...pick(s.today, ['sold', 'spent', 'opened']), tokens: num(s.today.tokens) + num(s.today.skins) } },
      text: (v) => [`${money(v.sold)} cases sold`, `${money(v.spent)} on capsules`, `${count(v.opened)} opened`, `${count(v.tokens)} tokens`] },
    { id: 'armory', name: 'Armory', read: (s) => s.today && { day: s.today.day, v: pick(s.today, ['battles', 'rounds', 'spent']) },
      text: (v) => [plural(v.battles, 'battle'), plural(v.rounds, 'round'), `${money(v.spent)} spent`] },
    { id: 'trader', name: 'Trader', read: (s) => s.today && { day: s.today.day, v: pick(s.today, ['trades', 'items', 'tokens']) },
      text: (v) => [plural(v.trades, 'trade'), plural(v.items, 'item'), `${count(v.tokens)} tokens sent`] },
    { id: 'games', name: 'Games', read: (s) => {
        const g = Object.values(s.games || {}), sum = (k) => g.reduce((t, x) => t + num(x && x[k]), 0);
        return { day: null, v: { plays: sum('plays'), bet: sum('bet'), back: sum('back'), tokens: sum('rewards'), cash: sum('cash') } };
      },
      text: (v) => [plural(v.plays, 'play'), `net ${smoney(v.back - v.bet)}`, v.tokens || v.cash ? `reward tiers ${count(v.tokens)} tokens + ${money(v.cash)}` : ''] },
    { id: 'terminal-opener', name: 'Terminal opener', read: (s) => s.today && { day: s.day, v: pick(s.today, ['opened', 'bought', 'spent', 'worth', 'kept']) },
      text: (v) => [`${count(v.opened)} opened`, `${count(v.bought)} bought for ${money(v.spent)} (worth ${money(v.worth)})`, `${count(v.kept)} kept`] },
    { id: 'auto-forge', name: 'Auto forge', read: (s) => s.today && { day: s.day, v: pick(s.today, ['forged', 'ok', 'failed', 'skipped', 'legendary']) },
      text: (v) => [`${count(v.forged)} forged`, `${count(v.ok)} successful`, `${count(v.failed)} failed`, v.skipped ? `${count(v.skipped)} skipped` : '', v.legendary ? `${count(v.legendary)} reached Legendary` : ''] },
];

let ctx = null;
let state = null;      // saved: { today: report, reports: [report] newest first, lastSampleAt, seen: { source: { day, v, mtime } } }
let dirty = false;

// --- small helpers ---------------------------------------------------------------------------------
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const S = (k) => ctx.settings.get(k);
const pad = (n) => String(n).padStart(2, '0');
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, num(o[k])]));
const plural = (n, w) => `${count(n)} ${w}${Math.round(n) === 1 ? '' : 's'}`;
const count = (v) => (Math.round(num(v) * 100) / 100).toLocaleString('en-US');
const money = (v) => {
    v = num(v); const a = Math.abs(v), s = v < 0 ? '-' : '';
    return s + '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const smoney = (v) => (num(v) > 0 ? '+' : '') + money(v);
const scount = (v) => (num(v) > 0 ? '+' : '') + count(v);
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };   // this PC's clock
const startOf = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOf = (t) => { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime(); };
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60); return h ? `${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`; };
const dayTitle = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
const save = () => { dirty = true; };
function flush() { if (dirty && ctx && state) { dirty = false; try { ctx.data.set(state); } catch (_) { dirty = true; } } }

function reported() {
    const v = S('accounts'), all = !v || v.all || !(Array.isArray(v.ids) && v.ids.length);
    return ctx.accounts.list().filter(a => all || v.ids.includes(a.id));
}
function snap(me, now) {
    if (!me) return null;
    return { money: me.money ?? null, tokens: me.tokens ?? null, networth: me.networth ?? null, xp: me.xp ?? null, skillPoints: me.skillPoints ?? null,
             premier: me.premier ?? null, rank: me.rank ? { id: me.rank.id, name: me.rank.name || null } : null, at: me.at || now };
}

// --- the day: open, roll over, close ------------------------------------------------------------------
function blankAcct(name) { return { name, start: null, last: null, min: { clicking: 0, trouble: 0, stopped: 0 }, clicks: 0, logouts: 0, state: null }; }
function openDay(now, carry, gapFrom) {
    // startedAt: where the day's report begins (midnight when it follows on or after a gap; else the first look ever).
    const startedAt = carry ? startOf(now) : gapFrom != null ? Math.min(gapFrom, now) : now;
    const R = { day: dayOf(now), startedAt, firstLookAt: now, updatedAt: now, sampledMin: 0, accounts: {}, plugins: {}, gaps: [], episodes: [] };
    if (carry) for (const [aid, c] of Object.entries(carry.accounts)) {
        R.accounts[aid] = { ...blankAcct(c.name), start: c.last, last: c.last, state: c.state };
    }
    if (carry) for (const e of carry.episodes) R.episodes.push({ aid: e.aid, name: e.name, from: R.startedAt, to: null, why: e.why, cont: true });
    if (gapFrom != null && now - gapFrom > 0) R.gaps.push({ from: gapFrom, to: now });
    state.today = R;
    save();
    return R;
}
function closeDay(end, keepGoing) {
    const R = state.today;
    R.endedAt = end;
    const open = R.episodes.filter(e => e.to == null);
    for (const e of open) e.to = end;
    state.reports.unshift(R);
    const keep = Math.max(7, Math.min(90, Math.round(num(S('keepDays')) || 30)));
    if (state.reports.length > keep) state.reports.length = keep;
    state.today = null;
    const t = totals(R);
    try {
        ctx.log(`Daily report ${R.day}: networth ${smoney(t.networth)} · money ${smoney(t.money)} · tokens ${scount(t.tokens)} · `
            + (t.active ? `clicking ${t.clickingPct}% · ` : '') + plural(t.downs, 'down time') + (t.notRecorded > 60000 ? ` · ${dur(t.notRecorded)} not recorded` : ''), 'ok');
    } catch (_) {}
    save();
    // What the next day starts from (only when it follows straight on).
    if (!keepGoing) return null;
    return {
        accounts: Object.fromEntries(Object.entries(R.accounts).filter(([, A]) => A.last).map(([aid, A]) => [aid, { name: A.name, last: A.last, state: A.state }])),
        episodes: open.map(e => ({ aid: e.aid, name: e.name, why: e.why })),
    };
}
// Called before anything is counted: closes the day at midnight, notes time nobody was looking.
function roll(now) {
    const last = state.lastSampleAt || 0, gap = !!last && now - last > GAP_MS;
    if (gap && state.today) {
        for (const e of state.today.episodes.filter(x => x.to == null)) endEpisode(state.today, e, last);   // down until the app went away
        for (const A of Object.values(state.today.accounts)) A.state = null;                     // unknown until seen again
    }
    let carry = null;
    if (state.today && state.today.day !== dayOf(now)) {
        const end = endOf(state.today.startedAt);
        if (gap) state.today.gaps.push({ from: last, to: end });
        carry = closeDay(end, !gap);
    } else if (gap && state.today) state.today.gaps.push({ from: last, to: now });
    if (!state.today) openDay(now, carry, gap ? Math.max(last, startOf(now)) : null);
    state.lastSampleAt = now;
    return state.today;
}
function acct(R, aid) {
    if (!R.accounts[aid]) { const a = ctx.accounts.get(aid); R.accounts[aid] = blankAcct(a ? a.name || aid : aid); }
    return R.accounts[aid];
}
function down(R, aid, why, now) {
    const A = acct(R, aid);
    const open = R.episodes.find(e => e.aid === aid && e.to == null);
    if (open) { if (why === 'logged out') open.why = why; return; }
    R.episodes.push({ aid, name: A.name, from: now, to: null, why });
    if (R.episodes.length > MAX_EPISODES) R.episodes.splice(0, R.episodes.length - MAX_EPISODES);
    save();
}
// Ends a down stretch; one shorter than MIN_DOWN_MS (a quick reconnect or restart) isn't kept.
function endEpisode(R, e, at) {
    if (!e.cont && at - e.from < MIN_DOWN_MS) R.episodes.splice(R.episodes.indexOf(e), 1); else e.to = Math.max(e.from, at);
    save();
}
function up(R, aid, now) {
    const e = R.episodes.find(x => x.aid === aid && x.to == null);
    if (e) endEpisode(R, e, now);
}

// --- each minute ------------------------------------------------------------------------------------
function tick(now = Date.now()) {
    const R = roll(now);
    R.sampledMin++; R.updatedAt = now;
    for (const a of reported()) {
        const A = acct(R, a.id);
        A.name = a.name || A.name;
        const st = a.healthy ? 'clicking' : a.running ? 'trouble' : 'stopped';
        A.min[st]++;
        const s = snap(ctx.accounts.stats(a.id), now);
        if (s) { if (!A.start) A.start = s; A.last = s; }
        if (st === 'clicking') up(R, a.id, now);
        else if (A.state === 'clicking') down(R, a.id, st === 'stopped' ? 'stopped' : 'not clicking (a problem)', now);
        A.state = st;
    }
    if (S('plugins')) readPlugins(R);
    save();
}
function onClick(aid, n, now = Date.now()) {
    if (!reported().some(a => a.id === aid)) return;
    const R = roll(now);
    acct(R, aid).clicks += num(n) || 1;
    save();
}
function onDown(aid, why, now = Date.now()) {
    if (!reported().some(a => a.id === aid)) return;
    const R = roll(now), A = acct(R, aid);
    if (why === 'logged out') A.logouts++;
    if (A.state === 'clicking' || why === 'logged out') down(R, aid, why, now);
    A.state = 'stopped';
    save();
}

// Other plugins' files sit next to this plugin's own (ctx.dir is <plugin data>/<this id>).
function readPlugins(R) {
    let dir;
    try { dir = path.dirname(ctx.dir); } catch (_) { return; }
    for (const src of SOURCES) {
        const file = path.join(dir, src.id + '.json');
        let mtime;
        try { mtime = fs.statSync(file).mtimeMs; } catch (_) { continue; }
        const seen = state.seen[src.id];
        if (seen && seen.mtime === mtime) continue;
        let cur;
        try { cur = src.read(JSON.parse(fs.readFileSync(file, 'utf8')) || {}); } catch (_) { continue; }
        if (!cur || !cur.v) continue;
        if (seen && seen.v) {
            const sameDay = cur.day == null || cur.day === seen.day;
            for (const [k, val] of Object.entries(cur.v)) {
                const before = num(seen.v[k]);
                // Same day: what it grew by. Its day rolled over (00:00 UTC) or it was reset: everything it shows now is new.
                const d = sameDay && val >= before ? val - before : val;
                if (d > 0) { const p = R.plugins[src.id] = R.plugins[src.id] || {}; p[k] = num(p[k]) + d; }
            }
        }
        state.seen[src.id] = { day: cur.day, v: cur.v, mtime };
    }
}

// --- sums for one day -------------------------------------------------------------------------------
const delta = (A, k) => (A.start && A.last && A.start[k] != null && A.last[k] != null ? num(A.last[k]) - num(A.start[k]) : null);
function totals(R) {
    const L = Object.values(R.accounts), sum = (k) => L.reduce((t, A) => t + (delta(A, k) || 0), 0);
    const active = L.filter(A => A.min.clicking > 0), mins = (A) => A.min.clicking + A.min.trouble + A.min.stopped;
    const clickingPct = active.length ? Math.round(1000 * active.reduce((t, A) => t + A.min.clicking / Math.max(1, mins(A)), 0) / active.length) / 10 : null;
    const ranks = L.reduce((t, A) => t + (A.start && A.last && A.start.rank && A.last.rank && num(A.last.rank.id) > num(A.start.rank.id) ? num(A.last.rank.id) - num(A.start.rank.id) : 0), 0);
    return {
        networth: sum('networth'), money: sum('money'), tokens: sum('tokens'), xp: sum('xp'), ranks,
        clicks: L.reduce((t, A) => t + A.clicks, 0), logouts: L.reduce((t, A) => t + A.logouts, 0),
        accounts: L.length, active: active.length, clickingPct,
        downs: R.episodes.length, downMs: R.episodes.reduce((t, e) => t + ((e.to || R.updatedAt) - e.from), 0),
        notRecorded: R.gaps.reduce((t, g) => t + (g.to - g.from), 0),
    };
}

// --- the tab ----------------------------------------------------------------------------------------
function dayBlocks(R, live) {
    const t = totals(R), rows = Object.entries(R.accounts).sort(([, a], [, b]) => (delta(b, 'networth') || 0) - (delta(a, 'networth') || 0));
    const show = (v, f) => (v == null ? '—' : f(v));
    const blocks = [
        { type: 'stats', items: [
            { label: 'Networth', value: smoney(t.networth) }, { label: 'Money', value: smoney(t.money) },
            { label: 'Tokens', value: scount(t.tokens) }, { label: 'XP', value: scount(t.xp) + (t.ranks ? ` · ${plural(t.ranks, 'rank-up')}` : '') },
            { label: 'Clicking', value: t.clickingPct == null ? '—' : `${t.clickingPct}% · ${t.active} of ${t.accounts}` },
            { label: 'Down times', value: (t.downs ? `${t.downs} · ${dur(t.downMs)}` : 'none') + (t.logouts ? ` · ${plural(t.logouts, 'logout')}` : '') },
        ] },
        { type: 'table', wrap: true, columns: ['Account', 'Clicking', 'Networth', 'Money', 'Tokens', 'XP', 'Rank', 'Clicks', 'Down'], empty: 'No accounts seen yet.',
          rows: rows.map(([aid, A]) => {
              const m = A.min.clicking + A.min.trouble + A.min.stopped;
              const rank = A.last && A.last.rank ? (A.start && A.start.rank && A.start.rank.name !== A.last.rank.name ? `${A.start.rank.name} → ${A.last.rank.name}` : A.last.rank.name || '') : '';
              const downs = R.episodes.filter(e => e.aid === aid).length;
              return [A.name, m ? `${Math.round(100 * A.min.clicking / m)}% · ${dur(A.min.clicking * 60000)}` : '—',
                  show(delta(A, 'networth'), smoney), show(delta(A, 'money'), smoney), show(delta(A, 'tokens'), scount), show(delta(A, 'xp'), scount),
                  rank, count(A.clicks), (downs ? String(downs) : '') + (A.logouts ? ` · ${plural(A.logouts, 'logout')}` : '')];
          }) },
    ];
    const lines = [
        ...R.episodes.map(e => ({ at: e.from, row: [e.name, hm(e.from), e.to ? hm(e.to) + (e.cont && e.to === R.endedAt ? ' (went on)' : '') : live ? 'still down' : '—',
            dur((e.to || R.updatedAt) - e.from), e.why + (e.cont && e.from === R.startedAt ? ' (from the day before)' : '')] })),
        ...R.gaps.map(g => ({ at: g.from, row: ['—', hm(g.from), hm(g.to), dur(g.to - g.from), 'not recorded (app closed or this plugin off)'] })),
    ].sort((a, b) => a.at - b.at);
    blocks.push({ type: 'card', id: 'down-' + R.day, open: false, title: 'Down times', summary: lines.length ? `${t.downs} down · ${t.notRecorded > 60000 ? dur(t.notRecorded) + ' not recorded' : 'all recorded'}` : 'none',
        blocks: [{ type: 'table', wrap: true, columns: ['Account', 'From', 'To', 'Length', 'Why'], rows: lines.map(l => l.row), empty: 'Every account kept clicking.' }] });
    const P = SOURCES.filter(s => R.plugins[s.id] && Object.values(R.plugins[s.id]).some(v => v > 0));
    if (P.length || S('plugins')) blocks.push({ type: 'card', id: 'plugins-' + R.day, open: false, title: 'Plugins', summary: P.length ? P.map(s => s.name).join(', ') : 'nothing done',
        blocks: [{ type: 'table', wrap: true, columns: ['Plugin', 'What it did'], empty: 'No plugin activity seen.',
            rows: P.map(s => [s.name, s.text(new Proxy(R.plugins[s.id], { get: (o, k) => num(o[k]) })).filter(Boolean).join(' · ')]) }] });   // keys never seen read as 0
    return blocks;
}
function render(now = Date.now()) {
    const R = state.today;
    const blocks = [];
    if (!R) {
        blocks.push({ type: 'hero', pill: 'Starting', title: 'Today', text: 'The first look happens within a minute.' });
    } else {
        blocks.push({ type: 'hero', level: 'ok', pill: 'Today', title: `${dayTitle(R.day)} · so far`,
            text: `Closes at midnight on this PC's clock — in ${dur(endOf(R.startedAt) - now)}. Recorded ${dur(R.sampledMin * 60000)} since ${hm(R.firstLookAt || R.startedAt)}.` });
        blocks.push(...dayBlocks(R, true));
    }
    const past = state.reports;
    if (past.length) {
        blocks.push({ type: 'card', id: 'days', open: true, title: 'Past days', summary: plural(past.length, 'report'), blocks: [
            { type: 'table', wrap: true, columns: ['Day', 'Recorded', 'Clicking', 'Down', 'Networth', 'Money', 'Tokens', 'XP'],
              rows: past.map(D => { const t = totals(D);
                  return [dayTitle(D.day), dur(D.sampledMin * 60000), t.clickingPct == null ? '—' : t.clickingPct + '%', t.downs ? `${t.downs} · ${dur(t.downMs)}` : 'none',
                      smoney(t.networth), smoney(t.money), scount(t.tokens), scount(t.xp)]; }) },
            { type: 'buttons', items: [{ label: 'Delete past reports', action: 'clear', danger: true, confirm: `Delete ${plural(past.length, 'past report')}? Today's report stays.` }] },
        ] });
        for (const D of past.slice(0, PAST_CARDS)) {
            blocks.push({ type: 'card', id: 'day-' + D.day, open: false, title: dayTitle(D.day), summary: (() => { const t = totals(D); return `networth ${smoney(t.networth)} · ${t.clickingPct == null ? 'no clicking' : 'clicking ' + t.clickingPct + '%'} · ${plural(t.downs, 'down time')}`; })(),
                blocks: dayBlocks(D, false) });
        }
    }
    blocks.push({ type: 'card', id: 'settings', open: false, title: 'Settings', summary: (() => { const v = S('accounts'); return (!v || v.all || !(v.ids || []).length ? 'every account' : plural(v.ids.length, 'account')) + ` · keep ${S('keepDays')} days`; })(),
        keys: ['accounts', 'keepDays', 'plugins'] });
    return { blocks };
}

module.exports = {
    start(c) {
        ctx = c; dirty = false;
        const saved = ctx.data.get() || {};
        state = { today: null, reports: [], lastSampleAt: 0, seen: {}, ...saved };
        if (!Array.isArray(state.reports)) state.reports = [];
        if (!state.seen || typeof state.seen !== 'object') state.seen = {};

        ctx.panel.tab('Reports', () => render());
        ctx.panel.action('clear', () => { const n = state.reports.length; state.reports = []; save(); flush(); return { ok: true, message: `Deleted ${plural(n, 'past report')}` }; });
        ctx.on('click', (aid, n) => onClick(aid, n));
        ctx.on('stopped', (aid) => onDown(aid, 'stopped'));
        ctx.on('loggedOut', (aid) => onDown(aid, 'logged out'));
        ctx.every(SAMPLE_MS, () => tick());
        ctx.every(15000, flush);
        tick();
        flush();
    },
    stop() {
        if (state && ctx) { try { ctx.data.set(state); } catch (_) {} }
    },
    // offline tests
    _t: { tick, onClick, onDown, render, totals, dayOf, state: () => state },
};
