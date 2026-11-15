'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('Auction Sniper previews only the main account and binds its bid to the same account and lot', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zsb-auction-fixture-'));
  cpSync(path.join(__dirname, '../plugins/auction-sniper'), dir, { recursive: true });
  cpSync(path.join(__dirname, '../shared/cco-price-data.js'), path.join(dir, 'cco-price-data.js'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = require(path.join(dir, 'index.js'));
  const { PriceData } = require(path.join(dir, 'cco-price-data.js'));
  PriceData.prototype.load = async function () { this.ready = true; };
  const id = 'a'.repeat(24), skin = 'b'.repeat(24);
  const lot = { _id: id, userId: 'someone-else', status: 'active', isLocked: false,
    auctionedSkinId: { _id: skin, name: 'Fixture', price: 30 }, currentBid: 10, startingPrice: 10,
    expiresAt: new Date(Date.now() + 300000).toISOString() };
  const settings = { on: false, tokensPerDollar: 10, percent: 60, bidCap: 100, budget: 100 };
  let main = 'main', state = {}, draw, socketCount = 0, emitted = [];
  const actions = new Map();
  plugin.start({
    data: { get: () => state, set(value) { state = value; } },
    accounts: { main: () => main, get: () => ({ healthy: true }), busy: () => null, wanted: () => null, setBusy() {} },
    network: { state: () => ({ accounts: [{ id: 'main', route: 'r' }, { id: 'alt', route: 'r' }] }) },
    settings: { get: name => settings[name], onChange() {} },
    power: { practice: () => false, live: () => false },
    panel: { action: (name, fn) => actions.set(name, fn), tab: (_, fn) => { draw = fn; } },
    every() {},
    async request(acct, request) {
      assert.equal(acct, 'main');
      const json = request === '/api/me' ? { tokens: 1000 }
        : request === '/api/auth/get-session' ? { user: { id: 'player' } }
          : request.includes('?') ? { auctions: [lot, { ...lot, _id: 'c'.repeat(24), userId: 'player' }] }
            : { auction: lot };
      return { kind: 'ok', json };
    },
    async socket(acct) {
      assert.equal(acct, 'main');
      socketCount++;
      return { emit(name, body) { emitted.push([name, body]); return true; },
        async wait() { return { ev: 'autobidSet', data: { auctionId: id, maxBid: 100 } }; }, close() {} };
    },
  });
  t.after(() => plugin.stop());
  const token = () => draw().blocks.flatMap(block => block.items || []).find(button => button.action === 'apply').arg;
  assert.match((await actions.get('check-connection')()).message, /Auction connection verified/);
  assert.equal(socketCount, 1);
  assert.deepEqual(emitted, []);
  assert.match((await actions.get('preview')()).message, /1 matching/);
  const old = token(); main = 'alt';
  assert.equal((await actions.get('apply')(old)).ok, false);
  assert.equal(socketCount, 1);
  main = 'main';
  await actions.get('preview')();
  assert.match((await actions.get('apply')(token())).message, /1 autobid/);
  assert.deepEqual(emitted, [['setAutobid', { auctionId: id, maxBid: 100 }]]);
  assert.equal(state.placed[0].cap, 100);
});
