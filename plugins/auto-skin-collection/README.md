# Auto Skin Collection Completer

Work through skin collections on farm accounts from **Farming → Skin Collections**. Requires Hub 1.2.8 or newer.

1. Open **Run once** and choose the accounts and collections to work on. **All purchasable collections** uses the live case shop. **Only named collections** accepts exact names from the game's Skin Collection page.
2. Use **Run limits** to choose the submission value limit and how to fill gaps. Select inventory, owned cases, or purchases within a cash budget.
3. Turn on **Include Armory redemptions** if wanted. A zero credit budget lets the run open owned Armory cases.
4. Select **Preview**, review the per-account plan, and confirm **Run previewed jobs once**. **Run progress** shows the active collection, account completion, and cash and Armory credits used as the run proceeds.

When Armory or another plugin is using an account, the approved run requests a handoff and shows what it is waiting for. It starts after the account is released and rechecks the approved plan on the same route. Armory can hold an account until its current turn ends. **Stop** cancels a queued handoff.

## Collection progress

**Collection progress** opens first and loads every collection across your Hub accounts once an account is clicking. Each dropdown shows how many accounts have completed that collection and lists progress and reward status by account. The header shows total collections, checked accounts, combined completions and estimated Armory credits. Use **Refresh collection progress** to update the numbers.

Armory estimates use recorded submissions, the inventory count of matching cases, the live price per pack of ten and the average number of additional packs needed to drop every missing skin. Each individual skin in a rarity tier is treated as equally likely. Estimates use [Case Clicker’s case odds](https://case-clicker.com/cases/cases/fever-case) and [Perfect World’s Armory odds](https://www.csgo.com.cn/news/gamebroad/20170911/206155.shtml) as the simulator model. Already owned cases are opened first in the calculation. Skins awaiting submission can reduce the cost further. The estimate is separate from the spending cap.

Collection submissions consume one skin from the specified group. The game chooses the physical copy. The plugin checks all matching inventory copies during preview and again immediately before submitting. A favourited copy or an unknown favourite status blocks the whole group. Groups also need a complete candidate list with prices within the configured cap. The plugin verifies progress before claiming a completed reward.

Each run submits eligible inventory skins, opens owned cases across the selected collections, and buys only for gaps that remain. It checks each opening, submits eligible drops during the same run, and claims completed rewards as it goes. A run keeps working while cases are available within the per-account cash and Armory budgets. Completed collections, favourite protection, inventory space and account availability can finish work earlier. A submission value cap of zero pauses submissions. Quick openings keep the drops.

The Armory sells bundles of ten. The preview shows the live bundle price, owned case count and a best-case credit minimum. That minimum assumes each needed opening drops a different eligible missing skin. Duplicate and rare drops can raise the cost. Armory openings run one at a time, while standard shop cases use the account's normal batch size. Interrupted or unconfirmed writes require review before automation can continue.

[Download the plugin](../../downloads/auto-skin-collection-1.5.2.zip) · [ChunkyCheese's Auto Submit reference](https://discord.com/channels/1042469313820495952/1480822553173037156/1480822865153491065)
