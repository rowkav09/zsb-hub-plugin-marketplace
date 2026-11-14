<div align="center">

<pre>
+------------------------------------------+
|                                          |
|   ZZZZZZZ   SSSSSS   BBBBBB              |
|        ZZ   SS        BB   BB            |
|      ZZ      SSSSS    BBBBBB     [ + ]   |
|    ZZ            SS   BB   BB            |
|   ZZZZZZZ   SSSSSS   BBBBBB              |
|                                          |
|        P L U G I N   M A R K E T         |
|                                          |
+------------------------------------------+
</pre>

<h1>ZSB Hub Plugin Marketplace</h1>

<p>Discover plugins for the ZSB Hub farmer, learn the framework, and share your own extensions.</p>

<p>
  <a href="https://rowkav09.github.io/zsb-hub-plugin-marketplace/"><strong>Browse marketplace</strong></a> ·
  <a href="docs/install.md">Install</a> ·
  <a href="docs/framework.md">Framework</a> ·
  <a href="https://github.com/rowkav09/zsb-hub-plugin-marketplace/issues/new?template=submit-plugin.yml"><strong>Submit a plugin</strong></a>
</p>

[![Catalog checks](https://github.com/rowkav09/zsb-hub-plugin-marketplace/actions/workflows/check.yml/badge.svg)](https://github.com/rowkav09/zsb-hub-plugin-marketplace/actions/workflows/check.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

## Quick start

**Try a community plugin.** [Download Account Pulse](downloads/account-pulse-1.0.0.zip) for a read-only dashboard of healthy accounts, accounts that need attention, and stopped accounts. It reads the farmer's cached status and makes zero site requests. [View source](plugins/account-pulse/)

1. In ZSB Hub, open **Plugins → Custom plugins → Import .zip** and choose the ZIP.
2. Review the plugin source. Account Pulse is unsigned, so enable **Settings → Allow unverified plugins** to run it.
3. Return to **Plugins** and select **Turn on**. The dashboard opens automatically.

ZIP import was introduced in the inspected [ZSB Hub 1.2.7-beta.1 build](https://github.com/GothGirlZSB/zsb-hub-releases/releases/tag/v1.2.7-beta.1). Use the Hub's **Plugins** tab to enable bundled plugins and install publisher-signed updates. [Installation and troubleshooting](docs/install.md)

## Plugin directory

Bundled versions were inspected in the Linux beta. The publisher's signed feed has its own versions. The marketplace lists runtime behavior, compatibility and provenance for each entry.

| Plugin | Category | Bundled | Signed feed | What it does |
| --- | --- | --- | --- | --- |
| [Armory](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/armory.html) | Farming | 1.15.0 | 1.14.4 | Rotates accounts through games for pass XP and opens a credit shop. |
| [Games](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/games.html) | Farming | 1.8.0 | 1.8.0 | Targets game reward tiers or Armory XP. |
| [Missions](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/missions.html) | Rewards | 1.1.0 | 1.1.0 | Claims finished missions and displays progress. |
| [Monthly pass](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/pass.html) | Rewards | 1.3.0 | 1.3.0 | Claims eligible free or Pro monthly pass tiers. |
| [Rewards](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/rewards.html) | Rewards | 1.3.0 | 1.3.0 | Claims ready rank, click, vault and other reward tiers. |
| [Converter](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/converter.html) | Inventory | 1.4.0 | 1.4.0 | Converts cases, skins and capsules into tokens. |
| [Opener](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/opener.html) | Inventory | 1.8.0 | 1.6.0 | Previews and opens cases, capsules or collections. |
| [Trader](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/trader.html) | Inventory | 1.6.0 | 1.5.0 | Moves tokens and items through one-off trades or saved routes. |
| [Effects](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/effects.html) | Inventory | 1.0.0 | — | Buys, sells, activates and queues special effects. |
| [Proxy manager](https://rowkav09.github.io/zsb-hub-plugin-marketplace/catalog/proxies.html) | Infrastructure | 1.1.0 | 1.1.0 | Publishes proxy and WireGuard routes to the farmer. |

[Machine-readable catalog](catalog.json) · [Publisher catalog snapshot](https://github.com/GothGirlZSB/zsb-hub-releases/blob/37cd27f8b422d928e729d7082d9b1ea601990b5a/plugins/catalog.json)

## Build a plugin

A plugin starts with a `plugin.json` manifest and a CommonJS entry point. ZSB Hub calls `start(ctx)` to give it access to the farmer and panel APIs.

```js
module.exports = {
  start(ctx) {
    ctx.panel.tab('My Plugin', () => ({
      blocks: [{ type: 'text', text: `${ctx.accounts.list().length} accounts` }],
    }));
  },
};
```

| Resource | What it covers |
| --- | --- |
| [Authoring guide](docs/authoring.md) | Build, package and import a minimal plugin. |
| [Framework API](docs/framework.md) | Lifecycle, settings, requests, schedules, events, panel blocks and coordination. |
| [Distribution](docs/distribution.md) | ZIP layout, catalog bundles and publisher signatures. |
| [SKILL.md](SKILL.md) | Give an agent the relevant framework rules and verification steps. |

## Submit your plugin

[Open the plugin submission form](https://github.com/rowkav09/zsb-hub-plugin-marketplace/issues/new?template=submit-plugin.yml) with your **source**, a **versioned ZIP**, and the **ZSB Hub build you tested**. Tell us what it reads or changes. The form works without a clone or pull request. [Contribution guide](CONTRIBUTING.md)

## Work on the marketplace

```sh
git clone https://github.com/rowkav09/zsb-hub-plugin-marketplace.git
cd zsb-hub-plugin-marketplace
npm ci
npm run build
npm run check
python3 -m http.server 8000 --bind 127.0.0.1
```

Use Node.js 24 and Python 3.10+. Open [localhost:8000](http://127.0.0.1:8000) to preview. Edit `catalog.json` and the Markdown docs, then regenerate the checked-in HTML.

## License and attribution

The original marketplace code, docs and example plugin use the [MIT License](LICENSE). ZSB Hub and its publisher plugins are distributed upstream. This is an independent community directory. [ZSB Hub releases](https://github.com/GothGirlZSB/zsb-hub-releases)
