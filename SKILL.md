---
name: zsb-hub-plugin-marketplace
description: Build, inspect, troubleshoot, package, or submit ZSB Hub farmer plugins. Use for the Hub manifest and ctx API, stock ZIP import, or marketplace listings.
---

# ZSB Hub plugin marketplace

The framework reference comes from the installed Linux build `1.2.7-beta.1`. Confirm the target app version before claiming compatibility. For differences in another build, use that build's host, importer and panel as the source of truth.

## Choose the starting point

- Find an existing plugin in [catalog.json](catalog.json). The `version` field for a bundled entry comes from the inspected app. `publisher.version` comes from the separately signed publisher catalog.
- Build one with the [authoring guide](docs/authoring.md) and the working [Account Pulse entry point](plugins/account-pulse/index.js) and [manifest](plugins/account-pulse/plugin.json).
- Look up lifecycle, settings types, panel blocks, scheduling and cross-plugin coordination in the [framework reference](docs/framework.md).
- Diagnose import and signing through the [install guide](docs/install.md) and [distribution reference](docs/distribution.md).
- For a listing, follow [CONTRIBUTING.md](CONTRIBUTING.md). Match the author’s source version to the ZIP and distinguish verified behavior from author-reported compatibility.

## Use the actual plugin contract

- A plugin ZIP contains `plugin.json` at its root or one folder deep. The manifest has a unique lowercase ID, a numeric version and an explicit `main` naming an included CommonJS file. Export `start(ctx)` and optionally `stop()`. Match `manifest.tab` to the title passed to `ctx.panel.tab()`.
- Use cached `ctx.accounts` state for dashboards. Account-scoped actions should honor `ctx.settings.runsOn()` and account health. `ctx.everyAccount()` schedules healthy accounts, and async callbacks can overlap. Use `ctx.request()` for routed requests. Check status and fresh state before retrying writes.
- For scheduled writes, default to Practice and explicitly gate mutations with `ctx.power.live()`. Use `ctx.stopping` between steps and release your busy markers in `finally`. Host cleanup handles resources registered through `ctx` during normal stops. Your plugin owns its own Node resources.
- Community installs use **Plugins → Custom plugins → Import .zip** in ZIP-capable builds. The host requires **Allow unverified plugins** to run unsigned code. Signed-feed JSON uses the publisher's Ed25519 key and install path. Package a community fork under a new ID.
- Use synthetic accounts to check import, enable, panel actions, stop and removal. Put only plugin files and the applicable license in the ZIP. Keep account exports, session material and the installed app archive out of the repository.

## Validate a change

Use [scripts/pack.py](scripts/pack.py) for a locally maintained plugin. Compare the built ZIP and recorded SHA-256 with the catalog entry. After editing listings or documentation, run `npm ci`, `npm run build` and `npm run check` from the repository root. Report the Hub build and paths actually exercised.
