'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The Hub's plugin context exposes no install API. Reuse the desktop panel's
// restricted IPC bridge and the stock archive parser in the supported build.
function createHub({ app, BrowserWindow }) {
  const appPath = app.getAppPath();
  const panelUrl = pathToFileURL(path.join(appPath, 'panel', 'index.html')).href;
  function call(method, ...args) {
    const panel = BrowserWindow.getAllWindows().find(window => (
      !window.isDestroyed() && window.webContents.getURL() === panelUrl
    ));
    if (!panel) throw new Error('Open the ZSB Hub desktop window and retry.');
    return panel.webContents.executeJavaScript(
      `window.clicker.call(${[method, ...args].map(value => JSON.stringify(value)).join(',')})`,
    );
  }

  return {
    async state() {
      const state = await call('state');
      if (!Array.isArray(state?.plugins) || !state.settings) {
        throw new Error('This Hub version does not expose the expected plugin state.');
      }
      return {
        installed: state.plugins.map(({ id, version, bundled }) => ({ id, version, bundled })),
        allowUnverified: state.settings.allowUnverifiedPlugins === true,
      };
    },
    inspectZip(zip) {
      const { unzip, pluginFiles } = require(path.join(appPath, 'src', 'plugins', 'zipimport.js'));
      return pluginFiles(unzip(zip)).manifest;
    },
    importZip(zip) {
      return call('pluginImportZip', zip.toString('base64'));
    },
  };
}

module.exports = { createHub };
