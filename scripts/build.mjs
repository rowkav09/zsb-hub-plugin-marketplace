import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const root = new URL('../', import.meta.url);
const read = async path => readFile(new URL(path, root), 'utf8');
const catalog = JSON.parse(await read('catalog.json'));
const check = process.argv.includes('--check');
const submitUrl = 'https://github.com/rowkav09/zsb-hub-plugin-marketplace/issues/new?template=submit-plugin.yml';
const isHttps = value => {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  const url = URL.parse(value);
  return !!url && !!url.hostname && !url.username && !url.password;
};
const docs = {
  'docs/install.md': 'Installation',
  'docs/framework.md': 'Framework',
  'docs/authoring.md': 'Authoring',
  'docs/distribution.md': 'Distribution',
  'CONTRIBUTING.md': 'Contributing',
  ...Object.fromEntries(catalog.plugins.filter(p => p.kind === 'community' && !isHttps(p.source))
    .map(p => [p.source + 'README.md', p.name])),
};
const icons = {
  Farming: '✦',
  Rewards: '◇',
  Inventory: '▣',
  Infrastructure: '⎇',
  Utilities: '∿',
};
const esc = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const output = async (path, value) => {
  const url = new URL(path, root);
  if (check) {
    if (await read(path) !== value) throw new Error(`Run npm run build to refresh ${path}`);
    return;
  }
  await mkdir(dirname(fileURLToPath(url)), { recursive: true });
  await writeFile(url, value);
};
const docPage = path => path.endsWith('/README.md')
  ? 'catalog/' + posix.basename(posix.dirname(path)) + '-source.html'
  : path.replace(/\.md$/, '.html');
const relative = (from, to) => posix.relative(posix.dirname(from), to);

const ids = new Set();
for (const p of catalog.plugins) {
  if (!/^[a-z0-9-]{1,40}$/.test(p.id) || ids.has(p.id)) throw new Error(`Invalid or repeated ID: ${p.id}`);
  ids.add(p.id);
  for (const field of ['name', 'category', 'summary', 'overview', 'integration', 'operation', 'version', 'minCore']) {
    if (typeof p[field] !== 'string' || !p[field].trim()) throw new Error(`${p.id} needs ${field}`);
  }
  if (!Object.hasOwn(icons, p.category)) throw new Error(`Unknown category: ${p.category}`);
  if (p.kind === 'bundled') {
    if (p.publisher && (!/^[a-z0-9.-]+\.json$/.test(p.publisher.file) || !/^[a-f0-9]{64}$/.test(p.publisher.sha256))) {
      throw new Error(`Invalid publisher package: ${p.id}`);
    }
    continue;
  }
  if (p.kind !== 'community') throw new Error(`Unknown plugin kind: ${p.kind}`);
  if (!p.author || !p.license || !/^[a-f0-9]{64}$/.test(p.sha256)) {
    throw new Error(`Community listing requires an author, license and SHA-256: ${p.id}`);
  }
  if (isHttps(p.source) && isHttps(p.download)) {
    if (!new URL(p.download).pathname.toLowerCase().endsWith('.zip')) {
      throw new Error(`The external download must point to a ZIP: ${p.id}`);
    }
    continue;
  }
  if (p.source !== `plugins/${p.id}/` || p.download !== `downloads/${p.id}-${p.version}.zip`) {
    throw new Error(`Use matching repository paths or HTTPS source and ZIP links: ${p.id}`);
  }

  const [manifestText, zip] = await Promise.all([
    read(p.source + 'plugin.json'),
    readFile(new URL(p.download, root)),
  ]);
  const manifest = JSON.parse(manifestText);
  for (const key of ['id', 'name', 'version', 'minCore', 'defaultEnabled']) {
    if (p[key] !== manifest[key]) throw new Error(`${p.id} catalog and manifest disagree on ${key}`);
  }
  await access(new URL(p.source + manifest.main, root));
  const hash = createHash('sha256').update(zip).digest('hex');
  if (hash !== p.sha256) throw new Error(`Checksum mismatch: ${p.download}`);
}

