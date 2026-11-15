/**
 * TERMINAL OPENER — opens Genesis / Dead Hand terminals on the chosen accounts, offer by offer, by the buy rules.
 * A port of Clicker Hub's src/terminals.js (itself the "Terminal Dashboard v2" userscript's rules) to a ZSB Hub plugin.
 *
 * Site contract (verified live 2026-11-07):
 *   POST /api/inventory/terminal {terminalId}                 -> the terminal item doc; unseals a sealed one (ONE offer shown)
 *   PUT  /api/inventory/terminal {terminalId, accepted:false} -> doc with the next offer appended (free); on offer 5:
 *                                                               {message:"Terminal destroyed", shouldClose:true}
 *   PUT  {terminalId, accepted:true}                          -> {message:"Purchase completed", terminal:<doc>, shouldClose:true},
 *                                                               charges exactly offeredPrice; the terminal is gone
 *   An offer's skin already has its final _id (the bought skin keeps it), origin {type:'terminal'}, and the event on event
 *   terminals. It arrives NOT favourited. POST /api/inventory/skin/favorite {skinId, isFavorite, inStorageUnit:false}.
 *   "User is locked." = busy with another request, nothing happened -> retry.
 *
 * A run: favourite every waiting terminal of the kind (so the Converter's / Opener's selling can't take them — they
 * sell non-favourites only), then open on up to `perIp` accounts per exit IP at once. An opening account carries a busy
 * mark, and one another plugin holds is asked for (ctx.accounts.want) and waited for. Rule buys (and, if asked, every
 * event-terminal buy) are favourited, so they stay on the account. Each account only works on its own terminals: no
 * trades, nothing is sent or received. STOP stops between offers. A run that is cut off (app closed, plugin turned off)
 * carries on when the plugin starts again.
 */

const VARIANTS = ['Genesis Terminal', 'Dead Hand Terminal'], BOTH = 'both';
const RARITIES = ['Mil-Spec Grade', 'Restricted', 'Classified', 'Covert', 'Extraordinary'];
const GAP = { slow: 300, fast: 200, turbo: 100, max: 0 };
const MAX_OFFERS = 5, MAX_PAGES = 250, OFFER_GUARD = 12;   // 100 items a page; a main can hold 4,000+ terminals
const FEED_MAX = 200, LOG_MAX = 150, PREP_AT_ONCE = 6, WAIT_CLICKER_MS = 15 * 60000;
const ACTIVE = ['scanning', 'opening'];
const ENDED = ['done', 'stopped', 'error'];

let ctx = null;
let state = null;      // saved (ctx.data): { day, today, accepted, declined, log, session }
let run = null;        // { id, startedAt, stop, ended, variant, events, lanes: { aid: lane } }
let scan = null;       // { at, variant, running, accounts: { aid: counts | { error } } }
let dirty = false;
let halted = false;    // this copy was stopped (plugin off / app closing): its loops end quietly, the saved session stays

const off = () => halted || !ctx || ctx.stopping;
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const S = (k) => ctx.settings.get(k);
const day = () => new Date().toISOString().slice(0, 10);
const blankToday = () => ({ opened: 0, bought: 0, passed: 0, spent: 0, kept: 0, worth: 0 });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = (v) => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nameOf = (aid) => { const a = ctx.accounts.get(aid); return a ? a.name || aid : aid; };
const healthy = (aid) => { const a = ctx.accounts.get(aid); return !!(a && a.healthy); };
const save = () => { dirty = true; };
const fl = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };

function rollDay() { if (state.day !== day()) { state.day = day(); state.today = blankToday(); save(); } }

function log(aid, msg, level = 'info') {
    try { ctx.log(msg, level, aid || null); } catch (_) {}
    state.log.unshift({ at: Date.now(), name: aid ? nameOf(aid) : null, msg, level });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    save();
}

