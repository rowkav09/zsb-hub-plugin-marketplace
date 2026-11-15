# Auction Sniper

Scan active auctions from **Inventory → Auction Sniper**. Every request and bid uses the existing Hub session for the clicking account set as **Main account** in Hub Settings. **Check Hub connection** verifies the session and the auction socket from the plugin tab.

1. Choose **Scan auctions** in Practice to see matching listings and their suggested autobid caps.
2. Set an individual cap and a 24-hour commitment budget in tokens.
3. For one batch, switch to **Live**, scan again and confirm **Place previewed autobids**. For repeated scans and bids, switch **On** in Live.

Valuation uses ChunkyCheese's pattern prices and Rowan's Pricedata Overlay calculation. The fixed token conversion defaults to the original bot's 10 tokens per in-game dollar and can be edited. The plugin scans the newest and soonest-ending listings, rechecks each auction and the main account balance before sending its built-in autobid, and records the full commitment against the rolling budget. Stopping the plugin pauses new bids. Case Clicker manages existing autobids in its Auction House.

[PriceData Overlay](https://github.com/rowkav09/CCO-scripts-archive/blob/main/scripts/Utilities/Case%20Clicker%20Pricedata%20Overlay-2.7.user.js)
