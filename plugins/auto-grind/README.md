# Auto Grind

Auto Grind levels a selected Case Clicker Online account inside ZSB Hub. It sets the account to Hub's **Auto** click mode and runs short, repeated case-opening batches toward a configurable Premier target. The default target is **5,000 Premier**.

## Start a plan

1. Install **Auto Grind** from External Marketplace and enable it in Plugins. Supported desktop builds are **1.2.8** and **1.2.11**.
2. Open **Farming → Auto Grind**, select a Hub account, and choose a weapon case. **Load case choices** fetches the current catalog and prices. The default selects the cheapest unlocked weapon case within the purchase limit.
3. Review the price limit, cash reserve and skillmap choices. **Preview plan** reads the account and shows the next case and skill without making a purchase.
4. Select **Enable Auto Grind / save plan**. The account's plan is saved and Hub starts it when possible. The tab shows Premier progress, case spend, the current skill reserve and any reason the plan is waiting. Use **Pause** to suspend the leveling plan while Hub clicking continues.

Each account saves its own copy of the plan. To change it, select the same account, edit the preferences, and save again.

For new accounts, enable **Auto Grind after adding the account** in [Routed Account Setup](https://github.com/rowkav09/zsb-hub-account-setup/releases/tag/v1.2.0) before opening signup. The imported account takes the current Auto Grind settings and starts leveling once its pinned route has capacity and Hub starts clicking.

## Case and skill priorities

- **Clicking.** Hub Auto controls money and case clicking using Hub's normal threshold. Auto Grind can display an active starter boost reported by Case Clicker. The case loop runs alongside Hub clicking from the first eligible turn.
- **XP.** The loop opens owned stock first. When the selected stock runs out, it buys a small batch at the current catalog price within the per-case limit and rechecks stock before opening. It stops buying and opening at the target by default. Hub Auto and eligible skill upgrades continue.
- **Skillmaps.** Configure case-click frequency, case price, custom skill IDs in priority order, or skip skill spending at each milestone. The plugin checks skills and prerequisites as Dust II, Mirage, Inferno, Ancient, Anubis and Cobblestone unlock. Dynamic builds prioritize case benefits per point and account for the cost of prerequisites.
- **Cash.** The leveler sets aside the current price of the next eligible skill plus your cash reserve. Locked maps and goals that require more skill points do not consume the case budget.
- **Inventory.** Drops are kept by default. You can set a cash threshold to sell eligible common drops from this plugin's own opening response. The case loop waits when there is no inventory space.
- **Recovery.** Plans persist across Hub restarts. The leveler waits for busy accounts and keeps uncertain case or skill writes paused for review.

[Case Clicker progression and skill points](https://case-clicker.com/help) · [Case Clicker weapon cases](https://case-clicker.com/cases/cases)
