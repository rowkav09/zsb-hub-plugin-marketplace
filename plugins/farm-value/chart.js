'use strict';

function renderChart() {
  const canvas = document.querySelector('canvas');
  const detail = document.querySelector('#detail');
  const colors = ['#8065dd', '#40bf99', '#e5a950'];
  const names = ['Inventory', 'Cash', 'Tokens'];
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const tick = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, style: 'currency', currency: 'USD' });
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let points = [], xAt = () => 0;
  let index = -1;

  function display(sample) {
    detail.textContent = sample
      ? date.format(sample.at) + ' · ' + money.format(sample.values.reduce((sum, value) => sum + value, 0))
        + ' total · ' + sample.values.map((value, i) => names[i] + ' ' + money.format(value)).join(' · ')
      : 'Capture a snapshot in Hub to start the history.';
  }

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    const left = 75, right = w - 24, top = 20, bottom = h - 42;
    const highest = Math.max(1, ...points.map(point => point.values.reduce((sum, value) => sum + value, 0))) * 1.06;
    const start = points[0]?.at ?? 0, end = points.at(-1)?.at ?? start;
    xAt = at => start === end ? (left + right) / 2 : left + (at - start) / (end - start) * (right - left);
    const yAt = value => bottom - value / highest * (bottom - top);
    context.font = '12px system-ui';
    context.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const value = highest * i / 4, y = yAt(value);
      context.strokeStyle = '#282936';
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      context.fillStyle = '#b6b7c8'; context.fillText(tick.format(value), left - 10, y + 4);
    }
    if (!points.length) return;
    const pointTotal = (sample, upto) => sample.values.slice(0, upto).reduce((sum, value) => sum + value, 0);
    for (let i = 0; i < colors.length; i++) {
      context.fillStyle = colors[i];
      context.globalAlpha = .84;
      if (points.length === 1) {
        const x = xAt(start), p = points[0];
        context.fillRect(x - 44, yAt(pointTotal(p, i + 1)), 88, yAt(pointTotal(p, i)) - yAt(pointTotal(p, i + 1)));
      } else {
        context.beginPath();
        for (const [j, p] of points.entries()) context[j === 0 ? 'moveTo' : 'lineTo'](xAt(p.at), yAt(pointTotal(p, i + 1)));
        for (let j = points.length - 1; j >= 0; j--) context.lineTo(xAt(points[j].at), yAt(pointTotal(points[j], i)));
        context.closePath(); context.fill();
      }
      context.globalAlpha = 1;
    }
    for (const [at, align] of start === end ? [[start, 'center']] : [[start, 'left'], [end, 'right']]) {
      context.textAlign = align; context.fillStyle = '#b6b7c8'; context.fillText(date.format(at), xAt(at), h - 15);
    }
    if (index >= 0 && points.length > 1) {
      const x = xAt(points[index].at);
      context.strokeStyle = '#f1f2f8'; context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.stroke();
    }
  }

  const data = JSON.parse(document.querySelector('#history').textContent);
  points = data.samples.map(sample => ({ at: sample.at, values: [sample.inventory, sample.cash, sample.tokens / data.rate] }));
  display(points.at(-1));
  canvas.addEventListener('pointermove', event => {
    if (!points.length) return;
    index = points.reduce((best, point, i) => Math.abs(xAt(point.at) - event.offsetX) < Math.abs(xAt(points[best].at) - event.offsetX) ? i : best, 0);
    display(points[index]); draw();
  });
  canvas.addEventListener('pointerleave', () => { index = -1; display(points.at(-1)); draw(); });
  window.addEventListener('resize', draw);
  draw();
}

function chartDocument(samples, rate) {
  const history = JSON.stringify({ samples, rate });
  return `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
  <title>Farm Value · ZSB Hub</title>
  <style>
    *{box-sizing:border-box}body{font:15px system-ui;margin:0;padding:26px;color:#f3f1fb;background:#15151e}
    h1{margin:0;font-size:27px} p{margin:5px 0;color:#bbb9cf}
    ul{display:flex;gap:20px;padding:0;margin:20px 0 8px;list-style:none;color:#dddcea}
    i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:7px}
    canvas{width:100%;height:calc(100vh - 216px);min-height:240px;background:#1b1c27;border:1px solid #2b2c3b;border-radius:12px}
    #detail{margin-top:9px;font-variant-numeric:tabular-nums;color:#eeedf5}
  </style>
  <h1>Combined farm value</h1><p>All Hub accounts · in-game dollar equivalent</p>
  <ul><li><i style="background:#8065dd"></i>Inventory</li><li><i style="background:#40bf99"></i>Cash</li><li><i style="background:#e5a950"></i>Tokens</li></ul>
  <canvas role="img" aria-label="Stacked history of inventory value, cash, and tokens"></canvas>
  <p id="detail" aria-live="polite"></p><p>${rate} tokens per $1 in-game value</p>
  <script type="application/json" id="history">${history}</script>
  <script>(${renderChart.toString()})();</script></html>`;
}

module.exports = { chartDocument };
