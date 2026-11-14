#!/usr/bin/env python3
"""Verify every local community ZIP against a fresh build of its sources."""

import hashlib
import json
import stat
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

from pack import MAX_DATA, MAX_FILES, MAX_ZIP, pack

ROOT = Path(__file__).resolve().parent.parent


def contents(path: Path) -> dict[str, bytes]:
    if path.stat().st_size > MAX_ZIP:
        raise ValueError("archive exceeds the Hub's compressed size limit")
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_DATA:
            raise ValueError("archive exceeds the Hub's entry count or uncompressed size limit")
        for entry in entries:
            if entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
                raise ValueError(f"unsupported ZIP encoding for {entry.filename}")
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f"symlink in archive: {entry.filename}")
            if entry.extract_version >= 45:
                raise ValueError(f"unsupported ZIP version for {entry.filename}")
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("archive contains duplicate paths")
        return {entry.filename: archive.read(entry) for entry in entries}


def check(plugin: dict, temporary_dir: Path) -> None:
    plugin_id = plugin["id"]
    source = ROOT / "plugins" / plugin_id
    download = ROOT / "downloads" / f'{plugin_id}-{plugin["version"]}.zip'
    if download.stat().st_size > MAX_ZIP:
        raise ValueError("archive exceeds the Hub's compressed size limit")
    actual_sha256 = hashlib.sha256(download.read_bytes()).hexdigest()
    if actual_sha256 != plugin["sha256"]:
        raise ValueError(f"catalog SHA-256 mismatch for {download.name}")

    # Match source bytes independently of compression differences across zlib versions.
    expected_archive = temporary_dir / download.name
    license_path = ROOT / "LICENSE" if plugin["license"] == "MIT" and not (source / "LICENSE").exists() else None
    pack(source, expected_archive, license_path)
    expected, actual = contents(expected_archive), contents(download)
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    changed = sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name])
    if missing or extra or changed:
        raise ValueError(f"archive differs from source (missing={missing}, extra={extra}, changed={changed})")

    for name in expected:
        if Path(name).suffix in {".js", ".cjs", ".mjs"}:
            subprocess.run(["node", "--check", str(source / name)], check=True)
    print(f"{plugin_id}: SHA-256, source contents and JavaScript syntax verified")


def main() -> None:
    catalog = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    packages = [
        plugin for plugin in catalog["plugins"]
        if plugin["kind"] == "community" and plugin["source"].startswith("plugins/")
    ]
    with tempfile.TemporaryDirectory() as directory:
        for plugin in packages:
            try:
                check(plugin, Path(directory))
            except (OSError, ValueError, subprocess.CalledProcessError) as error:
                raise SystemExit(f'{plugin["id"]}: {error}') from error
    print(f"Checked {len(packages)} local ZIP packages")


if __name__ == "__main__":
    main()
