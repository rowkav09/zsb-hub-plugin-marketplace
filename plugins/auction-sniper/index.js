'use strict';

const { randomUUID } = require('node:crypto');
const { PriceData } = require('./cco-price-data');

const HOUR = 60 * 60_000;
const PREVIEW_TTL = 2 * 60_000;
const keys = ['runMode', 'on', 'tokensPerDollar', 'percent', 'bidCap', 'budget'];
const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const identity = value => typeof value === 'string' ? value : value?._id ?? value?.id ?? value?.userId;
const count = value => Math.round(value).toLocaleString('en-US');
const validPrice = value => Number.isFinite(value) && value >= 0;

function nextBid(auction) {
  if (!validPrice(auction.currentBid) || !validPrice(auction.startingPrice)) return null;
  if (auction.currentBid === 0) return Math.max(1, Math.round(auction.startingPrice));
  const increment = auction.minBidIncrement > 0 ? auction.minBidIncrement
    : Math.max(1, Math.round(auction.currentBid * (auction.currentBid >= 1e9 ? .01 : .1)));
  return Math.round(auction.currentBid + increment);
}

function quote(auction, user, prices, rules) {
  const seller = identity(auction.userId) || identity(auction.seller);
  const bidder = identity(auction.currentBidder);
  if (!validId(auction._id) || !seller || seller === user || identity(auction.seller) === user || bidder === user
    || auction.status !== 'active' || auction.isLocked !== false
    || !(Date.parse(auction.expiresAt) > Date.now()) || (auction.consecutiveBidCount || 0) >= 3) return null;
  const skin = auction.auctionedSkinId;
  if (!validId(skin?._id) || typeof skin.name !== 'string') return null;
  const estimate = prices.calcDollarPrice(skin);
  if (!validPrice(estimate.calc) || !estimate.calc || estimate.source.includes('unpriced')) return null;
  const minimum = nextBid(auction);
  const value = estimate.calc * rules.rate;
  const ceiling = Math.floor(Math.min(value * rules.percent / 100, rules.bidCap || 1e9, 1e9));
  if (minimum === null || minimum > ceiling) return null;
  return { id: auction._id, skin: skin._id, name: skin.name, value, minimum, ceiling, ends: Date.parse(auction.expiresAt) };
}

