'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { checkArchive } = require('../scripts/scan-plugin.cjs');

test('flags direct and aliased access to restricted modules and runtime globals', () => {
  const source = [
    "require('node:child_process');",
    'const load = require;',
    "load('node:fs');",
    'process.env.SECRET;',
    "require('../outside');",
  ].join('\n');
  const { findings } = checkArchive({ id: 'sample', files: { 'index.js': source } });
  assert.deepEqual(findings, [
    'index.js:1 privileged-module',
    'index.js:2 dynamic-module',
    'index.js:4 runtime-access',
    'index.js:5 module-outside-package',
  ]);
});

test('flags data exfiltration, private files, dynamic code and opaque executables', () => {
  const source = [
    "fetch('https://example.invalid/collect');",
    "eval('42');",
    "const credentials = 'accounts.json';",
  ].join('\n');
  const { findings } = checkArchive({ id: 'sample', files: { 'index.js': source, 'payload.wasm': '' } });
  for (const rule of ['external-network', 'external-url', 'dynamic-code', 'credential-path', 'unreviewed file type']) {
    assert(findings.some(finding => finding.endsWith(rule)), rule);
  }
});

test('allows local modules and documented Hub APIs', () => {
  const result = checkArchive({ id: 'sample', files: {
    'index.js': "const helper = require('./helper'); module.exports = { start(ctx) { ctx.request('fixture', helper()); } };",
    'helper.js': "module.exports = () => '/api/me';",
    'plugin.json': '',
  } });
  assert.deepEqual(result.findings, []);
});

test('reviewed exceptions apply only to the exact source and approved rules', () => {
  const id = 'daily-reports';
  const source = readFileSync(path.join(__dirname, '../plugins/daily-reports/index.js'), 'utf8');
  const original = checkArchive({ id, files: { 'index.js': source } });
  assert.deepEqual(original.findings, []);
  assert(original.exceptions.some(finding => finding.endsWith('privileged-module')));
  const altered = checkArchive({ id, files: { 'index.js': source + "\nfetch('https://example.invalid');" } });
  assert.deepEqual(altered.exceptions, []);
  assert(altered.findings.some(finding => finding.endsWith('privileged-module')));
  assert(altered.findings.some(finding => finding.endsWith('external-network')));
});