// --- Buy rules (the script's checkItemMeetsCriteria, unchanged) ---------------------------------
const floatStr = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' || Number.isNaN(parseFloat(s)) ? '' : s; };
function rulesNow() {
    const tags = (Array.isArray(S('rarities')) ? S('rarities') : []).map(t => RARITIES.find(r => r.toLowerCase() === String(t).trim().toLowerCase())).filter(Boolean);
    const perRarity = {};
    for (const row of Array.isArray(S('perRarity')) ? S('perRarity') : []) {
        if (!row || !RARITIES.includes(row.rarity)) continue;
        const low = floatStr(row.low), high = floatStr(row.high);
        if (low !== '' || high !== '') perRarity[row.rarity] = { low, high };
    }
    return {
        autoDecide: !!S('autoDecide'), pattern: !!S('pattern'), floatMode: S('floatMode') === 'advanced' ? 'advanced' : 'simple',
        lowFloat: floatStr(S('lowFloat')), highFloat: floatStr(S('highFloat')), rarities: tags, perRarity,
        customFloats: String(S('customFloats') || '').slice(0, 2000), finalAuto: !!S('finalAuto'), finalMode: S('finalMode') === 'always' ? 'always' : 'criteria',
    };
}
const hasPattern = (s) => !!s && (s.patternId != null || s.hasPattern === true);
// Which rule a skin meets, or null.
function ruleMatch(skin, R) {
    if (!skin) return null;
    if (R.pattern && hasPattern(skin)) return 'pattern';
    const f = Number(skin.float);
    const customs = String(R.customFloats || '').split(',').map(x => parseFloat(x.trim())).filter(x => !Number.isNaN(x));
    if (customs.length && skin.float && customs.includes(f)) return 'custom float';
    if (R.floatMode === 'advanced') {
        const s = (R.perRarity || {})[skin.rarity];
        if (s) {
            if (s.low !== '' && f < parseFloat(s.low)) return skin.rarity + ' float below ' + s.low;
            if (s.high !== '' && f > parseFloat(s.high)) return skin.rarity + ' float above ' + s.high;
        }
        return null;
    }
    if (R.lowFloat !== '' && f < parseFloat(R.lowFloat)) return 'float below ' + R.lowFloat;
    if (R.highFloat !== '' && f > parseFloat(R.highFloat)) return 'float above ' + R.highFloat;
    if ((R.rarities || []).length && skin.rarity && R.rarities.includes(skin.rarity)) return 'rarity ' + skin.rarity;
    return null;
}
// Buy or pass this offer. `match` = a rule matched (those buys are kept).
function decide(skin, isFinal, R) {
    const m = ruleMatch(skin, R);
    if (isFinal) {
        if (!R.finalAuto) return { buy: false, match: false, why: 'offer 5 — discarded (offer 5 not decided)' };
        if (R.finalMode === 'always') return { buy: true, match: !!m, why: m || 'offer 5 — always bought' };
    } else if (!R.autoDecide) return { buy: false, match: false, why: 'offers 1–4 not decided — passed' };
    return { buy: !!m, match: !!m, why: m || 'no rule matched' };
}
function rulesSummary(R) {
    const parts = [];
    if (R.pattern) parts.push('patterns');
    if (R.floatMode === 'advanced') { const k = Object.keys(R.perRarity); if (k.length) parts.push('floats for ' + k.join(', ')); }
    else {
        if (R.lowFloat !== '') parts.push('float < ' + R.lowFloat);
        if (R.highFloat !== '') parts.push('float > ' + R.highFloat);
        if (R.rarities.length) parts.push(R.rarities.join(', '));
    }
    if (R.customFloats.trim()) parts.push('exact floats');
    const offers = !R.autoDecide ? 'offers 1–4 passed' : parts.length ? 'buys ' + parts.join(' · ') : 'no rules set — every offer 1–4 is passed';
    const last = !R.finalAuto ? 'offer 5 discarded' : R.finalMode === 'always' ? 'offer 5 always bought' : 'offer 5 by the rules';
    return offers + ' · ' + last;
}

// --- Site calls -------------------------------------------------------------------------------------
class SiteErr extends Error { constructor(kind, status, msg) { super(msg); this.kind = kind; this.status = status; this.lost = kind === 'net' || kind === 'timeout'; } }
const errText = (r) => (r.json && (r.json.error || r.json.message)) || (r.kind === 'not-running' || r.kind === 'gone' ? 'account not clicking'
    : r.kind === 'cf' ? 'Cloudflare check waiting' : r.kind === 'maintenance' ? 'site under maintenance' : String(r.body || '').slice(0, 140) || ('HTTP ' + (r.status || r.kind)));
