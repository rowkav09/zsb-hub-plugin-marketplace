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
    if (compared > 0) return { label: `Installed ${local.version} → ${entry.version} available`, button: 'Update' };
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
    const latest = await fetchCatalog(fetcher, requestSignal());
    if (stopped()) throw new Error('Marketplace was turned off.');
    entries = latest;
    loaded = true;
    if (!entries.some(entry => entry.id === selected)) selected = entries.find(entry => entry.id !== ctx.id)?.id ?? null;
    const updates = entries.filter(entry => actionFor(entry).button === 'Update').length;
    return { message: updates ? `${updates} update(s) available. Choose which to install.` : 'Catalog refreshed. Your marketplace plugins are up to date.' };
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

  function packageButton(entry, verb) {
    return {
      label: `${verb} ${entry.name}`, action: 'install', arg: entry.id, primary: true,
      confirm: `${verb} ${entry.name} to ${entry.version} from GitHub? Community plugins run with your desktop user's permissions.`,
    };
  }

  ctx.panel.tab('External Marketplace', () => {
    const entry = entries.find(plugin => plugin.id === selected);
    const status = entry && actionFor(entry);
    const blocks = [
      { type: 'buttons', items: [{ label: 'Check for updates', action: 'refresh' }] },
    ];
    if (working) blocks.push({ type: 'notice', text: working });
    if (notice) blocks.push(notice);
    if (!allowUnverified && loaded) {
      blocks.push({ type: 'notice', level: 'warn', text: 'Enable Allow unverified plugins in Hub Settings to install community ZIPs.' });
    }
    const updates = entries.filter(item => actionFor(item).button === 'Update');
    if (updates.length) {
      blocks.push({
        type: 'card', id: 'marketplace-updates', title: 'Updates available', open: true,
        summary: updates.length + ' installed plugin(s)',
        blocks: updates.flatMap(item => [
          { type: 'text', text: `${item.name} · ${actionFor(item).label}` },
          ...(!working && allowUnverified ? [{ type: 'buttons', items: [packageButton(item, 'Update')] }] : []),
        ]),
      });
    }
    if (!entry) {
      if (!working) blocks.push({ type: 'text', text: loaded ? 'No community plugins are listed.' : 'Check for updates to load the latest marketplace catalog.' });
      return { blocks };
    }

    blocks.push({
      type: 'picker',
      tag: 'Selected',
      action: 'select',
      items: entries.filter(item => item.id !== ctx.id).map(item => ({
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
      ...(status.button === 'Install' && !working && allowUnverified ?
        [{ type: 'buttons', items: [packageButton(entry, 'Install')] }] : []),
    ] });
    return { blocks };
  });

  return () => lifetime.abort();
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
