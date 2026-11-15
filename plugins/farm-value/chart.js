'use strict';

// Runs only in the stock Hub desktop panel.
function installChart(update) {
  const slot = '__zsbFarmValueHistory';
  if (window[slot]) {
    window[slot].update(update);
    return true;
  }

  const tab = document.querySelector('#tab-plugin');
  if (!tab) return false;
  const marker = '[data-card="farm-value:farm-value-history"]';
  const lineNames = ['Total', 'Inventory', 'Cash', 'Tokens'];
  const colors = ['#bfc8ff', '#9e82fa', '#48d3a2', '#f0b464'];
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const visible = [true, true, true, true];
  let data = update;
  let chart, point = -1;

  function describe(points) {
    const sample = points[point] || points.at(-1);
    if (!sample) return 'Capture a snapshot to start the history.';
    return date.format(sample.at) + ' · ' + sample.values.map((value, i) =>
      lineNames[i] + ' ' + money.format(value)).join(' · ');
  }

  function draw() {
    if (!chart) return;
    const { canvas, summary } = chart;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const points = data.samples.map(sample => {
      const tokens = sample.tokens / data.rate;
      return { at: sample.at, values: [sample.inventory + sample.cash + tokens, sample.inventory, sample.cash, tokens] };
    });
    chart.points = points;
    const left = 73, right = width - 17, top = 14, bottom = height - 35;
    const maximum = Math.max(1, ...points.map(p => Math.max(...p.values.filter((_, i) => visible[i]))));
    const exponent = 10 ** Math.floor(Math.log10(maximum / 4));
    const step = [1, 2, 2.5, 5, 10].map(x => x * exponent).find(x => x >= maximum / 4);
    const ceiling = Math.ceil(maximum / step) * step;
    const start = points[0]?.at ?? 0, end = points.at(-1)?.at ?? start;
    const x = at => start === end ? (left + right) / 2 : left + (at - start) / (end - start) * (right - left);
    chart.x = x;
    const y = value => bottom - value / ceiling * (bottom - top);
    const theme = getComputedStyle(canvas);
    ctx.font = '12px system-ui';
    ctx.textAlign = 'right';
    for (let i = 0; i <= Math.round(ceiling / step); i++) {
      const value = i * step, py = y(value);
      ctx.strokeStyle = theme.getPropertyValue('--line').trim() || '#313644';
      ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
      ctx.fillStyle = theme.getPropertyValue('--text-2').trim() || '#a1a6b5';
      ctx.fillText(compact.format(value), left - 9, py + 4);
    }
    if (points.length) {
      for (let i = 0; i < visible.length; i++) {
        if (!visible[i]) continue;
        ctx.strokeStyle = colors[i]; ctx.fillStyle = colors[i]; ctx.lineWidth = i === 0 ? 2.6 : 1.8;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        for (const [j, p] of points.entries()) ctx[j ? 'lineTo' : 'moveTo'](x(p.at), y(p.values[i]));
        ctx.stroke();
        if (points.length <= 12 || point >= 0) {
          for (const p of (points.length <= 12 ? points : [points[point]])) {
            ctx.beginPath(); ctx.arc(x(p.at), y(p.values[i]), 3, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      if (point >= 0 && points.length > 1) {
        const selectedX = x(points[point].at);
        ctx.strokeStyle = theme.color;
        ctx.globalAlpha = .42; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath();
        ctx.moveTo(selectedX, top); ctx.lineTo(selectedX, bottom); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = theme.getPropertyValue('--text-2').trim() || '#a1a6b5';
      for (const [at, align] of start === end ? [[start,'center']] : [[start,'left'],[end,'right']]) {
        ctx.textAlign = align; ctx.fillText(date.format(at), x(at), height - 10);
      }
    }
    summary.textContent = describe(points);
    canvas.dataset.samples = String(points.length);
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  }

  function unmount() {
    if (!chart) return;
    chart.resize.disconnect();
    chart.root.remove();
    if (chart.placeholder) chart.placeholder.hidden = false;
    chart = undefined;
  }

  function mount() {
    const holder = tab.querySelector(marker)?.closest('.pcard')?.querySelector('.pcard-body');
    if (holder === chart?.holder) return;
    unmount();
    if (!holder) return;
    const root = element('div', 'farm-value-chart');
    const legend = element('div', 'fv-legend');
    for (const [i, name] of lineNames.entries()) {
      const button = element('button', 'small');
      const swatch = element('i');
      swatch.style.background = colors[i];
      button.type = 'button';
      button.setAttribute('aria-pressed', String(visible[i]));
      button.append(swatch, document.createTextNode(name));
      button.addEventListener('click', () => {
        if (visible[i] && visible.filter(Boolean).length === 1) return;
        visible[i] = !visible[i]; button.setAttribute('aria-pressed', String(visible[i])); draw();
      });
      legend.append(button);
    }
    const canvas = element('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Combined farm value history in in-game dollars. Use arrow keys to inspect snapshots.');
    const summary = element('div', 'fv-detail');
    summary.setAttribute('aria-live', 'polite');
    root.append(legend, canvas, summary);
    const placeholder = holder.querySelector('.pnotice');
    if (placeholder) placeholder.hidden = true;
    holder.append(root);
    point = -1;
    const resize = new ResizeObserver(draw);
    chart = { root, holder, canvas, summary, placeholder, resize };
    resize.observe(canvas);
    canvas.addEventListener('pointermove', event => {
      const { points, x } = chart;
      if (!points.length) return;
      point = points.reduce((best, p, i) =>
        Math.abs(x(p.at) - event.offsetX) < Math.abs(x(points[best].at) - event.offsetX) ? i : best, 0);
      draw();
    });
    canvas.addEventListener('pointerleave', () => { point = -1; draw(); });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key) || !chart.points.length) return;
      event.preventDefault();
      const initial = point < 0 ? chart.points.length - 1 : point;
      point = Math.max(0, Math.min(chart.points.length - 1, initial + (event.key === 'ArrowLeft' ? -1 : 1)));
      draw();
    });
    draw();
  }

  const observer = new MutationObserver(mount);
  observer.observe(tab, { childList: true, subtree: true });
  window[slot] = {
    update(update) { data = update; point = -1; mount(); draw(); },
    dispose() { observer.disconnect(); unmount(); delete window[slot]; },
  };
  mount();
  return true;
}

module.exports = { installChart };