// Reads retry the usual hiccups; writes only a 429 (it never reached the site). "User is locked" is retried (nothing
// happened). A lost write reply (net / timeout) isn't resent: the caller reads the terminal again instead.
async function call(aid, method, path, body) {
    let wait = 300;
    for (let t = 0; ; t++) {
        if (off()) throw new SiteErr('stopping', 0, 'plugin stopped');
        const r = await ctx.request(aid, path, method === 'GET' ? { tries: 3 } : { method, body, tries: 3, retryOn: ['rate'] });
        if (r.kind === 'ok') return r.json;
        const msg = errText(r);
        if (/locked/i.test(msg) && t < 10) { await ctx.sleep(wait); wait = Math.min(wait * 2, 2500); continue; }
        if (r.kind === 'cf' && t < 8) { await ctx.sleep(15000); continue; }   // the app shows the check: wait for the tick
        throw new SiteErr(r.kind, r.status || 0, msg);
    }
}
const loadTerminal = (aid, id) => call(aid, 'POST', '/api/inventory/terminal', { terminalId: id });
const answer = (aid, id, accepted) => call(aid, 'PUT', '/api/inventory/terminal', { terminalId: id, accepted });
async function setFavourite(aid, skinId, on) {
    for (let t = 0; ; t++) {
        try { await call(aid, 'POST', '/api/inventory/skin/favorite', { skinId, isFavorite: on, inStorageUnit: false }); return true; }
        catch (e) { if (t >= 2 || e.kind === 'stopping') throw e; await ctx.sleep(1000); }
    }
}
// The terminal doc inside any reply: the item itself, or {terminal: <item>} on a buy.
function docOf(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.terminal && r.terminal.terminal && Array.isArray(r.terminal.terminal.offeredSkins)) return r.terminal;
    if (r.terminal && Array.isArray(r.terminal.offeredSkins)) return r;
    return null;
}
const offersOf = (doc) => (doc && doc.terminal && Array.isArray(doc.terminal.offeredSkins)) ? doc.terminal.offeredSkins : [];
const pendingIdx = (doc) => offersOf(doc).findIndex(o => o.accepted === null || o.accepted === undefined);
function statusOf(item) {
    const t = (item && item.terminal) || {};
    if (t.isSealed) return 'sealed';
    const offers = Array.isArray(t.offeredSkins) ? t.offeredSkins : [];
    if (offers.some(o => o.accepted === null || o.accepted === undefined)) return 'open';
    return offers.length ? 'done' : 'sealed';
}
const isEventItem = (item) => !!((item && item.event) || (item && item.terminal && item.terminal.eventName));
// The Terminal setting: one kind, or 'both' (Genesis and Dead Hand in one run).
const kindsOf = (variant) => (variant === BOTH ? VARIANTS : [variant]);
const validVariant = (v) => v === BOTH || VARIANTS.includes(v);
const nounOf = (variant) => (variant === BOTH ? 'terminal' : variant);                       // for plural()
const titleOf = (variant) => (variant === BOTH ? 'Genesis + Dead Hand terminals' : variant + 's');
const wanted = (item, variant, events) => !!item && item.isTerminal && kindsOf(variant).includes(item.name) && statusOf(item) !== 'done'
    && (events === 'all' || (events === 'event') === isEventItem(item));

// Every terminal of the chosen kind(s) an account holds (both inventory views, merged by id).
async function terminalsOf(aid, variant) {
    const seen = new Map();
    for (const kind of kindsOf(variant)) {
        for (const fav of ['', '&favoriteSkinsFilter=showFavorites']) {
            for (let page = 1, pages = 1; page <= pages && page <= MAX_PAGES; page++) {
                const j = await call(aid, 'GET', `/api/inventory?page=${page}&sort=price&search=${encodeURIComponent(kind)}&showStickers=true&showUpgradedSkins=true${fav}`);
                pages = num(j && j.pages) || 1;
                const items = (j && j.skins) || [];
                for (const it of items) if (it && it.isTerminal && it._id && !seen.has(it._id)) seen.set(it._id, it);
                if (!items.length) break;
            }
        }
    }
    return [...seen.values()];
}
function countsOf(items, variant) {
    const c = { sealed: 0, open: 0, event: 0, regular: 0, favourite: 0, total: 0, genesis: 0, deadHand: 0 };
    const kinds = kindsOf(variant);
    for (const it of items) {
        if (!kinds.includes(it.name)) continue;
        const s = statusOf(it); if (s === 'done') continue;
        c[s]++; c.total++; c[isEventItem(it) ? 'event' : 'regular']++; if (it.isFavorite) c.favourite++;
        c[it.name === VARIANTS[0] ? 'genesis' : 'deadHand']++;
    }
    return c;
}
// Favourite every waiting terminal so nothing sells it before its turn. `always`: carry on after a STOP.
async function protect(aid, items, always) {
    let n = 0;
    for (const it of items) {
        if (!always && run && run.stop) break;
        if (!it.isFavorite) { try { await setFavourite(aid, it._id, true); it.isFavorite = true; n++; } catch (e) { if (e.kind === 'stopping') break; } }
    }
    return n;
}

