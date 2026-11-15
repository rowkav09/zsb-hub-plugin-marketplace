<div align="center">

<pre>
    ********  ******** ******         **      ** **     ** ******
   //////**  **////// /*////**       /**     /**/**    /**/*////**
        **  /**       /*   /**       /**     /**/**    /**/*   /**
       **   /*********/******        /**********/**    /**/******
      **    ////////**/*//// **      /**//////**/**    /**/*//// **
     **            /**/*    /**      /**     /**/**    /**/*    /**
    ******** ******** /*******       /**     /**//******* /*******
   //////// ////////  ///////        //      //  ///////  ///////

##  #   # #  ## ### ###     # #  #  ##  # # ### ### ##  #    #   ## ###
# # #   # # #    #  # #     ### # # # # # # #    #  # # #   # # #   #
##  #   # # # #  #  # #     ### ### ##  ##  ##   #  ##  #   ### #   ##
#   #   # # # #  #  # #     # # # # # # # # #    #  #   #   # # #   #
#   ### ###  ## ### # #     # # # # # # # # ###  #  #   ### # #  ## ###
</pre>

<h1>ZSB Hub External Plugin Marketplace</h1>

<p>Install community plugins from GitHub inside the ZSB Hub desktop app.</p>

<p>
  <a href="https://github.com/rowkav09/zsb-hub-plugin-marketplace#bundled-plugin-directory"><strong>Browse plugins</strong></a> ·
  <a href="https://github.com/rowkav09/zsb-hub-plugin-marketplace/releases/download/marketplace-v1.0.0/zsb-marketplace-1.0.0.zip"><strong>Download the marketplace ZIP</strong></a> ·
  <a href="docs/framework.md">Framework</a> ·
  <a href="https://github.com/rowkav09/zsb-hub-plugin-marketplace/issues/new?template=submit-plugin.yml"><strong>Submit a plugin</strong></a>
</p>

[![CI](https://github.com/rowkav09/zsb-hub-plugin-marketplace/actions/workflows/check.yml/badge.svg)](https://github.com/rowkav09/zsb-hub-plugin-marketplace/actions/workflows/check.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

## Install the External Marketplace

1. [Download the External Marketplace ZIP](https://github.com/rowkav09/zsb-hub-plugin-marketplace/releases/download/marketplace-v1.0.0/zsb-marketplace-1.0.0.zip). In ZSB Hub, open **Plugins → Custom plugins → Import .zip** and choose the ZIP.
2. After reviewing the [source](plugins/zsb-marketplace/), enable **Settings → Allow unverified plugins**, then turn on **ZSB Hub External Plugin Marketplace** in Plugins.
3. In the **External Marketplace** tab, select a plugin and choose **Install** or **Update**. Enable newly installed plugins from the normal **Plugins** list.

This is a community feed served from this GitHub repository. The Hub's official catalog remains available under **Plugins**. The desktop panel integration was tested with [ZSB Hub 1.2.7-beta.1](https://github.com/GothGirlZSB/zsb-hub-releases/releases/tag/v1.2.7-beta.1) on Linux. [Installation and troubleshooting](docs/install.md)

| Community plugin | What it does | ZIP |
| --- | --- | --- |
| [External Marketplace](plugins/zsb-marketplace/) | Lists, installs and updates community plugins from this repository. | [Download](https://github.com/rowkav09/zsb-hub-plugin-marketplace/releases/download/marketplace-v1.0.0/zsb-marketplace-1.0.0.zip) |
| [Account Pulse](plugins/account-pulse/) | Displays healthy, paused and stopped accounts from the farmer's cache. | [Download](downloads/account-pulse-1.0.0.zip) |

## Bundled plugin directory

Bundled versions were inspected in the Linux beta. The publisher's signed feed has its own versions. The [marketplace catalog](catalog.json) records runtime behavior, compatibility and provenance for each entry.

| Plugin | Category | Bundled | Signed feed | What it does |
| --- | --- | --- | --- | --- |
| **Armory** | Farming | 1.15.0 | 1.14.4 | Rotates accounts through games for pass XP and opens a credit shop. |
| **Games** | Farming | 1.8.0 | 1.8.0 | Targets game reward tiers or Armory XP. |
| **Missions** | Rewards | 1.1.0 | 1.1.0 | Claims finished missions and displays progress. |
| **Monthly pass** | Rewards | 1.3.0 | 1.3.0 | Claims eligible free or Pro monthly pass tiers. |
| **Rewards** | Rewards | 1.3.0 | 1.3.0 | Claims ready rank, click, vault and other reward tiers. |
| **Converter** | Inventory | 1.4.0 | 1.4.0 | Converts cases, skins and capsules into tokens. |
| **Opener** | Inventory | 1.8.0 | 1.6.0 | Previews and opens cases, capsules or collections. |
| **Trader** | Inventory | 1.6.0 | 1.5.0 | Moves tokens and items through one-off trades or saved routes. |
| **Effects** | Inventory | 1.0.0 | — | Buys, sells, activates and queues special effects. |
| **Proxy manager** | Infrastructure | 1.1.0 | 1.1.0 | Publishes proxy and WireGuard routes to the farmer. |

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

## Verify the catalog and plugins

Use Node.js 24 and Python 3.10+. CI validates the catalog, compares packaged ZIPs with their source, exercises the install flow with fixtures, and verifies the pinned publisher signatures.

```sh
npm ci
npm run check
npm run check:packages
npm test
npm run check:publisher
```

## License and attribution

The original marketplace code, docs and example plugin use the [MIT License](LICENSE). ZSB Hub and its publisher plugins are distributed upstream. This is an independent community directory. [ZSB Hub releases](https://github.com/GothGirlZSB/zsb-hub-releases)
