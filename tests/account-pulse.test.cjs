'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const plugin = require('../plugins/account-pulse/index.js');
const manifest = require('../plugins/account-pulse/plugin.json');

test('Account Pulse renders cached statuses and counts without requesting account data', () => {
  const accounts = [
    { name: 'Healthy example', running: true, healthy: true },
    { name: 'Paused example', running: true, healthy: false },
    { name: 'Stopped example', running: false, healthy: false },
  ];
  const actions = new Map();
  let render;
  let onlyRunning = false;
  plugin.start({
    accounts: { list: () => accounts },
    settings: {
      get(key) {
        assert.equal(key, 'runningOnly');
        return onlyRunning;
      },
    },
    panel: {
      tab(title, fn) {
        assert.equal(title, manifest.tab);
        render = fn;
      },
      action: (name, fn) => actions.set(name, fn),
    },
  });

  const [stats, , table, buttons] = render().blocks;
  assert.deepEqual(stats.items.map(item => item.value), [3, 1, 1, 1]);
  assert.deepEqual(table.rows, [
    ['Healthy example', 'Healthy'],
    ['Paused example', 'Needs attention'],
    ['Stopped example', 'Stopped'],
  ]);
  assert.equal(actions.get(buttons.items[0].action)().message, '1 of 3 accounts are clicking normally.');

  onlyRunning = true;
  const [filteredStats, , filteredTable] = render().blocks;
  assert.deepEqual(filteredStats, stats);
  assert.deepEqual(filteredTable.rows, table.rows.slice(0, 2));

  accounts.length = 0;
  assert.deepEqual(render().blocks[2].rows, []);
});
