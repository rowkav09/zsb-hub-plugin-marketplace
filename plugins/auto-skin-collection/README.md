# Auto Skin Collection Completer

Work through skin collections on farm accounts from **Farming → Skin Collections**. Requires Hub 1.2.8 or newer.

1. Choose accounts and select **All purchasable collections** to discover matching collections from the live shop. For a smaller batch, select **Only named collections** and enter the exact names from the game's Skin Collection page.
2. Set the submission value limit and choose how to fill gaps. Use **Submit from inventory** for existing skins, **Also open owned cases** to draw from case stock, or **Also buy and open within budget** with an explicit spend cap and cash reserve.
3. To include Armory collections, turn on **Include Armory redemptions** and set a separate credit budget. Leave it at zero to estimate the cost and use owned Armory cases.
4. Run **Preview**. For a one-off batch, choose **Live** with **On** off, preview again and confirm. For recurring runs, choose **Live**, switch **On** on and set the interval. **Practice** gives a read-only preview.

Collection submissions consume one skin from the specified group. The game chooses the physical copy. The preview gives the maximum value and the number of eligible copies. The plugin rechecks those copies, skips favourites and withholds a group if the full candidate set is unavailable or exceeds the value cap. It verifies progress before claiming a completed reward.

Each run submits eligible inventory skins, opens owned cases across the selected collections, and buys only for gaps that remain. It checks each opening, submits eligible drops during the same run, and claims completed rewards as it goes. It stops opening for a completed collection and honors the per-account caps on openings, submissions, case spend and credits. A submission value cap of zero pauses submissions. Quick openings keep the drops.

The Armory sells bundles of ten. The preview shows the live bundle price, owned case count and a best-case credit minimum. That minimum assumes each needed opening drops a different eligible missing skin. Duplicate and rare drops can raise the cost. Armory openings run one at a time, while standard shop cases use the account's normal batch size. Interrupted or unconfirmed writes require review before automation can continue.

[Download the plugin](../../downloads/auto-skin-collection-1.2.0.zip) · [ChunkyCheese's Auto Submit reference](https://discord.com/channels/1042469313820495952/1480822553173037156/1480822865153491065)
