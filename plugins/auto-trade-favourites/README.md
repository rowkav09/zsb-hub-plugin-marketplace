# Auto Trade Favourites

Send favourited skins from selected farm accounts to a collector account from **Farming → Trade Favourites**. Requires Hub 1.2.8 or newer.

1. Select the sender accounts and one receiving Hub account. Set the price range, trade caps and how many receiving trades you want to keep available.
2. Run **Preview** to see the proposed skins, values and destination.
3. For a one-off batch, set **Mode → Live** with **On** off, create a fresh preview and confirm the trades. For recurring runs, switch **On** on in **Live** and set the interval.

Both sides must be clicking normally. The plugin rechecks the sender's favourites and the receiver's capacity before a one-way trade. It checks the two site accounts, keeps token quantities at zero, and looks for the selected skin IDs in the receiving inventory after confirmation. Only explicitly favourited items within the filters are selected from main inventory.

An unconfirmed trade pauses the batch and turns off scheduling. Check the Trading page and both inventories before acknowledging review.

[Download the plugin](../../downloads/auto-trade-favourites-1.0.0.zip)
