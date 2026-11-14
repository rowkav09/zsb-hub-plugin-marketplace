# Account Pulse

A read-only dashboard for the ZSB Hub farmer. It shows healthy, paused or otherwise unhealthy, and stopped accounts using the farmer's existing account state. The visibility toggle affects the table. Totals always include every account in the Hub.

- Version 1.0.0. Tested against the 1.2.7-beta.1 plugin host.
- The plugin reads account names and runtime flags locally. It makes zero site requests.
- Shows how a manifest provides a saved setting and how a CommonJS entry point registers a tab, a table and a panel action.

[Download Account Pulse 1.0.0](../../downloads/account-pulse-1.0.0.zip) · [Installation guide](../../docs/install.md) · [JavaScript source](index.js) · [Manifest](plugin.json)
