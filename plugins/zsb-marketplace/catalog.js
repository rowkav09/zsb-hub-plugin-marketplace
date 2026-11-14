'use strict';

const { createHash } = require('node:crypto');

const REPOSITORY = 'https://github.com/rowkav09/zsb-hub-plugin-marketplace';
const RAW_ROOT = 'https://raw.githubusercontent.com/rowkav09/zsb-hub-plugin-marketplace/main/';
const CATALOG_URL = new URL('catalog.json', RAW_ROOT).href;
const MAX_ZIP = 20 * 1024 * 1024;
const CATALOG_LIMIT = 512 * 1024;
const PLUGIN_ID = /^[a-z0-9-]{1,40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+\.zip$/i;
const RELEASE_ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function compareVersions(left, right) {
  const a = left.split('-')[0].split('.').map(Number);
  const b = right.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function downloadUrl(entry) {
  if (entry.download === `downloads/${entry.id}-${entry.version}.zip`) {
    return new URL(entry.download, RAW_ROOT).href;
  }
  if (typeof entry.download === 'string' && RELEASE.test(entry.download)) {
    return entry.download;
  }
  throw new Error(`${entry.id}: expected a repository ZIP or a versioned GitHub Release ZIP`);
}

function readCatalog(data) {
  if (data?.format !== 1 || !Array.isArray(data.plugins)) {
    throw new Error('Unsupported marketplace catalog format');
  }
  const ids = new Set();
  const plugins = [];
  for (const entry of data.plugins) {
    if (!entry || typeof entry.id !== 'string' || !PLUGIN_ID.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate marketplace ID: ${entry?.id}`);
    }
    ids.add(entry.id);
    if (entry.kind === 'bundled') continue;
    if (entry.kind !== 'community') throw new Error(`Unknown listing type: ${entry.id}`);

    for (const key of ['name', 'summary', 'author', 'license', 'source']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new Error(`${entry.id}: missing ${key}`);
      }
    }
    const versionFields = [entry.version, entry.minCore];
    if (versionFields.some(value => typeof value !== 'string' || !VERSION.test(value))
      || entry.defaultEnabled !== false || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new Error(`${entry.id}: expected versions, SHA-256 and defaultEnabled: false`);
    }
    downloadUrl(entry);
    plugins.push(entry);
  }
  return plugins;
}

async function requestBytes(url, { fetcher, maxBytes, signal, release = false }) {
  const options = { redirect: 'manual', cache: 'no-store', signal };
  let response = await fetcher(url, options);
  if (release && [301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    const target = location && URL.parse(location);
    if (!target || target.protocol !== 'https:' || target.port || target.username || target.password
      || !RELEASE_ASSET_HOSTS.has(target.hostname)) {
      throw new Error('Unexpected GitHub release download redirect');
    }
    response = await fetcher(target.href, options);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) {
      throw new Error('GitHub response exceeds the download limit');
    }
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maxBytes) throw new Error('GitHub response exceeds the download limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}

async function fetchCatalog(fetcher, signal) {
  const data = await requestBytes(CATALOG_URL, { fetcher, signal, maxBytes: CATALOG_LIMIT });
  return readCatalog(JSON.parse(data));
}

async function fetchPackage(entry, fetcher, signal) {
  const url = downloadUrl(entry);
  const zip = await requestBytes(url, { fetcher, signal, maxBytes: MAX_ZIP, release: RELEASE.test(url) });
  if (createHash('sha256').update(zip).digest('hex') !== entry.sha256) {
    throw new Error('ZIP checksum differs from the catalog. Refresh and retry.');
  }
  return zip;
}

module.exports = { REPOSITORY, CATALOG_URL, compareVersions, readCatalog, fetchCatalog, fetchPackage };
