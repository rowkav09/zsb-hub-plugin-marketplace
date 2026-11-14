import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));
// Release public key from ZSB Hub 1.2.7-beta.1 (fingerprint e16adbd3b41df209).
const key = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiHLZ9CsuR/8IGAPoIFdvP1RwtPPkOkqr25MhTi0H4g0=
-----END PUBLIC KEY-----`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const limit = 5 * 1024 * 1024;
const { commit, files, updatedAt } = catalog.publisherFeed;
assert.match(commit, /^[a-f0-9]{40}$/);
const origin = `https://raw.githubusercontent.com/GothGirlZSB/zsb-hub-releases/${commit}/plugins/`;
assert.equal(files, origin, 'Publisher URLs must match the pinned upstream commit');

async function get(name) {
  assert.match(name, /^[a-z0-9.-]+$/);
  const response = await fetch(origin + name, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${name} download failed`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= limit, `${name} exceeds the Hub's download size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function verifyBundle(raw, entry) {
  const { id, version, minCore, file, size } = entry;
  assert.equal(raw.length, size, file);
  assert.equal(sha256(raw), entry.sha256, file);
  const bundle = JSON.parse(raw);
  assert.equal(bundle.format, 1, file);
  assert.equal(bundle.id, id, file);
  assert.equal(bundle.version, version, file);
  const decoded = new Map(Object.entries(bundle.files).map(([name, data]) => {
    assert(name.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part)), name);
    return [name, Buffer.from(data, 'base64')];
  }));
  const payload = [...decoded.keys()].filter(name => name.split('/').at(-1) !== 'plugin.sig').sort()
    .map(name => `${name}\n${sha256(decoded.get(name))}\n`).join('');
  const signature = Buffer.from(decoded.get('plugin.sig').toString().trim(), 'base64');
  assert(verify(null, Buffer.from(payload), key, signature), `Invalid plugin signature: ${file}`);

  const manifest = JSON.parse(decoded.get('plugin.json'));
  assert.equal(manifest.id, id, file);
  assert.equal(manifest.version, version, file);
  assert.equal(manifest.minCore, minCore, file);
  assert(decoded.has(manifest.main), `Missing entry point: ${file}`);
}

const [body, signature] = await Promise.all([get('catalog.json'), get('catalog.json.sig')]);
assert(verify(null, body, key, Buffer.from(signature.toString().trim(), 'base64')), 'Invalid publisher catalog signature');
const upstream = JSON.parse(body);
assert.equal(upstream.format, 1);
assert.equal(upstream.updatedAt, updatedAt);
const listings = catalog.plugins.filter(plugin => plugin.publisher);
assert.deepEqual(listings.map(plugin => plugin.id).sort(), upstream.plugins.map(plugin => plugin.id).sort());
await Promise.all(upstream.plugins.map(async entry => {
  const match = listings.find(plugin => plugin.id === entry.id);
  for (const field of ['version', 'minCore', 'file', 'size', 'sha256']) {
    assert.equal(match.publisher[field], entry[field], `${entry.id} ${field} differs from the signed catalog`);
  }
  verifyBundle(await get(entry.file), entry);
  console.log(`${entry.file}: verified publisher signature and SHA-256`);
}));
