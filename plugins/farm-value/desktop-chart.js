'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const { installChart } = require('./chart');

const CHART_STYLE = `
      .farm-value-chart{padding:10px 2px 4px}
      .farm-value-chart .fv-legend{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 7px 4px}
      .farm-value-chart .fv-legend button{padding:5px 10px;border-radius:8px;font-size:12px;display:inline-flex;align-items:center;gap:7px}
      .farm-value-chart .fv-legend button[aria-pressed="false"]{opacity:.46}
      .farm-value-chart .fv-legend i{width:9px;height:3px;border-radius:3px}
      .farm-value-chart canvas{width:100%;height:clamp(230px,38vh,385px);display:block;touch-action:pan-y}
      .farm-value-chart .fv-detail{font-size:12px;color:var(--text-2);min-height:18px;text-align:left;margin:6px 4px 0;font-variant-numeric:tabular-nums}
    `;

function desktopChart() {
  const url = pathToFileURL(path.join(app.getAppPath(), 'panel', 'index.html')).href;
  let panel, cssKey, sent, busy = false, stopped = false;
  const invalidate = () => { sent = undefined; cssKey = undefined; };

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
        if (!cssKey) cssKey = await target.insertCSS(CHART_STYLE);
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
      if (!target) return;
      if (target === panel && cssKey) void target.removeInsertedCSS(cssKey).catch(() => {});
      void target.executeJavaScript('window.__zsbFarmValueHistory?.dispose()').catch(() => {});
    },
  };
}

module.exports = { desktopChart };
