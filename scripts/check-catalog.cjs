'use strict';

const assert = require('node:assert/strict');
const catalog = require('../catalog.json');
const { readCatalog } = require('../plugins/zsb-marketplace/catalog');
const list = readCatalog(catalog);

for (const entry of list) {
  if (entry.download.startsWith('https://')) continue;
  assert.equal(entry.source, `plugins/${entry.id}/`);
  const manifest = require(`../plugins/${entry.id}/plugin.json`);
  for (const key of ['id', 'name', 'version', 'minCore', 'defaultEnabled']) {
    assert.equal(manifest[key], entry[key], `${entry.id}: mismatch on ${key}`);
  }
}
console.log(`Validated ${catalog.plugins.length} catalog entries (${list.length} installable community ZIPs).`);