// --- Where an account's requests leave from (its exit IP group) ---------------------------------------
function groups() {
    const out = new Map();
    try {
        const st = ctx.network.state(), routeGroup = new Map((st.routes || []).map(r => [r.id, r.group]));
        for (const a of st.accounts || []) { const route = a.route || 'direct'; out.set(a.id, routeGroup.get(route) || route); }
    } catch (_) {}
    return out;
}

// --- Scan (the Accounts card's counts) -------------------------------------------------------------
function chosen() { return ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id)); }
async function doScan() {
    if (scan && scan.running) return { ok: false, message: 'A scan is already running' };
    const list = chosen().filter(a => a.healthy);
    if (!list.length) return { ok: false, message: 'None of the chosen accounts is clicking' };
    const variant = S('variant');
    scan = { at: Date.now(), variant, running: true, accounts: scan && scan.variant === variant ? scan.accounts : {} };
    let i = 0;
    const worker = async () => { while (i < list.length && !off()) { const a = list[i++];
        try { scan.accounts[a.id] = countsOf(await terminalsOf(a.id, variant), variant); } catch (e) { scan.accounts[a.id] = { error: e.message }; } } };
    Promise.all(Array.from({ length: Math.min(4, list.length) }, worker)).finally(() => { scan.running = false; scan.at = Date.now(); });
    return { ok: true, message: `Counting ${titleOf(variant)} on ${plural(list.length, 'account')}…` };
}

// --- One account's lane -------------------------------------------------------------------------------
// Open one terminal to the end (bought, or destroyed after offer 5).
async function openOne(lane, item) {
    rollDay();
    const aid = lane.id, id = item._id, ev = isEventItem(item);
    if (item.isFavorite) await setFavourite(aid, id, false);        // a favourite can't be opened — unfavourited only now
    let doc = docOf(await loadTerminal(aid, id));
    if (!doc) throw new Error('no terminal in the reply');
    const gap = GAP[S('speed')] ?? 200;
    let reloads = 0;
    for (let guard = 0; guard < OFFER_GUARD; guard++) {
        const idx = pendingIdx(doc);
        if (idx < 0) return 'empty';
        if (run.stop || off()) {   // STOP: leave it half-opened (it carries on next run), favourited again if asked
            if (S('protectQueued') && !off()) { try { await setFavourite(aid, id, true); } catch (_) {} }
            return 'stopped';
        }
        const o = offersOf(doc)[idx], skin = o.offeredSkin || {}, n = offersOf(doc).filter(x => x.accepted === false).length;
        const isFinal = n === MAX_OFFERS - 1, d = decide(skin, isFinal, rulesNow());
        lane.current = { offer: n + 1, skin: skin.name, float: skin.float, price: num(o.offeredPrice), event: ev };
        let res;
        try { res = await answer(aid, id, d.buy); }
        catch (e) {
            // A lost reply may have landed: look at the terminal again and carry on from where it really is.
            if (e.lost && reloads++ < 3) {
                await ctx.sleep(1500);
                try { doc = docOf(await loadTerminal(aid, id)); } catch (e2) { if (/not found/i.test(e2.message)) return 'gone'; throw e2; }
                if (!doc) throw e;
                continue;
            }
            if (/not found/i.test(e.message)) return 'gone';
            throw e;
        }
        const row = { at: Date.now(), account: lane.name, name: skin.name, float: skin.float, rarity: skin.rarity, price: num(o.offeredPrice), worth: num(skin.price),
                      pattern: hasPattern(skin) ? (skin.patternId ?? true) : null, offer: n + 1, why: d.why, event: ev };
        if (d.buy) {
            lane.bought++; lane.spent += row.price; state.today.bought++; state.today.spent += row.price; state.today.worth += row.worth;
            if (d.match || (ev && S('keepEventBuys'))) {
                row.kept = true; lane.kept++; state.today.kept++;
                // Favourited so the Converter / Opener leave it on the account.
                if (skin._id) {
                    try { await setFavourite(aid, skin._id, true); row.fav = true; }
                    catch (e) { row.fav = false; log(aid, `bought ${skin.name} but favouriting it failed — ${e.message}`, 'warn'); }
                }
            }
            feed(state.accepted, row);
            return 'bought';
        }
        lane.passed++; state.today.passed++; feed(state.declined, row);
        if (res && res.shouldClose) return 'destroyed';
        const next = docOf(res);
        if (!next || pendingIdx(next) < 0 || (offersOf(next)[pendingIdx(next)].offeredSkin || {})._id === skin._id) {
            // No next offer in the reply: read the terminal once more (the script's advance check).
            try { doc = docOf(await loadTerminal(aid, id)); } catch (e) { if (/not found/i.test(e.message)) return 'destroyed'; throw e; }
            if (!doc) return 'destroyed';
            if (pendingIdx(doc) >= 0 && (offersOf(doc)[pendingIdx(doc)].offeredSkin || {})._id === skin._id) throw new Error('the terminal did not move past offer ' + (n + 1));
        } else doc = next;
        if (gap) await ctx.sleep(gap);
    }
    throw new Error('more answers than a terminal has offers');
}
function feed(list, row) { list.unshift(row); if (list.length > FEED_MAX) list.length = FEED_MAX; save(); }

