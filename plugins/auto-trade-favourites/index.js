'use strict';

const { availablePrice, bounded, createBatch, favorite, idOk, money, Unconfirmed } = require('./farm-batch');

const FAVS = { favoriteSkinsFilter: 'only', showStickers: 'true' };
const EVENT_ERRORS = ['tradeError', 'tradeWatchError', 'tradeExited', 'tradeKicked', 'tradeDeleted', 'tradeSkinsCapped'];

function settings(api) {
  const maxPrice = api.get('maxPrice'), minPrice = api.get('minPrice');
  if (!Number.isFinite(maxPrice) || maxPrice <= 0 || !Number.isFinite(minPrice) || minPrice < 0 || minPrice > maxPrice) {
    throw Error('Set a positive maximum value and a valid price range.');
  }
  return {
    maxPrice, minPrice,
    names: (api.get('names') || []).map(name => name.toLowerCase()),
    limit: bounded(api.get('items'), 1, 50, 10), trades: bounded(api.get('trades'), 1, 20, 3),
    reserve: bounded(api.get('reserve'), 0, 100, 5), pages: bounded(api.get('pages'), 1, 20, 3),
  };
}

function eligible(item, rules) {
  return favorite(item) && typeof item.name === 'string' && !item.isSticker && !item.isKeychain && !item.isTerminal
    && availablePrice(item, rules.maxPrice) && item.price >= rules.minPrice
    && (!rules.names.length || rules.names.some(name => item.name.toLowerCase().includes(name)));
}

function receiverRoom(profile, rules) {
  if (!Number.isSafeInteger(profile?.dailyTradesLeft) || profile.dailyTradesLeft <= rules.reserve) return 0;
  if (!Number.isSafeInteger(profile.inventorySize) || !Number.isSafeInteger(profile.inventoryCount)) return 0;
  return Math.max(0, profile.inventorySize - profile.inventoryCount);
}

function tradeLimit(profile, rules) {
  const limit = profile?.tradeItems;
  return Math.min(rules.limit, Number.isSafeInteger(limit) && limit > 0 ? limit : 50);
}

async function scan(api) {
  const rules = settings(api);
  const receiver = api.account(api.get('receiver'));
  if (!receiver) throw Error('Choose the receiving Hub account.');
  const toRoute = api.route(receiver.id);
  const profile = await api.read(receiver.id, toRoute, '/api/me');
  let room = receiverRoom(profile, rules);
  if (!room) throw Error('Receiver capacity or remaining trades are unavailable.');
  const jobs = [], rows = [], notes = [];
  const accounts = api.selected('accounts').filter(account => account.id !== receiver.id);
  if (!accounts.length) throw Error('Choose one or more different sender accounts.');
  const maximum = Math.min(rules.trades, profile.dailyTradesLeft - rules.reserve);
  for (const sender of accounts) {
    if (jobs.length >= maximum || !room) break;
    const route = api.route(sender.id);
    try {
      const source = await api.read(sender.id, route, '/api/me');
      const found = await api.inventory(sender.id, route, rules.pages, FAVS);
      const skins = found.items.filter(item => eligible(item, rules)).sort((a, b) => a.price - b.price || a._id.localeCompare(b._id))
        .slice(0, Math.min(room, tradeLimit(source, rules))).map(item => ({ id: item._id, name: item.name, price: item.price }));
      if (!found.complete) notes.push([sender.name, 'Scan reached the page cap.']);
      if (!skins.length) {
        notes.push([sender.name, 'No eligible favourited skins.']);
        continue;
      }
      room -= skins.length;
      for (const item of skins) rows.push([sender.name, receiver.name, item.name, money(item.price)]);
      jobs.push({ from: sender.id, to: receiver.id, route, toRoute, skins, result: [sender.name, receiver.name] });
    } catch (error) {
      notes.push([sender.name, error.message]);
    }
  }
  return { jobs, rows, notes, rules };
}

async function identity(api, id, route) {
  const profile = await api.read(id, route, '/api/user/profile');
  if (typeof profile?.userId !== 'string' || !/^[\w-]{1,128}$/.test(profile.userId)) throw Error('Could not confirm the site account.');
  return profile.userId;
}

function send(socket, event, data) {
  if (socket.emit(event, data) === false) throw Error('Trade socket disconnected.');
}

async function waitFor(socket, events, accept, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const event = await socket.wait([...events, ...EVENT_ERRORS], Math.max(1, deadline - Date.now()));
    if (!event) break;
    if (EVENT_ERRORS.includes(event.ev)) throw Error('The site interrupted the trade (' + event.ev + ').');
    if (accept(event.data)) return event.data;
  }
  throw Error('The site did not confirm a trade step.');
}

function participants(data, tradeId, source, destination) {
  if (data?._id !== tradeId) return false;
  const host = data.host?.user?.userId, guest = data.guest?.user?.userId;
  if (host !== source || (guest && guest !== destination) || data.hostTokens !== 0 || data.guestTokens !== 0) {
    throw Error('Trade participants or token amounts changed.');
  }
  return guest === destination;
}