function shell(title, description, page, content, script = '') {
  const link = path => relative(page, path);
  const nav = [
    ['index.html', 'Marketplace'],
    ['docs/install.html', 'Install'],
    ['docs/framework.html', 'Framework'],
    ['docs/authoring.html', 'Build a plugin'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${esc(description)}">
  <meta name="color-scheme" content="dark">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="${link('site/style.css')}">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="header">
    <div class="header-inner">
      <a class="brand" href="${link('index.html')}"><span class="brand-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>ZSB Hub Plugin Marketplace</a>
      <nav aria-label="Main navigation">
        ${nav.map(([path, name]) => `<a href="${link(path)}"${path === page ? ' aria-current="page"' : ''}>${name}</a>`).join('\n        ')}
      </nav>
    </div>
  </header>
${content}
  <footer>
    <div><strong>ZSB Hub Plugin Marketplace</strong><span>Independent community project for ZSB Hub.</span></div>
    <a href="${submitUrl}">Submit a plugin ↗</a>
    <a href="${link('CONTRIBUTING.html')}">Contribute</a>
    <a href="${link('catalog.json')}">Catalog JSON</a>
    <a href="${esc(catalog.publisherFeed.source)}">Publisher releases ↗</a>
  </footer>
${script ? `  ${script}\n` : ''}</body>
</html>
`;
}

function label(p) {
  if (p.kind === 'community') return 'Community ZIP';
  return p.publisher ? 'Bundled · In signed feed' : 'Bundled · Beta';
}

function card(p) {
  return `<article class="plugin-card" data-category="${esc(p.category)}" data-search="${esc([p.name, p.id, p.category, p.summary, p.operation, label(p)].join(' ').toLowerCase())}">
  <div class="card-head"><span class="plugin-icon" data-category="${esc(p.category)}" aria-hidden="true">${icons[p.category]}</span><span class="tag${p.kind === 'community' ? ' community' : ''}">${esc(label(p))}</span></div>
  <h3><a href="catalog/${p.id}.html">${esc(p.name)}</a></h3>
  <p>${esc(p.summary)}</p>
  <div class="card-foot"><span class="version">v${esc(p.version)}</span><a href="catalog/${p.id}.html" aria-label="Details for ${esc(p.name)}">View details <span aria-hidden="true">↗</span></a></div>
</article>`;
}

const categories = [...new Set(catalog.plugins.map(p => p.category))];
const featured = catalog.plugins.find(p => p.id === 'account-pulse');
const home = `  <main id="main" class="wrap">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">The ZSB Hub plugin marketplace</p>
        <h1 id="hero-title">Plugins for<br>your farmer<span>.</span></h1>
        <p>Explore the plugins that ship with ZSB Hub, find community extensions, and build your own.</p>
        <div class="actions"><a class="button primary" href="#plugins">Browse plugins <span aria-hidden="true">↓</span></a><a class="button secondary" href="docs/framework.html">Framework guide <span aria-hidden="true">↗</span></a></div>
      </div>
      <div class="host-visual" aria-hidden="true">
        <div class="host-stack">
          <div class="host-module manifest"><i></i><span>plugin.json</span><b>MANIFEST</b></div>
          <div class="host-module entry"><i></i><span>index.js</span><b>ENTRY POINT</b></div>
          <div class="host-module runtime"><i></i><span>start(ctx)</span><b>FARMER RUNTIME</b></div>
        </div>
      </div>
    </section>
    <section class="market" aria-labelledby="plugins">
      <div class="section-head"><div><h2 id="plugins">Plugin directory</h2><p>Compatibility, provenance and installation for each plugin.</p></div><a class="text-link" href="docs/install.html">How to install <span aria-hidden="true">↗</span></a></div>
      <article class="featured">
        <span class="plugin-icon" data-category="Utilities" aria-hidden="true">${icons.Utilities}</span>
        <div><p class="eyebrow">Community plugin</p><h3><a href="catalog/${featured.id}.html">${esc(featured.name)}</a></h3><p>${esc(featured.summary)}</p></div>
        <a class="button secondary" href="${esc(featured.download)}" download>Download ZIP <span aria-hidden="true">↓</span></a>
      </article>
      <div class="controls" hidden data-controls>
        <div class="filters" aria-label="Filter by category">${['All plugins', ...categories].map((category, index) => `<button type="button" aria-pressed="${index === 0}">${esc(category)}</button>`).join('')}</div>
        <label class="search"><span class="sr-only">Search plugins</span><span class="search-icon" aria-hidden="true"></span><input type="search" placeholder="Search plugins" autocomplete="off"></label>
      </div>
      <p class="results-count" role="status" data-count>${catalog.plugins.length} plugins</p>
      <div class="grid">${catalog.plugins.map(card).join('\n        ')}</div>
      <div class="empty" hidden data-empty><h3>No matching plugins</h3><p>Try a different search or category.</p><button type="button" class="button secondary" data-clear>Clear filters</button></div>
    </section>
    <aside class="build-panel"><div><h2>Build for ZSB Hub</h2><p>Write a manifest, register a panel and package your first plugin.</p></div><a class="button secondary" href="docs/authoring.html">Start building <span aria-hidden="true">↗</span></a></aside>
  </main>`;
await output('index.html', shell('ZSB Hub Plugin Marketplace', 'Browse plugins for the ZSB Hub farmer and learn to build your own.', 'index.html', home, '<script src="site/market.js" defer></script>'));

for (const p of catalog.plugins) {
  const page = `catalog/${p.id}.html`;
  const community = p.kind === 'community';
  const external = isHttps(p.source);
  const packageLink = community
    ? `<a class="button primary" href="${esc(external ? p.download : '../' + p.download)}"${external ? '' : ' download'}>Download ZIP ↓</a><a class="button secondary" href="${esc(external ? p.source : '../' + docPage(p.source + 'README.md'))}">Source &amp; documentation ↗</a>`
    : '<a class="button primary" href="../docs/install.html">Installation instructions ↗</a>';
  const provenance = p.publisher
    ? `<h2>Publisher catalog</h2><p>The signed catalog lists version ${esc(p.publisher.version)}, which requires core ${esc(p.publisher.minCore)}. Install or update publisher plugins from the app’s Plugins tab.</p>
    <a class="text-link" href="${esc(catalog.publisherFeed.files + p.publisher.file)}">Publisher bundle (JSON) ↗</a><p class="checksum">SHA-256 <code>${esc(p.publisher.sha256)}</code></p>`
    : community
      ? `<h2>ZIP import</h2><p>This package is unsigned. Review the source, then use <strong>Plugins → Custom plugins → Import .zip</strong> with <strong>Allow unverified plugins</strong> enabled. <a href="../docs/install.html">Installation guide</a></p><p>Author ${esc(p.author)} · ${esc(p.license)} license</p><p class="checksum">SHA-256 <code>${esc(p.sha256)}</code></p>`
      : `<h2>Availability</h2><p>Bundled with the inspected beta. <a href="${esc(catalog.appRelease)}">Publisher app release ↗</a></p>`;
  const detail = `  <main id="main" class="wrap narrow">
    <a class="back" href="../index.html#plugins">← Plugin directory</a>
    <article class="detail">
      <div class="detail-top"><span class="plugin-icon" data-category="${esc(p.category)}" aria-hidden="true">${icons[p.category]}</span><span class="tag${community ? ' community' : ''}">${esc(label(p))}</span></div>
      <h1>${esc(p.name)}</h1><p class="lede">${esc(p.summary)}</p>
      <div class="actions">${packageLink}</div>
      <dl class="facts"><div><dt>${community ? 'Version' : 'Bundled version'}</dt><dd>${esc(p.version)}</dd></div><div><dt>Minimum core</dt><dd>${esc(p.minCore)}</dd></div><div><dt>Operation</dt><dd>${esc(p.operation)}</dd></div><div><dt>Enabled by default</dt><dd>${p.defaultEnabled ? 'Yes' : 'No'}</dd></div></dl>
      <div class="prose"><h2>What it does</h2><p>${esc(p.overview)}</p><h2>How it uses the farmer</h2><p>${esc(p.integration)}</p>${provenance}</div>
    </article>
  </main>`;
  await output(page, shell(`${p.name} · ZSB Hub Plugin Marketplace`, p.summary, page, detail));
}

const md = new MarkdownIt({ html: false });
for (const [source, name] of Object.entries(docs)) {
  const page = docPage(source);
  const env = {};
  const tokens = md.parse(await read(source), env);
  for (const token of tokens) {
    for (const child of token.children || []) {
      if (child.type !== 'link_open') continue;
      const href = child.attrGet('href');
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const [target, fragment] = href.split('#');
      const resolved = posix.normalize(posix.join(posix.dirname(source), target));
      await access(new URL(resolved, root));
      const destination = Object.hasOwn(docs, resolved) ? docPage(resolved) : resolved;
      child.attrSet('href', relative(page, destination) + (fragment ? '#' + fragment : ''));
    }
  }
  const sidebar = Object.entries(docs).filter(([path]) => !path.startsWith('plugins/')).map(([path, title]) =>
    `<a href="${relative(page, docPage(path))}"${path === source ? ' aria-current="page"' : ''}>${esc(title)}</a>`).join('');
  const content = `  <main id="main" class="wrap docs">
    <nav class="doc-nav" aria-label="Documentation">${sidebar}</nav>
    <article class="prose">${md.renderer.render(tokens, md.options, env)}</article>
  </main>`;
  await output(page, shell(`${name} · ZSB Hub Plugin Marketplace`, `${name} for ZSB Hub plugins.`, page, content));
}
console.log(`${check ? 'Checked' : 'Built'} ${catalog.plugins.length} listings and ${Object.keys(docs).length} documentation pages.`);
