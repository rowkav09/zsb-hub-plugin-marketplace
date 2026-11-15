# Auto Sort SU

Sort main-inventory skins into existing storage units from **Farming → Storage Sort**. Requires Hub 1.2.8 or newer.

Choose farm accounts and add rules with an exact storage unit name. Use **Only this account** to scope a rule to one account. An empty account field applies it to all selected accounts. Lower priority numbers take precedence. Rules with equal priority follow their list order.

| Priority | Match | Destination |
| --- | --- | --- |
| 1 | Rank #1 in any float category | `#1` |
| 2 | 100% Fade | `Fade` |

In this example a skin matching both rules goes to `#1`. Create the storage units in-game before running the plugin. If a rule's unit is missing, ambiguous or full, its matching skins wait for a destination.

Rules can also match the top ten in any float category, an exact pattern, part of a skin name, a rarity, or favourites. Rank rules use the game's indexed ranks and verify a match again before depositing.

Run **Preview** to check the proposed moves. For a one-off batch, choose **Live** with **On** off, preview again and confirm. For recurring runs, choose **Live**, switch **On** on and set the interval. Each move is checked in its destination unit.

[Download the plugin](../../downloads/auto-sort-su-1.0.0.zip)