async function prepare(lane) {
    lane.phase = 'preparing';
    try {
        const items = (await terminalsOf(lane.id, run.variant)).filter(it => wanted(it, run.variant, run.events));
        lane.total = items.length;
        const n = await protect(lane.id, items);
        if (n) log(lane.id, `${plural(n, 'waiting terminal')} favourited until opened`);
    } catch (e) { if (e.kind !== 'stopping') log(lane.id, 'could not favourite its waiting terminals — ' + e.message, 'warn'); }
    lane.prepared = true;
    if (lane.phase === 'preparing') lane.phase = run.stop ? 'stopped' : 'queued';
}

async function runLane(lane) {
    const aid = lane.id;
    lane.phase = 'scanning'; lane.startedAt = Date.now(); lane.why = null;
    ctx.accounts.setBusy(aid, 'opening terminals');
    ctx.accounts.want(aid, null);
    try {
        const items = (await terminalsOf(aid, run.variant)).filter(it => wanted(it, run.variant, run.events));
        items.sort((x, y) => (statusOf(x) === 'open' ? 0 : 1) - (statusOf(y) === 'open' ? 0 : 1));   // half-opened first
        lane.total = items.length;
        if (scan && scan.variant === run.variant) scan.accounts[aid] = countsOf(items, run.variant);
        if (!items.length) { lane.phase = 'done'; lane.why = `no ${titleOf(run.variant)}` +(run.events !== 'all' ? ` (${run.events})` : ''); return; }
        if (S('protectQueued')) await protect(aid, items.slice(1));
        lane.phase = 'opening';
        const c = countsOf(items, run.variant);
        log(aid, `opening ${plural(items.length, nounOf(run.variant))}` + (run.variant === BOTH ? ` (${c.genesis} Genesis, ${c.deadHand} Dead Hand)` : ''));
        let fails = 0;
        for (const it of items) {
            if (run.stop || off()) { lane.phase = 'stopped'; lane.why = 'run stopped'; return; }
            if (!healthy(aid)) throw new Error('account stopped clicking');
            try {
                const how = await openOne(lane, it);
                if (how === 'stopped') { lane.phase = 'stopped'; lane.why = 'run stopped'; return; }
                lane.done++; state.today.opened++; fails = 0; save();
            } catch (e) {
                if (e.kind === 'stopping') { lane.phase = 'stopped'; lane.why = 'plugin stopped'; return; }
                fails++; log(aid, `terminal …${String(it._id).slice(-6)} — ${e.message}`, 'warn');
                if (fails >= 3) throw new Error('3 terminals in a row failed — ' + e.message);
                await ctx.sleep(3000);
            }
            lane.current = null;
        }
        lane.phase = 'done';
    } catch (e) {
        lane.phase = off() ? 'stopped' : 'error'; lane.why = off() ? 'plugin stopped' : e.message;
        if (!off()) { log(aid, 'stopped — ' + e.message, 'error'); ctx.errors.raise(aid, 'CC-TERM-01', e.message); }
    } finally {
        lane.current = null; lane.endedAt = Date.now();
        // Stopped with the plugin: the saved session keeps this account for next time; nothing else to tidy (the host
        // already took the busy marks off).
        if (!off()) {
            ctx.accounts.setBusy(aid, null);
            if (lane.total && ENDED.includes(lane.phase)) {
                const sum = `${lane.done} opened · ${lane.bought} bought (${money(lane.spent)}) · ${lane.kept} kept`;
                log(aid, (lane.phase === 'done' ? 'finished — ' : lane.phase + ' — ') + sum, lane.phase === 'done' ? 'ok' : lane.phase === 'error' ? 'error' : 'info');
            }
            saveSession(); save();
        }
    }
}

