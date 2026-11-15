'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const { installChart } = require('./chart');

function desktopChart() {
  const url = pathToFileURL(path.join(app.getAppPath(), 'panel', 'index.html')).href;
  let panel, sent, busy = false, stopped = false;
  const invalidate = () => { sent = undefined; };

  function findPanel() {
    return BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL() === url)?.webContents;
  }

  return {
    async sync(samples, rate) {
      if (stopped || busy || !Number.isFinite(rate) || rate <= 0) return;
      const target = findPanel();
      if (!target) return;
      if (target !== panel) {
        panel?.removeListener('did-finish-load', invalidate);
        panel = target;
        panel.on('did-finish-load', invalidate);
        invalidate();
      }
      const stamp = samples.length + ':' + samples.at(-1)?.at + ':' + rate;
      if (sent === stamp) return;
      busy = true;
      try {
        const values = JSON.stringify({ samples, rate });
        if (await target.executeJavaScript(`(${installChart.toString()})(${values})`)) sent = stamp;
      } catch {
        // A panel reload can interrupt a chart refresh. The periodic sync retries.
      } finally { busy = false; }
    },
    stop() {
      stopped = true;
      panel?.removeListener('did-finish-load', invalidate);
      const target = findPanel();
      if (target) void target.executeJavaScript('window.__zsbFarmValueHistory?.dispose()').catch(() => {});
    },
  };
}

module.exports = { desktopChart };
