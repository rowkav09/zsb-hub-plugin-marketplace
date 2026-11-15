# Auto Skin Collection Completer

Work through skin collections on farm accounts from **Farming → Skin Collections**. Requires Hub 1.2.8 or newer.

1. Choose accounts and select **All purchasable collections** to discover matching collections from the live shop. For a smaller batch, select **Only named collections** and enter the exact names from the game's Skin Collection page.
2. Set the submission value limit and choose how to fill gaps. Use **Submit from inventory** for existing skins, **Also open owned cases** to draw from case stock, or **Also buy and open within budget** with an explicit spend cap and cash reserve.
3. To include Armory collections, turn on **Include Armory redemptions** and set a separate credit budget.
4. Run **Preview**. For a one-off batch, choose **Live** with **On** off, preview again and confirm. For recurring runs, choose **Live**, switch **On** on and set the interval. **Practice** gives a read-only preview.

Collection submissions consume one skin from the specified group. The game chooses the physical copy. The preview gives the maximum value and the number of eligible copies. The plugin rechecks those copies, skips favourites and withholds a group if the full candidate set is unavailable or exceeds the value cap. It verifies progress before claiming a completed reward.

Case buying follows the live shop quote and set limits. Quick openings keep the drops. A later scan can submit those drops. The Armory sells containers in bundles of ten. The plugin spends credits on one bundle when the account has run out of that container, verifies stock and credits, then opens one case per request with a stock check in between. Unopened cases carry over to later runs. Standard shop cases still use the account’s batch-opening limit. Interrupted or unconfirmed writes require review before automation can continue.

[Download the plugin](../../downloads/auto-skin-collection-1.1.0.zip) · [ChunkyCheese's Auto Submit reference](https://discord.com/channels/1042469313820495952/1480822553173037156/1480822865153491065)