async function verifiedReceipt(api, job, skins) {
  const required = new Set(skins.map(skin => skin.id));
  for (const name of new Set(skins.map(skin => skin.name))) {
    const received = await api.inventory(job.to, job.toRoute, 10, { search: name, showStickers: 'true' });
    for (const item of received.items) required.delete(item._id);
  }
  return !required.size;
}

async function transfer(api, job, skins) {
  const source = await identity(api, job.from, job.route);
  const destination = await identity(api, job.to, job.toRoute);
  if (source === destination) throw Error('Sender and receiver are the same site account.');
  let sender, receiver, tradeId, confirmSent = false;
  const check = () => { api.check(job.from, job.route); api.check(job.to, job.toRoute); };
  try {
    sender = await api.socket(job.from, job.route);
    receiver = await api.socket(job.to, job.toRoute);
    check();
    const trade = await api.write(job.from, job.route, '/api/trading', 'POST');
    if (trade === null) return 'The site refused to create the trade.';
    if (!idOk(trade?._id)) throw new Unconfirmed('The trade was created without a readable ID.');
    tradeId = trade._id;
    const joined = data => participants(data, tradeId, source, destination);
    send(sender, 'watchTrade', tradeId);
    await waitFor(sender, ['tradeInfo'], data => {
      if (data?._id !== tradeId) return false;
      joined(data);
      return true;
    });
    send(receiver, 'watchTrade', tradeId);
    await waitFor(receiver, ['tradeInfo'], joined);
    await waitFor(sender, ['tradeInfo'], joined);
    check();
    const event = { tradeId, userId: source };
    send(sender, 'tradeAddSkins', { ...event, skinIds: skins.map(item => item.id) });
    // Both controlled accounts join an empty trade. Verify its participants and zero tokens
    // at each stage, then check the exact received inventory IDs after confirmation.
    await waitFor(sender, ['tradeInfo'], joined);
    check();
    send(sender, 'tradeAccept', event);
    await waitFor(sender, ['tradeAccepted'], data => joined(data) && data.host.hasAccepted === true);
    check();
    send(receiver, 'tradeAccept', { tradeId, userId: destination });
    await waitFor(sender, ['tradeAccepted'], data => joined(data) && data.host.hasAccepted === true && data.guest.hasAccepted === true);
    check();
    confirmSent = true;
    send(sender, 'tradeConfirm', event);
    await waitFor(sender, ['tradeConfirmed'], joined, 15000);
    for (let check = 0; check < 3; check++) {
      if (await verifiedReceipt(api, job, skins)) return skins.length + ' received.';
      if (check < 2) await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw Error('The receiver inventory did not contain every approved skin.');
  } catch (error) {
    if (confirmSent || error instanceof Unconfirmed) {
      throw new Unconfirmed('Trade' + (tradeId ? ' ' + tradeId : '') + ' needs review. ' + error.message);
    }
    if (tradeId && sender) {
      try {
        send(sender, 'tradeDelete', { userId: source, tradeId });
        const cancelled = await sender.wait(['tradeDeleted', 'tradeError'], 6000);
        if (cancelled?.ev !== 'tradeDeleted') throw Error('Cancellation not confirmed.');
      } catch {
        throw new Unconfirmed('Trade ' + tradeId + ' may still be open. Check the Trading page.');
      }
    }
    throw error;
  } finally {
    sender?.close();
    receiver?.close();
  }
}

async function apply(api, job, plan) {
  return api.lock([[job.from, job.route], [job.to, job.toRoute]], async () => {
    const profile = await api.read(job.to, job.toRoute, '/api/me');
    const room = receiverRoom(profile, plan.rules);
    if (!room) return 'Receiver limit reached.';
    const source = await api.read(job.from, job.route, '/api/me');
    const found = await api.inventory(job.from, job.route, plan.rules.pages, FAVS);
    const byId = new Map(found.items.map(item => [item._id, item]));
    const skins = job.skins.filter(skin => {
      const item = byId.get(skin.id);
      return item && item.name === skin.name && item.price <= skin.price && eligible(item, plan.rules);
    }).slice(0, Math.min(room, tradeLimit(source, plan.rules)));
    return skins.length ? transfer(api, job, skins) : 'No approved favourites remain eligible.';
  });
}

let stop;
module.exports = {
  start(ctx) {
    stop = createBatch(ctx, {
      title: 'Auto Trade Favourites', tab: 'Trade Favourites',
      keys: ['runMode', 'on', 'accounts', 'receiver', 'names', 'minPrice', 'maxPrice', 'items', 'trades', 'reserve', 'pages', 'minutes'],
      columns: ['Sender', 'Receiver', 'Skin', 'Value'], resultColumns: ['Sender', 'Receiver'],
      applyLabel: 'Send previewed favourites',
      confirm: plan => 'Send up to ' + plan.rows.length + ' approved skins to ' + plan.rows[0][1] + ' in one-way trades?',
      scan, apply,
    });
  },
  stop() { stop?.(); },
};
