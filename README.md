# ZSB Plugin Exchange

**Browse plugins for the ZSB Hub farmer, learn how they work, and ship your own.**

[Install a plugin](docs/install.md) · [Framework reference](docs/framework.md) · [Build a plugin](docs/authoring.md) · [Contribute](CONTRIBUTING.md)

## Plugin catalog

Bundled versions below are from the [ZSB Hub 1.2.7-beta.1 Linux release](https://github.com/GothGirlZSB/zsb-hub-releases/releases/tag/v1.2.7-beta.1). The signed publisher feed has its own version history.

| Plugin | Bundled | Signed feed | What it does |
| --- | --- | --- | --- |
| Armory | 1.15.0 | 1.14.4 | Rotates accounts through games for pass XP, maintains passes and exposes a credit shop. |
| Games | 1.8.0 | 1.8.0 | Targets game reward tiers or XP for the Armory. |
| Missions | 1.1.0 | 1.1.0 | Claims finished missions and displays progress. Enabled by default. |
| Monthly pass | 1.3.0 | 1.3.0 | Claims eligible free or Pro monthly pass tiers. |
| Rewards | 1.3.0 | 1.3.0 | Claims ready rank, click, vault and other reward tiers. |
| Converter | 1.4.0 | 1.4.0 | Converts cases, skins and capsules into tokens and optionally attempts Dragon Lore upgrades. |
| Opener | 1.8.0 | 1.6.0 | Previews and opens cases, capsules and collections. |
| Trader | 1.6.0 | 1.5.0 | Moves tokens and items between clicking accounts through one-off trades or saved routes. |
| Effects | 1.0.0 | — | Buys, sells, activates and queues special effects. Bundled in the inspected beta. |
| Proxy manager | 1.1.0 | 1.1.0 | Publishes proxy and WireGuard routes to the farmer. |

Use **Plugins** in ZSB Hub to enable bundled plugins and install signed updates. The marketplace also has a page for each plugin covering compatibility and how it integrates with the farmer. [Publisher catalog snapshot](https://github.com/GothGirlZSB/zsb-hub-releases/blob/37cd27f8b422d928e729d7082d9b1ea601990b5a/plugins/catalog.json) · [Exchange catalog JSON](catalog.json)

### Community download

[**Account Pulse 1.0.0 ZIP**](downloads/account-pulse-1.0.0.zip) is a read-only view of which accounts are healthy, need attention or are stopped. It uses data already held by the farmer and makes zero site requests. Import the ZIP from **Plugins → Custom plugins → Import .zip**. This unsigned plugin uses the app's **Allow unverified plugins** setting. [Source](plugins/account-pulse/) · [Installation](docs/install.md#community-zips)

## Preview the marketplace

Run from the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [the local marketplace](http://127.0.0.1:8000). The static pages are checked in and can be hosted from the root of `main` by [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

To regenerate HTML after changing the catalog or documentation, use Node 24:

```sh
npm ci
npm run build
npm run check
```

[Contribution guide](CONTRIBUTING.md) · [Package and signing formats](docs/distribution.md) · [License](LICENSE)