// --- The run ---------------------------------------------------------------------------------------
function saveSession() {
    if (!run || run.ended) { state.session = null; save(); return; }
    const left = Object.values(run.lanes).filter(l => !ENDED.includes(l.phase)).map(l => l.id);
    state.session = left.length ? { accounts: left, variant: run.variant, events: run.events, savedAt: Date.now() } : null;
    save();
}
function begin(ids, variant, events, resumed) {
    rollDay();
    run = { id: Date.now(), startedAt: Date.now(), stop: false, ended: false, variant, events, lanes: {} };
    for (const aid of ids) {
        run.lanes[aid] = { id: aid, name: nameOf(aid), phase: healthy(aid) ? 'queued' : 'waiting', why: healthy(aid) ? null : 'not clicking', since: Date.now(),
                           total: 0, done: 0, bought: 0, passed: 0, spent: 0, kept: 0, prepared: false, group: null };
        ctx.errors.clear(aid, 'CC-TERM-01');
    }
    log(null, (resumed ? 'carrying on after a restart — ' : 'started — ') + plural(ids.length, 'account') + ', ' + titleOf(variant) + (events !== 'all' ? ` (${events} only)` : '') + ' · ' + rulesSummary(rulesNow()));
    saveSession();
}
function startRun() {
    if (run && !run.ended) return { ok: false, message: 'A run is already going' };
    const list = chosen();
    if (!list.length) return { ok: false, message: 'Choose the accounts first (Accounts card)' };
    if (!list.some(a => a.healthy)) return { ok: false, message: 'None of the chosen accounts is clicking' };
    begin(list.map(a => a.id), S('variant'), S('events'), false);
    pump();
    return { ok: true, message: `Opening on ${plural(list.length, 'account')}` };
}
function stopAll() {
    if (!run || run.ended) return { ok: false, message: 'Nothing is running' };
    run.stop = true;
    log(null, 'STOP — opening stops after the current offer');
    pump();
    return { ok: true, message: 'Stopping' };
}

// Every second: start lanes whose turn it is, and end the run when every lane has.
function pump() {
    if (!run || run.ended) return;
    const lanes = Object.values(run.lanes), g = groups();
    for (const l of lanes) {
        if (ENDED.includes(l.phase)) continue;
        if (run.stop && ['queued', 'waiting'].includes(l.phase)) { l.phase = 'stopped'; l.why = 'run stopped'; ctx.accounts.want(l.id, null); continue; }
        if (l.phase === 'waiting' && l.why === 'not clicking') {
            if (healthy(l.id)) { l.phase = 'queued'; l.why = null; }
            else if (Date.now() - l.since > WAIT_CLICKER_MS) { l.phase = 'error'; l.why = 'not clicking for 15 minutes'; }
        }
    }
    if (S('protectQueued') && !run.stop) {
        let prep = lanes.filter(l => l.phase === 'preparing').length;
        for (const l of lanes) { if (prep >= PREP_AT_ONCE) break; if (!l.prepared && l.phase === 'queued' && healthy(l.id)) { prep++; prepare(l); } }
    }
    const perIp = Math.max(1, Math.min(10, Math.round(num(S('perIp')) || 3)));
    const use = new Map();
    for (const l of lanes) if (ACTIVE.includes(l.phase) && l.group) use.set(l.group, (use.get(l.group) || 0) + 1);
    for (const l of lanes) {
        if (run.stop) break;
        if (l.phase !== 'queued' && !(l.phase === 'waiting' && l.why !== 'not clicking')) continue;
        if (S('protectQueued') && !l.prepared) continue;   // its waiting terminals get favourited first
        if (!healthy(l.id)) { l.phase = 'waiting'; l.why = 'not clicking'; l.since = Date.now(); continue; }
        const grp = g.get(l.id) || 'direct';
        if ((use.get(grp) || 0) >= perIp) { l.phase = 'waiting'; l.why = `${perIp} already opening on this IP`; continue; }
        const other = ctx.accounts.busy(l.id);
        if (other) {
            // The Armory hands an account over once its current battle ends; the Converter / Opener after their step.
            ctx.accounts.want(l.id, 'opening terminals');
            l.phase = 'waiting'; l.why = `waiting for ${other.plugin} (${other.what})`;
            continue;
        }
        l.group = grp; use.set(grp, (use.get(grp) || 0) + 1);
        runLane(l);
    }
    if (lanes.every(l => ENDED.includes(l.phase))) finish();
}
function finish() {
    if (!run || run.ended) return;
    run.ended = true; run.endedAt = Date.now();
    const L = Object.values(run.lanes), sum = (k) => L.reduce((t, l) => t + (l[k] || 0), 0);
    for (const l of L) ctx.accounts.want(l.id, null);
    log(null, (run.stop ? 'stopped' : 'finished') + ` — ${sum('done')} opened on ${plural(L.filter(l => l.done).length, 'account')} · ${sum('bought')} bought (${money(sum('spent'))}) · ${sum('kept')} kept`, run.stop ? 'info' : 'ok');
    saveSession();
}

