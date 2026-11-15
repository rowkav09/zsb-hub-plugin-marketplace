# Forge Queue

Preview and forge eligible skins across selected farm accounts from the **Farming → Forge Queue** tab. Requires ZSB Hub 1.2.8 or newer.

1. Select the farm accounts. Set a maximum skin value, starting quality, and per-account and total attempt limits. Use the skin name filter to narrow the scan.
2. Choose **Scan inventories**. Expand **Skins in this batch** to review the approved items and their input value.
3. Choose **Forge previewed skins** and confirm. Review the result for each attempt.

Forge Queue scans a configurable number of pages per account and allocates batch slots across accounts. It excludes favourites, souvenirs and skins without patterns. Before forging on each account it refreshes inventory and skips items that no longer qualify, changed quality, or increased in value. Forging changes or can consume the input skin. The preview expires after ten minutes or when settings change. If a forge outcome is unconfirmed, the batch stops.

The plugin uses each clicking account's Hub route and coordinates with plugins that mark an account as busy. Inventory and forge behaviour were referenced from [Auto Forge](https://github.com/rowkav09/CCO-scripts-library/blob/main/scripts/Utilities/auto-forge.user.js).

[Download Forge Queue](../../downloads/forge-queue-1.0.0.zip)
