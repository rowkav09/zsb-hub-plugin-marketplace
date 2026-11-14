# Contribute a plugin

Open a pull request against the repository's `main` branch with a catalog entry. New entries should use a unique ID, identify the author and license, state the minimum supported core, and describe what the plugin reads or changes. Include a versioned ZIP and its SHA-256 along with inspectable source.

For plugins maintained in this repository:

1. Add a directory under `plugins/<id>/` containing the manifest, entry point and documentation.
2. Run `python3 scripts/pack.py plugins/<id> -o downloads/<id>-<version>.zip`. Use `-a LICENSE` to add the repository license if your plugin uses it and the directory lacks its own copy.
3. Add a `community` entry to `catalog.json`. Use Account Pulse as an example. Copy the SHA-256 printed by the pack command, and state that an unsigned build requires **Allow unverified plugins**.
4. Run `npm ci`, `npm run build`, and `npm run check`. Include the generated pages with the catalog change.
5. Include how you tested installation, the ZSB Hub build, and any account operations exercised.

Ship only files needed by the plugin and its license. Use fixtures with invented account data when testing.

[Author guide](docs/authoring.md) · [Package and signature formats](docs/distribution.md)
