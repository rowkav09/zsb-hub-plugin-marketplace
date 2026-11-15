# Install plugins

Use the **Plugins** tab in ZSB Hub. The steps here were checked against [ZSB Hub 1.2.7-beta.1](https://github.com/GothGirlZSB/zsb-hub-releases/releases/tag/v1.2.7-beta.1), the build that introduced ZIP import.

## External Marketplace

1. Import the [external marketplace ZIP](../downloads/zsb-marketplace-1.0.0.zip) using **Plugins → Custom plugins → Import .zip**.
2. Enable **Settings → Allow unverified plugins** after reviewing the [source](../plugins/zsb-marketplace/). Select **Turn on** for **ZSB Hub External Plugin Marketplace**.
3. In **External Marketplace**, select a community plugin, then confirm **Install** or **Update**. Go to **Plugins** to enable or remove the imported plugin. If you enable the trust setting while the marketplace is open, use **Refresh catalog**.

The marketplace needs the ZSB Hub desktop window for the install bridge. To update the marketplace itself, import its newest ZIP through the usual file picker.

## Publisher plugins

1. Open **Plugins** and find the plugin by name.
2. Use **Install** if the signed release catalog offers it, or **Update** when a newer compatible release is offered.
3. Select **Turn on**. The app opens the plugin tab automatically when it has one. To return later, select **Open** on the plugin’s entry. Choose accounts where applicable. Some plugins also have a separate Live or On control.

Bundled plugins are available as soon as you have the app build that ships them. Effects ships in the inspected beta. The publisher catalog has its own version history. In the catalog snapshot used here, the beta bundles newer copies of Armory, Opener and Trader.

## Community ZIPs

1. Download [Daily reports](../downloads/daily-reports-1.0.0.zip) or another community package. Review the source and the author's provenance before you enable a package.
2. In **Plugins → Custom plugins**, select **Import .zip**. Choose the individual plugin ZIP. Leave it compressed.
3. For an unsigned package you trust, enable **Settings → Allow unverified plugins**. This is an app-wide setting. Plugins run as Node code with the desktop user's permissions.
4. Return to **Plugins** and select **Turn on**. The Hub opens the plugin tab if it has one.

To update a community plugin, import its next version with the same ID. The app stores settings and state by ID. To uninstall it, use **Plugins → Remove**. Its saved settings and data can still be present after removal.

## Common errors

| Message or symptom | What to check |
| --- | --- |
| Import .zip is missing | Check the app version. This guide covers the 1.2.7 beta import workflow. |
| `CC-PLUG-03` or app version required | Check `minCore` against your app version. |
| `CC-PLUG-04` or unverified | The ZIP carries no valid publisher signature. The app-wide setting controls whether it can start. |
| Official name already taken | Use a new ID for a community fork. The ZIP importer reserves bundled and listed IDs for publisher-signed content. |
| Missing manifest or entry file | Put `plugin.json` at the ZIP root or in a single wrapping folder. The archive must contain the file named in `main`. |
| `CC-PLUG-01` or `CC-PLUG-02` | Read the Hub log for the load or callback error. |
| Plugin runs but does no account work | Check that the account is clicking normally, is included by the plugin's account selector, and is eligible for the operation. Check Live/On and any account conflicts. |

[Build a plugin](authoring.md) · [Framework reference](framework.md)
