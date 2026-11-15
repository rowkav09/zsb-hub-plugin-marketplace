# Farm Value

Open **Farming → Farm Value** and choose **Capture snapshot**. Once a complete sample is available, open **Stacked history** from the tab. Hub captures hourly while the plugin runs by default.

Each sample combines every Hub account's loose inventory, storage units, cash and token balance. Duplicate item IDs are counted once per account. Inventory valuation uses ChunkyCheese's pattern prices with the same pricing rules as Rowan's Pricedata Overlay. A sample is recorded when every account is reachable and its inventory read completes. The first sample is shown as a stacked bar. Later samples form a stacked history with values on hover.

The chart uses in-game dollars. Tokens convert at the editable **Tokens per $1 in-game value** rate, which defaults to 10. The raw token count is preserved for each sample. Chart history and balances stay on the Hub desktop.

[PriceData Overlay source](https://github.com/rowkav09/CCO-scripts-archive/blob/main/scripts/Utilities/Case%20Clicker%20Pricedata%20Overlay-2.7.user.js)
