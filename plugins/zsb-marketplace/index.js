'use strict';

const { createHub } = require('./hub');
const { compareVersions, fetchCatalog, fetchPackage } = require('./catalog');

function startMarketplace(ctx, hub, fetcher) {
  const lifetime = new AbortController();
  let entries = [];
  let installed = [];
  let allowUnverified = false;
  let selected = null;
  let loaded = false;
  let working = null;
  let notice = null;

  const stopped = () => lifetime.signal.aborted || ctx.stopping;
  const requestSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
  async function syncHub() {
    const state = await hub.state();
    installed = state.installed;
    allowUnverified = state.allowUnverified;
  }

  function actionFor(entry) {
    if (compareVersions(entry.minCore, ctx.coreVersion) > 0) return { label: `Requires Hub ${entry.minCore}` };
    const local = installed.find(plugin => plugin.id === entry.id);
    if (!local) return { label: 'Available', button: 'Install' };
    if (local.bundled) return { label: 'Built into this Hub' };
    const compared = compareVersions(entry.version, local.version);
    if (compared > 0) return { label: `Installed ${local.version}`, button: 'Update' };
    return { label: compared === 0 ? 'Installed' : `Installed ${local.version} (newer)` };
  }

  async function checkInstall(entry) {
    await syncHub();
    if (stopped()) throw new Error('Marketplace was turned off.');
    if (!allowUnverified) throw new Error('Enable Allow unverified plugins in Hub Settings to install community ZIPs.');
    const status = actionFor(entry);
    if (!status.button) throw new Error(`This version cannot be installed. ${status.label}.`);
  }

  async function run(label, operation) {
    if (working) return { ok: false, error: 'Wait for the current marketplace action to finish.' };
    working = label;
    notice = null;
    try {
      return await operation();
    } catch (error) {
      if (!stopped()) notice = { type: 'notice', level: 'warn', text: error.message };
      return { ok: false, error: error.message };
    } finally {
      working = null;
    }
  }

  const refresh = () => run('Checking GitHub…', async () => {
    await syncHub();
    const latest = (await fetchCatalog(fetcher, requestSignal())).filter(entry => entry.id !== ctx.id);
    if (stopped()) throw new Error('Marketplace was turned off.');
    entries = latest;
    loaded = true;
    if (!entries.some(entry => entry.id === selected)) selected = entries[0]?.id ?? null;
    return { message: `Catalog refreshed. ${entries.length} community plugin(s).` };
  });

  ctx.panel.action('refresh', refresh);
  ctx.panel.action('select', id => {
    if (entries.some(entry => entry.id === id)) selected = id;
  });
  ctx.panel.action('install', id => run('Checking package…', async () => {
    const entry = entries.find(plugin => plugin.id === id);
    if (!entry) throw new Error('Select a plugin from the current catalog.');
    await checkInstall(entry);
    const zip = await fetchPackage(entry, fetcher, requestSignal());
    if (stopped()) throw new Error('Marketplace was turned off.');
    const manifest = hub.inspectZip(zip);
    for (const key of ['id', 'version', 'minCore', 'defaultEnabled']) {
      if (manifest[key] !== entry[key]) throw new Error(`ZIP manifest disagrees with the catalog on ${key}.`);
    }
    await checkInstall(entry);
    working = `Importing ${entry.name}…`;
    const result = await hub.importZip(zip);
    if (!result?.ok) throw new Error(result?.error || 'ZSB Hub rejected the ZIP.');
    installed = [
      ...installed.filter(plugin => plugin.id !== entry.id),
      { id: entry.id, version: entry.version, bundled: false },
    ];
    const message = result.started === false
      ? `${entry.name} imported. Check the Plugins tab for the startup error.`
      : `${entry.name} ${entry.version} imported. Manage it from the Plugins tab.`;
    notice = { type: 'notice', level: 'ok', text: message };
    return { message };
  }));

  ctx.panel.tab('External Marketplace', () => {
    const entry = entries.find(plugin => plugin.id === selected);
    const status = entry && actionFor(entry);
    const blocks = [
      { type: 'buttons', items: [{ label: 'Refresh catalog', action: 'refresh' }] },
    ];
    if (working) blocks.push({ type: 'notice', text: working });
    if (notice) blocks.push(notice);
    if (!allowUnverified && loaded) {
      blocks.push({ type: 'notice', level: 'warn', text: 'Enable Allow unverified plugins in Hub Settings to install community ZIPs.' });
    }
    if (!entry) {
      if (!working) blocks.push({ type: 'text', text: loaded ? 'No community plugins are listed.' : 'Refresh the catalog to load plugins from GitHub.' });
      return { blocks };
    }

    blocks.push({
      type: 'picker',
      tag: 'Selected',
      action: 'select',
      items: entries.map(item => ({
        id: item.id,
        title: item.name,
        sub: item.summary,
        meta: `${item.version} · ${actionFor(item).label}`,
        on: item.id === selected,
      })),
    });
    blocks.push({ type: 'section', title: entry.name, blocks: [
      { type: 'text', text: `By ${entry.author} · ${entry.license} · Hub ${entry.minCore} or newer` },
      { type: 'text', text: `Source: ${entry.source}` },
      ...(status.button && !working && allowUnverified ? [{
        type: 'buttons',
        items: [{
          label: `${status.button} ${entry.name}`,
          action: 'install',
          arg: entry.id,
          primary: true,
          confirm: `Import ${entry.name} ${entry.version} from GitHub? Community plugins run with your desktop user's permissions.`,
        }],
      }] : []),
    ] });
    return { blocks };
  });

  // A delayed refresh lets the bundled desktop panel finish loading at app startup.
  const pending = setTimeout(() => { if (!stopped() && !loaded && !working) refresh(); }, 1500);
  pending.unref?.();
  return () => {
    clearTimeout(pending);
    lifetime.abort();
  };
}

let stop;
module.exports = {
  start(ctx) {
    stop = startMarketplace(ctx, createHub(require('electron')), globalThis.fetch);
  },
  stop() {
    stop?.();
  },
  startMarketplace,
};
