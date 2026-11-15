'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Hub exposes start and setType through its desktop panel, rather than the plugin context.
function hubControls({ app, BrowserWindow }) {
  const url = pathToFileURL(path.join(app.getAppPath(), 'panel', 'index.html')).href;
  async function call(method, ...args) {
    const panel = BrowserWindow.getAllWindows().find(window =>
      !window.isDestroyed() && window.webContents.getURL() === url);
    if (!panel) throw Error('Open the Hub desktop panel to start or switch clicking modes.');
    const result = await panel.webContents.executeJavaScript(
      'window.clicker.call(' + [method, ...args].map(value => JSON.stringify(value)).join(',') + ')',
    );
    if (!result?.ok) throw Error(result?.error || 'Hub could not ' + (method === 'start' ? 'start this account.' : 'set Auto mode.'));
  }
  return { start: id => call('start', id), auto: id => call('setType', id, 'auto') };
}

module.exports = { hubControls };