// --- The tab -----------------------------------------------------------------------------------------
const PHASE = { queued: 'queued', waiting: 'waiting', preparing: 'favouriting waiting ones', scanning: 'reading inventory', opening: 'opening', done: 'done', stopped: 'stopped', error: 'error' };
function render() {
    rollDay();
    const T = state.today, R = rulesNow(), live = !!(run && !run.ended);
    const list = chosen(), variant = S('variant');
    const lanes = run ? Object.values(run.lanes) : [];
    const opening = lanes.filter(l => ACTIVE.includes(l.phase)).length, finished = lanes.filter(l => ENDED.includes(l.phase)).length;
    const buttons = live
        ?[{ label: 'Stop', action: 'stop', danger: true }]
        : [{ label: 'Start opening', action: 'start', primary: true, confirm: `Open every ${variant === BOTH ? 'Genesis and Dead Hand Terminal' : variant}${S('events') !== 'all' ? ' (' + S('events') + ' only)' : ''} on ${plural(list.length, 'account')}? Buys are charged at the offer price. Rules: ${rulesSummary(R)}.` },
           { label: scan && scan.running ? 'Counting…' : 'Count terminals', action: 'scan' }];
    const blocks = [
        { type: 'hero', level: live ? 'ok' : '', pill: live ? 'Opening' : 'Idle',
          title: live ? `${titleOf(run.variant)} · ${opening} opening · ${finished}/${lanes.length} accounts done` : `${titleOf(variant)} on ${plural(list.length, 'account')}`,
          text: rulesSummary(R), buttons },
        { type: 'stats', items: [
            { label: 'Opened today', value: T.opened.toLocaleString() }, { label: 'Bought', value: T.bought.toLocaleString() },
            { label: 'Spent', value: money(T.spent) }, { label: 'Worth', value: money(T.worth) }, { label: 'Kept', value: T.kept.toLocaleString() } ] },
    ];
    if (!list.length) blocks.push({ type: 'notice', level: 'warn', text: 'Choose the accounts that open in the Accounts card.' });
    if (run) blocks.push({ type: 'table', wrap: true, columns: ['Account', 'Status', 'Opened', 'Bought', 'Spent', 'Kept', 'Now'], rows: lanes.map(l => [
        l.name, PHASE[l.phase] || l.phase, l.total ? `${l.done} / ${l.total}` : '—', String(l.bought), money(l.spent), String(l.kept),
        l.current ? `offer ${l.current.offer}: ${l.current.skin || '?'} · ${fl(l.current.float, 6)} · ${money(l.current.price)}` : l.why || '' ]) });
    const sc = scan && scan.variant === variant ? scan : null, both = variant === BOTH;
    const scCols = ['Account', ...(both ? ['Genesis', 'Dead Hand'] : []), 'Sealed', 'Half-open', 'Regular', 'Event', 'Favourited'], pad = (r) => [...r, ...Array(scCols.length - r.length).fill('')];
    blocks.push({ type: 'card', id: 'accounts', open: !list.length, title: 'Accounts', summary: list.length ? `${plural(list.length, 'account')}` + (sc ? ` · counted ${ago(sc.at)}` : '') : 'none yet', keys: ['accounts'], bare: true,
        blocks: sc ? [{ type: 'table', columns: scCols, rows: list.map(a => { const c = sc.accounts[a.id];
            return !c ? pad([a.name, a.healthy ? '—' : 'not clicking']) : c.error ? pad([a.name, 'error: ' + c.error])
                : [a.name, ...(both ? [String(c.genesis), String(c.deadHand)] : []), String(c.sealed), String(c.open), String(c.regular), String(c.event), String(c.favourite)]; }) }] : [] });
    blocks.push({ type: 'card', id: 'what', open: false, title: 'What to open', summary: `${both ? 'Genesis + Dead Hand' : variant} ·${S('events')} · ${S('speed')} · ${S('perIp')} per IP`, keys: ['variant', 'events', 'speed', 'perIp', 'protectQueued'] });
    blocks.push({ type: 'card', id: 'rules', open: false, title: 'Buy rules (offers 1–4)', summary: R.autoDecide ? rulesSummary(R).split(' · offer 5')[0] : 'passed', keys: ['autoDecide', 'pattern', 'floatMode', 'lowFloat', 'highFloat', 'rarities', 'perRarity', 'customFloats'] });
    blocks.push({ type: 'card', id: 'final', open: false, title: 'Offer 5', summary: !R.finalAuto ? 'discarded' : R.finalMode === 'always' ? 'always bought' : 'bought only if a rule matches', keys: ['finalAuto', 'finalMode', 'keepEventBuys'] });
    const feedRows = (rows) => rows.slice(0, 40).map(r => [ago(r.at), r.account, `${r.name || '?'}${r.event ? ' (event)' : ''}`, fl(r.float, 8), r.rarity || '', money(r.price), money(r.worth), String(r.offer), r.why + (r.kept ? ' · kept' : '')]);
    const cols = ['When', 'Account', 'Skin', 'Float', 'Rarity', 'Price', 'Worth', 'Offer', 'Why'];
    blocks.push({ type: 'card', id: 'bought', open: false, title: 'Bought', summary: `${state.accepted.length} recent`, blocks: [{ type: 'table', wrap: true, columns: cols, rows: feedRows(state.accepted), empty: 'Nothing bought yet.' }] });
    blocks.push({ type: 'card', id: 'passed', open: false, title: 'Passed', summary: `${state.declined.length} recent`, blocks: [{ type: 'table', wrap: true, columns: cols, rows: feedRows(state.declined), empty: 'Nothing passed yet.' }] });
    blocks.push({ type: 'card', id: 'log', open: false, title: 'Log', summary: state.log[0] ? state.log[0].msg.slice(0, 80) : 'empty', blocks: [{ type: 'table', wrap: true, columns: ['When', 'Account', 'What'], rows: state.log.slice(0, 50).map(x => [ago(x.at), x.name || '', x.msg]) }] });
    return { blocks };
}