function start(ctx) {
  const prices = new PriceData();
  let preview, results = [], notice = '', working = '', revision = 0;
  let stopped = false, connection, verified;
  const data = ctx.data.get();
  let placed = Array.isArray(data?.placed) ? data.placed : [];

  function main() {
    const id = ctx.accounts.main();
    const route = ctx.network.state().accounts.find(account => account.id === id)?.route;
    if (!id || !route || !ctx.accounts.get(id)?.healthy) throw Error('Start your configured Hub main account first.');
    return { id, route, revision };
  }

  function assertMain(account) {
    if (stopped || ctx.stopping || revision !== account.revision) throw Error('Auction action stopped.');
    const live = main();
    if (live.id !== account.id || live.route !== account.route) throw Error('The main account or route changed. Scan again.');
  }

  async function read(account, path) {
    assertMain(account);
    const reply = await ctx.request(account.id, path, { method: 'GET', tries: 1, timeoutMs: 12_000 });
    assertMain(account);
    if (reply?.kind !== 'ok') throw Error('Auction data unavailable (' + (reply?.status || reply?.kind) + ').');
    return reply.json;
  }

  async function siteUser(account) {
    const session = await read(account, '/api/auth/get-session');
    const user = session?.user?.id || session?.session?.userId;
    if (typeof user !== 'string' || !user) throw Error('Hub could not verify the main account’s current session.');
    return user;
  }

  const get = key => ctx.settings.get(key);
  function rules() {
    return { rate: get('tokensPerDollar'), percent: get('percent'), bidCap: Math.floor(get('bidCap')), budget: Math.floor(get('budget')) };
  }

  function spent() {
    return placed.filter(row => row.at > Date.now() - 24 * HOUR).reduce((total, row) => total + row.cap, 0);
  }

  function save() {
    placed = placed.filter(row => row.at > Date.now() - 24 * HOUR || row.ends > Date.now());
    ctx.data.set({ placed });
  }

  async function scan() {
    const account = main(), limits = rules();
    if (!Number.isFinite(limits.rate) || limits.rate <= 0) throw Error('Enter a positive token conversion.');
    await prices.load();
    const user = await siteUser(account);
    const options = new Map();
    for (const sort of ['endingSoon', 'newest']) {
      const listing = await read(account, '/api/auctions?page=1&limit=30&includeEnded=false&sort=' + sort);
      if (!Array.isArray(listing?.auctions)) throw Error('Auction list unavailable.');
      for (const auction of listing.auctions) {
        if (placed.some(bid => bid.id === auction._id)) continue;
        const candidate = quote(auction, user, prices, limits);
        if (candidate) options.set(candidate.id, candidate);
      }
    }
    const plan = { account, user, limits, rows: [...options.values()].sort((a, b) => a.ends - b.ends), token: randomUUID(), at: Date.now() };
    plan.approved = choose(plan);
    return plan;
  }

  function choose(plan) {
    let available = Math.max(0, plan.limits.budget - spent());
    return !plan.limits.bidCap ? [] : plan.rows.filter(row => {
      if (row.ceiling > available) return false;
      available -= row.ceiling;
      return true;
    });
  }

  async function apply(plan) {
    const { account, limits, user } = plan;
    assertMain(account);
    if (ctx.accounts.busy(account.id) || ctx.accounts.wanted(account.id)) throw Error('Another plugin is using the main account.');
    const bids = plan.approved;
    if (!bids.length) return 'No eligible bids within the set budgets.';
    if (await siteUser(account) !== user) throw Error('The main account session changed. Scan again.');
    if (ctx.accounts.busy(account.id) || ctx.accounts.wanted(account.id)) throw Error('Another plugin is using the main account.');
    ctx.accounts.setBusy(account.id, 'Auction Sniper');
    let confirmed = 0;
    try {
      connection = await ctx.socket(account.id);
      for (const proposed of bids) {
        assertMain(account);
        const live = (await read(account, '/api/auctions/' + proposed.id))?.auction;
        const fresh = live && quote(live, user, prices, limits);
        if (!fresh || fresh.id !== proposed.id || fresh.skin !== proposed.skin || fresh.minimum > proposed.ceiling) continue;
        const balance = (await read(account, '/api/me'))?.tokens;
        const cap = Math.min(fresh.ceiling, proposed.ceiling);
        if (!validPrice(balance) || cap > balance || cap > limits.budget - spent() || cap < fresh.minimum) continue;
        assertMain(account);
        if (ctx.accounts.busy(account.id) || ctx.accounts.wanted(account.id)) break;
        const entry = { id: proposed.id, at: Date.now(), ends: fresh.ends, cap };
        placed.push(entry);
        save();
        let answer;
        try {
          const sent = await connection.emit('setAutobid', { auctionId: proposed.id, maxBid: cap });
          if (sent) answer = await connection.wait(['autobidSet', 'autobidFailed'], 10_000);
        } catch {
          // The server might already have received the bid. Keep its commitment recorded.
        }
        if (answer?.ev !== 'autobidSet' || answer.data?.auctionId !== proposed.id || Number(answer.data.maxBid) !== cap) {
          results.push([proposed.name, 'Check this auction in Case Clicker', count(cap)]);
          if (get('on')) ctx.settings.set('on', false);
          throw Error('Autobid unconfirmed. Check the auction before placing further bids.');
        }
        confirmed++;
        results.push([proposed.name, 'Confirmed', count(cap)]);
      }
    } finally {
      connection?.close();
      connection = null;
      ctx.accounts.setBusy(account.id, null);
    }
    return confirmed + ' autobid(s) confirmed.';
  }

  async function run(label, action) {
    if (working) return { ok: false, message: 'Wait for the current auction action.' };
    working = label;
    try {
      notice = await action();
      return { message: notice };
    } catch (error) {
      notice = error.message;
      return { ok: false, message: notice };
    } finally { working = ''; }
  }

  ctx.settings.onChange(() => { revision++; preview = undefined; });
  ctx.panel.action('check-connection', () => run('Checking the Hub main account…', async () => {
    verified = undefined;
    const account = main();
    await siteUser(account);
    const socket = await ctx.socket(account.id);
    try {
      assertMain(account);
      verified = { id: account.id, route: account.route };
      return 'Main account connected through Hub. Auction connection verified.';
    } finally {
      socket.close();
    }
  }));
  ctx.panel.action('preview', () => run('Scanning auctions…', async () => {
    preview = await scan();
    return preview.rows.length + ' matching auctions.';
  }));
  ctx.panel.action('apply', token => run('Confirming autobids…', async () => {
    const planned = preview;
    if (!planned || planned.token !== token || Date.now() - planned.at > PREVIEW_TTL) throw Error('Scan auctions again first.');
    if (ctx.power.practice()) throw Error('Switch to Live, then scan again.');
    preview = undefined;
    results = [];
    return apply(planned);
  }));
  ctx.panel.action('stop', () => {
    revision++;
    if (get('on')) ctx.settings.set('on', false);
    return { message: 'Auction Sniper paused.' };
  });
  ctx.every(60_000, () => {
    if (!ctx.power.live() || working || !get('bidCap') || get('budget') <= spent()) return;
    if (preview && Date.now() - preview.at <= PREVIEW_TTL) return;
    return run('Scanning and placing capped autobids…', async () => {
      results = [];
      return apply(await scan());
    });
  });

  ctx.panel.tab('Auction Sniper', () => {
    const mainId = ctx.accounts.main();
    const account = ctx.accounts.get(mainId);
    const route = ctx.network.state().accounts.find(account => account.id === mainId)?.route;
    const connected = account?.healthy && verified?.id === mainId && verified.route === route;
    const rows = preview?.rows || [];
    const approved = preview?.approved || [];
    const items = working ? [{ action: 'stop', label: 'Stop', danger: true }] : [
      { action: 'preview', label: 'Scan auctions', primary: true },
      { action: 'check-connection', label: 'Check Hub connection' },
    ];
    if (!working && preview && approved.length && !ctx.power.practice() && Date.now() - preview.at <= PREVIEW_TTL) {
      items.push({ action: 'apply', arg: preview.token, label: 'Place previewed autobids',
        confirm: 'Place up to ' + approved.length + ' autobids on your main account for at most ' +
          count(approved.reduce((sum, bid) => sum + bid.ceiling, 0)) + ' tokens?' });
    }
    return { blocks: [
      { type: 'notice', text: account ? 'Hub main account · ' + account.name
        + (connected ? ' · Auction connection verified' : account.healthy ? ' · Uses your Hub session' : ' · Start this account in Hub')
        : 'Set a main account in Hub Settings.' },
      { type: 'settings', keys },
      { type: 'buttons', items },
      ...(working || notice ? [{ type: 'notice', text: working || notice }] : []),
      { type: 'stats', items: [{ label: 'Tokens committed in the last 24 hours', value: count(spent()) }] },
      ...(rows.length ? [{ type: 'table', columns: ['Auction', 'Estimated tokens', 'Minimum bid', 'Autobid cap'],
        rows: rows.map(row => [row.name, count(row.value), count(row.minimum), count(row.ceiling)]) }] : []),
      ...(results.length ? [{ type: 'table', columns: ['Auction', 'Outcome', 'Tokens'], rows: results }] : []),
    ] };
  });

  return () => { stopped = true; connection?.close(); };
}

let stop;
module.exports = { start(ctx) { stop = start(ctx); }, stop() { stop?.(); }, nextBid, quote };
