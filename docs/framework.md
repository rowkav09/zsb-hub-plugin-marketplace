# Framework reference

The plugin host is part of the desktop farmer's Node process. The farmer owns account state, scheduled clicks, sessions and routes. Plugins extend it through a CommonJS module and a context object. The desktop and browser panels render blocks from that context and send actions back to the host.

Observed in [ZSB Hub 1.2.7-beta.1](https://github.com/GothGirlZSB/zsb-hub-releases/releases/tag/v1.2.7-beta.1). The code paths below refer to the installed application's `resources/app.asar`. The interfaces can change across app builds.

## Discovery and lifecycle

```text
Bundled plugins/ ─┐
                  ├─ scan by manifest ID and version
User plugins/ ────┘              │
                                 ▼
                  enabled → version and trust checks
                                 │
                                 ▼
                       require(main) → start(ctx)
                                 │
                 engine events / timers / panel actions
                                 │
                                 ▼
                      stop() → host cleanup
```

- **Boot.** `src/core/index.js` creates the store, clicking engine, host and catalog. It scans and starts enabled plugins before resuming the farmer. Account-aware startup code must handle zero running accounts.
- **Discovery.** `src/plugins/host.js` reads each immediate plugin folder. Bundled plugins live in the app archive, and downloaded or imported plugins live in the app's user-data `plugins/` directory. A strictly newer user copy wins over a bundled copy with the same ID. The comparator uses the first three numeric components and ignores the prerelease suffix. Bump a numeric component to replace a bundled version.
- **Start.** The host checks `minCore` and verification, clears the plugin's CommonJS cache, and calls `start(ctx)`. It observes a returned promise for errors and marks the plugin running without waiting for async startup.
- **Stop.** The host calls optional `stop()` synchronously. It clears normal-stop resources such as registered listeners, timers, sockets, panel blocks, shared values, busy/want marks and routes owned by the plugin. Clean up your own resources in `stop()`. Check `ctx.stopping` between steps. A pending `ctx.sleep()` timer is cancelled on stop, leaving its promise pending, so keep essential cleanup out of code that waits for it to resolve.
- **Reload and failures.** The host has a reload RPC. ZIP import and catalog updates rescan and start the replacement if enabled. Startup errors use `CC-PLUG-01`, callback errors `CC-PLUG-02`, compatibility `CC-PLUG-03` and trust `CC-PLUG-04`.

On the inspected Linux installation, app user data is under `~/.config/ZSB Hub/`. A plugin's settings are stored under `settings.json → plugins → <id>`, JSON data under `plugin-data/<id>.json` and optional files under `plugin-data/<id>/`.

## Manifest

A ZIP needs `id`, `version`, and an explicit `main` pointing to an included file. Use a unique ID of 1–40 lowercase letters, digits or hyphens. Use a three-part numeric version and set `minCore` to the app version required by your APIs. For projects using ZIP import from this beta, `1.2.7` satisfies the host's numeric comparator on `1.2.7-beta.1`.

| Field | Effect |
| --- | --- |
| `name`, `description` | Displayed in the Plugins tab. |
| `defaultEnabled` | Fallback when the user has no saved enabled preference. |
| `tab`, `group` | `tab` should exactly match the primary registered tab title. `group` places tabs in a navigation group such as `farming` or `trading`. |
| `settings` | Map from setting keys to field specs. |
| `power: true` | Adds `on` and `runMode`, initially off and Practice. Switching to Practice turns off `on`. Mutating logic must explicitly check `ctx.power.live()`. |

Settings can declare `label`, `help`, `when` (a Boolean setting key), `hidden` and `default`.

| Type | Value and behavior |
| --- | --- |
| `boolean`, `text`, `textarea` | Boolean or string. |
| `number` | Finite number, clamped to `min` / `max` when supplied. |
| `choice` | String from `options: [{value, label}]`. A dynamic choice can populate options at runtime. |
| `account` | Known account ID or an empty string. |
| `accounts` | `{all: false, ids: []}` initially. All includes accounts added later. |
| `tags` | String array, up to 20 chips of up to 60 characters. Deduplicated without regard to case. |
| `list` | Up to 50 rows configured by `fields`. `heading` can label a section inside a row. |

## Context API

| Context | Use |
| --- | --- |
| `ctx.id`, `ctx.coreVersion`, `ctx.log(message, level?, accountId?)` | Identity, compatibility and logging. |
| `ctx.accounts.list()`, `.get(id)`, `.stats(id)`, `.main()` | Account summaries have `id`, `name`, `type`, `running` and `healthy`. Stats are the engine's cached summary. The context's account summary omits session tokens. |
| `ctx.on(event, fn)` | Engine events include `started(id)`, `stopped(id)`, `click(id, count)`, `report(id, me)`, `refused(id)`, `loggedOut(id)` and `change()`. Avoid persisting raw report payloads. |
| `ctx.every(ms, fn)`, `ctx.everyAccount(ms, fn)` | Host-owned timers. Minimum intervals are 1 second and 5 seconds respectively. Account work is staggered and runs on healthy accounts. Callbacks can overlap as the host does not await them. |
| `ctx.request(id, path, options?)` | Routed authenticated HTTP request, gated on account health. Options include `method`, `body`, `tries`, `retryOn`, `timeoutMs`, `okStatus`. Check result `kind` and `status`. Read `json` where present. |
| `ctx.socket(id)` | Opens an authenticated routed socket when supported. The handle offers `emit(event, data)`, `wait(events, ms)` and `close()`. |
| `ctx.settings.get(key)`, `.all()`, `.set(key, value)`, `.runsOn(key, id)` | Read, validate, write and apply account-scoped settings. |
| `ctx.settings.onChange(fn)`, `.setOptions(key, options)` | React to writes and publish dynamic choices. List fields use `listKey.fieldKey` for display options. |
| `ctx.power.live()`, `.practice()` | Live requires mode Live plus On. Practice mode is any mode other than Live. |
| `ctx.data.get()`, `.set(object)`, `ctx.dir` | JSON state with a temporary-write-and-rename path, plus a private data folder for larger files. |
| `ctx.secrets.seal(text)`, `.unseal(value)` | Platform-backed sealing. Unseal can return null if the secret cannot be recovered here. |
| `ctx.network.setRoutes(routes)`, `.probe(id)`, `.pin(accountId, routeId)`, `.state()` | Manage farmer routes. Setting routes replaces the shared route list. Pinning a clicking account can restart its run. |
| `ctx.errors.define(code, spec)`, `.raise(accountId, code, detail)`, `.clear(accountId, code)` | Report plugin-specific issues. Use a unique prefix for your codes. |
| `ctx.shared.set(key, value)`, `.get('plugin-id/key')` | Publishes JSON-cloned data under the caller's ID. Passing null deletes a key. |
| `ctx.accounts.setBusy(id, label)`, `.busy(id, options?)`, `.want(id, label)`, `.wanted(id)` | Cooperative markers for work in progress and handoff requests. Pass null to clear your own marker. |
| `ctx.stopping`, `ctx.sleep(ms)` | Host stop flag and cancellable wait. |

The request and socket gate in this build allows three concurrent starts per route group with at least 100 ms between request starts. Accounts that stop while queued can return `{kind: 'not-running', status: 0}`. HTTP 401 feeds the farmer's session-recovery path. Check for rate, maintenance and transport outcomes. For writes, verify fresh state after ambiguous replies before deciding whether to retry.

## Panel and themes

Register `ctx.panel.tab(title, render)` with a synchronous render function returning `{blocks: [...]}`. Common blocks include:

| Block | Key data |
| --- | --- |
| `stats` | `items: [{label, value}]` |
| `table` | `columns`, `rows`, optional `empty` and `wrap` |
| `text`, `notice` | `text`, with optional `level` on notices |
| `settings` | `keys` from your manifest |
| `buttons` | `items: [{label, action, arg?, primary?, danger?, confirm?}]` |
| `section`, `card` | `title`, nested `blocks`, and optional card controls |
| `hero`, `flow`, `tip`, `checklist`, `list`, `picker`, `shop`, `skillmap` | More specialized layout and interaction blocks in `panel/panel.js`. |

Register button handlers with `ctx.panel.action(name, fn)`. A handler can return an object with `message` for a toast, and `ok: false` plus `error` for a rejection. Ordinary button arguments arrive as strings when supplied. Action handlers should validate incoming arguments. `ctx.panel.badge(fn)` can add a short text annotation to an account card.

Theme plugins register `ctx.panel.theme({vars, css})`, then users select one in **Settings → Theme**. Allowed variable names include `bg`, `surface`, `line`, `text`, `muted`, `ok`, `warn`, `bad` and `radius`. `ctx.panel.asset(file)` returns an embedded image URL. The theme checker restricts CSS imports, external URLs and unregistered image URLs. Passing null clears the plugin's theme.

## How the bundled plugins coordinate

- **Armory → Games.** Armory publishes `armory/farm`, containing selected account IDs and enabled games, and `armory/seating`, which lists accounts currently seating into battles. Games waits on seating and advertises `games/live`. Armory can run its own games when Games is idle.
- **Converter → Armory.** Converter publishes `converter/dlore` for accounts assigned its Dragon Lore upgrade work. Armory uses the list when deciding which accounts can do upgrades.
- **Trader → Armory.** A waiting trade route posts a `want` marker. Armory checks `wanted` and yields accounts after their in-flight work finishes. Opener and other long-running plugins also use busy markers to avoid collisions.
- **Proxy manager → Farmer.** It supplies the shared route list and can probe and pin accounts. The core groups proxy routes with the same known exit IP for capacity and pacing decisions.

[All bundled plugins](../catalog.json) · [Publisher feed and signatures](distribution.md)
