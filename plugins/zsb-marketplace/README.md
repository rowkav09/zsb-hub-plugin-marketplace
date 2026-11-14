# ZSB Hub External Plugin Marketplace

An independent community plugin that lists and installs ZIPs from the [GitHub catalog](https://github.com/rowkav09/zsb-hub-plugin-marketplace/blob/main/catalog.json) inside the ZSB Hub desktop app.

Import the marketplace ZIP once with **Plugins → Custom plugins → Import .zip**. Enable **Allow unverified plugins** in Settings after reviewing the source, then turn the marketplace on. In **External Marketplace**, select a plugin and choose **Install** or **Update**. Imported plugins appear in the Hub's normal **Plugins** list. A newly imported plugin starts off. Updates preserve its Hub settings.

The marketplace checks the download's SHA-256 and manifest before submitting the original ZIP to the Hub's importer. Publisher-signed plugins are managed in the Hub's official Plugins catalog. To update the marketplace itself, import its latest ZIP.

Requires the ZSB Hub desktop panel and the importer shipped with **1.2.7-beta.1**. The panel bridge uses internal Hub interfaces and may need an update when the app changes.
