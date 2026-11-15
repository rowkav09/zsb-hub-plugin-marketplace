# Auto Forge

Preview and forge patterned skins across farm accounts in **Farming → Forge**. Requires ZSB Hub 1.2.8 or newer.

1. Select the accounts, forge mode and skin type. Set a maximum skin value and attempt limits.
2. Choose **Scan inventories**. Pick exact names from **Skin selection**, or leave the list empty to include all eligible names. Open **Skins in this batch** to see each approved input and its maximum attempts.
3. Choose **Forge previewed skins** and confirm. Recent results stay in the Forge tab, and **Daily reports 1.0.1** can include their counters.

The per-account and batch caps count each attempt, including every stage of a chain. Auto Forge refreshes the inventory before an account starts. It skips favourites, souvenirs, and items that changed or exceeded the approved value. Legendary mode follows the upgraded item returned by the site and verifies its new inventory entry against the price cap and filters before continuing.

Parallel runs use each account's Hub route and share a limit across routes with the same known exit IP. Routes without a verified exit IP share one limit. If another plugin takes the account or its route changes, Auto Forge stops that account's lane. An unconfirmed result stops new attempts across the batch. Requests already sent can finish. Review the affected accounts before acknowledging the pause. The review prompt survives a restart.

Forging can change or consume skins. A new preview is required after a restart, a completed batch, or ten minutes. Changing settings invalidates approval. Picking a name rebuilds the preview from the current scan.

[Download Auto Forge 1.1.1](../../downloads/auto-forge-1.1.1.zip)