module.exports = {
    start(c) {
        ctx = c; halted = false;
        const saved = ctx.data.get() || {};
        state = { day: '', today: blankToday(), accepted: [], declined: [], log: [], session: null, ...saved };
        delete state.kept; delete state.returns;   // left over from 1.0.0 builds that had Trade back
        for (const k of ['accepted', 'declined', 'log']) if (!Array.isArray(state[k])) state[k] = [];
        run = null; scan = null; dirty = false;
        rollDay();
        ctx.errors.define('CC-TERM-01', { group: 'manual', text: 'The terminal opener stopped on this account.', fix: 'See the Terminals tab log, then press Start opening again — it carries on where it stopped.' });

        ctx.panel.tab('Terminals', render);
        ctx.panel.action('start', () => startRun());
        ctx.panel.action('stop', () => stopAll());
        ctx.panel.action('scan', () => doScan());
        ctx.panel.badge((aid) => {
            const l = run && !run.ended && run.lanes[aid];
            return l && ACTIVE.includes(l.phase) ? `Terminals ${l.done}/${l.total || '?'}` : null;
        });

        ctx.every(1000, () => { pump(); if (dirty) { dirty = false; ctx.data.set(state); } });

        // A run cut off by closing the app (or turning the plugin off): carry on with the accounts that had work left.
        const s = state.session;
        if (s && Array.isArray(s.accounts) && s.accounts.length && validVariant(s.variant)) {
            const known = new Set(ctx.accounts.list().map(a => a.id)), ids = s.accounts.filter(id => known.has(id));
            if (ids.length) begin(ids, s.variant, s.events || 'all', true); else state.session = null;
        }
    },

    stop() {
        // Keep what's needed to carry on next time (the session), and save.
        if (run && !run.ended) saveSession();
        if (ctx && state) { try { ctx.data.set(state); } catch (_) {} }
        halted = true;                       // loops still in flight end at their next check, without touching the session
        if (run) run.stop = true;
    },

    // offline tests
    _t: { decide, ruleMatch, statusOf, wanted, docOf, countsOf, rulesSummary },
};
