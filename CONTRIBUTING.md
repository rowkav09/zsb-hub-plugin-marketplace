# Contribute a plugin

[Submit a plugin](https://github.com/rowkav09/zsb-hub-plugin-marketplace/issues/new?template=submit-plugin.yml) to send a listing from your browser. Keep your source and releases wherever you maintain the plugin.

1. Tag the source and publish one versioned ZIP containing a single plugin.
2. Import the ZIP into ZSB Hub and exercise a representative action. Use test accounts for features that can change account state.
3. Send the source and release links, license, plugin ID, version and Hub build through the form. Describe account changes and external services so reviewers can describe the plugin accurately.

For an update, use the same ID and link the new source tag and ZIP. A maintainer can review the package and add or update the listing from the submission. A submitted listing does not install anything into the Hub.

## Send a catalog pull request

A listing for an externally maintained plugin can reference HTTPS source and release URLs. Use `kind: "community"`, an author, license, category, version and minimum core. Set `source` to the versioned source URL and `download` to the versioned direct ZIP URL. Record the ZIP's SHA-256 and describe how to reproduce the test in the PR.

For a plugin maintained in this repository, add `plugins/<id>/` with `plugin.json`, its entry point and `README.md`. Package the directory as shown below. Use `-a LICENSE` when including the repository license in a package that lacks its own copy.

```sh
python3 scripts/pack.py plugins/<id> -o downloads/<id>-<version>.zip
```

Use the Account Pulse entry in [catalog.json](catalog.json) as the example for local `source` and `download` paths. Copy the SHA-256 printed by the packer to your entry.

Run `npm ci`, `npm run build` and `npm run check`. Include the generated pages with the catalog change. Leave account exports, logs and credentials out of the package.

[Authoring guide](docs/authoring.md) · [Package and signing formats](docs/distribution.md) · [Agent skill](SKILL.md)
