# Distribution and trust

## Publisher feed

ZSB Hub's packaged `pluginCatalogUrl` targets the publisher's releases repository. `src/plugins/catalog.js` checks at startup, every six hours and on manual refresh. Installing an update is a user action.

1. Read `catalog.json` and `catalog.json.sig`. The signature file holds Base64 Ed25519 bytes over the exact catalog JSON bytes. The app has the publisher's public key.
2. Select an entry by ID and check its `minCore`. Download the entry's `file` and compare its SHA-256 to the signed entry.
3. Parse the bundle. Its envelope is `{format: 1, id, version, files}`. `files` maps relative paths to Base64 file contents, including `plugin.json` and `plugin.sig`.
4. Verify the unpacked folder with the release key. The signed payload is the concatenation of sorted relative paths, each followed by a line feed, its lowercase SHA-256 hex digest, and another line feed. Paths use forward slashes. Files named `plugin.sig` are excluded from the payload.
5. Stage the plugin in a temporary install folder, swap it into user data, rescan and start it if enabled.

The signed index format is `{format: 1, updatedAt, plugins: [...]}`. An entry contains `id`, `name`, `version`, `description`, `minCore`, `file`, `sha256` and `size`. This repository tracks a pinned publisher snapshot. The catalog and all nine bundles described here were verified with the public key in the inspected app. [Signed catalog](https://github.com/GothGirlZSB/zsb-hub-releases/blob/37cd27f8b422d928e729d7082d9b1ea601990b5a/plugins/catalog.json) · [Signature](https://github.com/GothGirlZSB/zsb-hub-releases/blob/37cd27f8b422d928e729d7082d9b1ea601990b5a/plugins/catalog.json.sig)

## Community registry

The site uses [catalog.json](../catalog.json) to describe bundled plugins and community packages. The installed app trusts the publisher key for the official feed. Community releases reach the stock app through **Import .zip**. A publisher JSON bundle is for the in-app catalog installer. The file picker expects a ZIP.

A ZIP can hold plugin files at the root or under a single wrapping folder. Use stored or deflated entries, up to 500 entries, 20 MiB compressed and 50 MiB unpacked. The ZIP loader rejects encrypted entries, ZIP64, unsafe relative paths and unsigned claims to official IDs. A ZIP that includes an intact publisher-signed plugin folder receives the verified status. Other community ZIPs require the app's unverified setting to run.

The host loads CommonJS with ordinary Node `require()`. Plugins therefore run with the desktop user's privileges. A community SHA-256 protects against accidental changes to a specific download. Publisher verification comes from the release signature checked by the app.

## Provenance

Framework behavior was inspected in the installed Linux beta at `resources/app.asar`, primarily `src/plugins/{host,catalog,zipimport,theme}.js`, `src/core/{index,engine,site}.js`, `panel/panel.js` and the bundled `plugins/` folders.

The publisher repository supplies the official packages. The Exchange contains original documentation, site code and Account Pulse. Publisher plugin code is linked through the official catalog. [Publisher releases](https://github.com/GothGirlZSB/zsb-hub-releases)
