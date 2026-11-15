# Build a plugin

[Daily reports](../plugins/daily-reports/index.js) by Gufries demonstrates how to combine cached account stats, a panel tab and periodic sampling.

## Start with two files

Create a new folder and add `plugin.json`:

```json
{
  "id": "hello-farmer",
  "name": "Hello Farmer",
  "version": "1.0.0",
  "minCore": "1.2.7",
  "main": "index.js",
  "tab": "Hello Farmer",
  "defaultEnabled": false
}
```

Add `index.js`:

```js
module.exports = {
  start(ctx) {
    ctx.panel.tab('Hello Farmer', () => ({
      blocks: [{
        type: 'text',
        text: `${ctx.accounts.list().length} accounts in the farmer`,
      }],
    }));
  },
};
```

Choose a unique ID for distribution. Keep the entry point CommonJS and ship any runtime modules your code needs inside the plugin. The importer copies files from the ZIP.

## Package and try it

From the repository root, use Python 3.10 or newer:

```sh
python3 scripts/pack.py path/to/hello-farmer -o /tmp/hello-farmer-1.0.0.zip
```

Use [the ZIP installation steps](install.md). Open the registered tab and try toggling the plugin off and on. Increment the version before handing out an update.

## Work with accounts

1. Add a setting of type `accounts` for actions that operate on selected accounts. Use `ctx.settings.runsOn(key, account.id)` to apply it.
2. Use `ctx.accounts.list()` for cached state and `ctx.request()` for needed site calls. Use `ctx.everyAccount()` for scheduled per-account work. Track in-flight work per account if dispatches can overlap.
3. Give users a preview, use `power: true` for automatic writes and check `ctx.power.live()` before live work. Check `ctx.stopping` between steps, handle rate limits and use busy markers cooperatively. Release markers in `finally` around the actual work.
4. Persist the minimum state needed with `ctx.data.set()` and handle missing fields from older versions. Keep secrets out of logs and distribution files.

Keep render functions synchronous and cheap. Use panel actions for work that should happen only after a user click. [Context API and panel blocks](framework.md)
