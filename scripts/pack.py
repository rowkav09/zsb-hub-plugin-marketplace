#!/usr/bin/env python3
"""Build a reproducible ZSB Hub import archive from a plugin directory."""

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

MAX_FILES = 500
MAX_ZIP = 20 * 1024 * 1024
MAX_DATA = 50 * 1024 * 1024
SKIP = {".git", ".DS_Store", "__MACOSX", "__pycache__"}
PRIVATE = {"accounts.json", "settings.json", "income.json", "plugin-data", "Partitions"}


def pack(source: Path, output: Path, extra: Path | None) -> str:
    if not source.is_dir():
        raise ValueError("pass a plugin directory")
    if output.is_relative_to(source):
        raise ValueError("write the ZIP outside the plugin directory")

    entries = {}
    for file in sorted(source.rglob("*")):
        rel = file.relative_to(source)
        if SKIP.intersection(rel.parts):
            continue
        if file.is_symlink():
            raise ValueError(f"symlinks are unsupported: {rel}")
        if PRIVATE.intersection(rel.parts) or any(
            part.lower().startswith((".env", "cookies")) for part in rel.parts
        ):
            raise ValueError(f"remove local configuration from the plugin: {rel}")
        if any(re.search(r"[:\\\x00]", part) for part in rel.parts):
            raise ValueError(f"unsupported ZIP path: {rel}")
        if file.is_file():
            entries[rel.as_posix()] = file

    if extra:
        if extra.name in entries:
            raise ValueError(f"duplicate file: {extra.name}")
        entries[extra.name] = extra

    if "plugin.json" not in entries:
        raise ValueError("plugin.json is missing")
    manifest = json.loads(entries["plugin.json"].read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("plugin.json must be an object")
    if not re.fullmatch(r"[a-z0-9-]{1,40}", str(manifest.get("id", ""))):
        raise ValueError("id must contain 1–40 lowercase letters, digits or hyphens")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
        raise ValueError("use a numeric x.y.z version")
    main = manifest.get("main")
    if not isinstance(main, str) or main not in entries:
        raise ValueError("main must name a file in the ZIP")
    if len(entries) > MAX_FILES or sum(p.stat().st_size for p in entries.values()) > MAX_DATA:
        raise ValueError("the ZIP would exceed the importer's file or unpacked size limit")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        archive = Path(directory) / "plugin.zip"
        with ZipFile(archive, "w", allowZip64=False) as zip_file:
            for name, file in sorted(entries.items()):
                info = ZipInfo(name)
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                zip_file.writestr(info, file.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
        if archive.stat().st_size > MAX_ZIP:
            raise ValueError("the ZIP exceeds the 20 MiB import limit")
        sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.replace(output)
    return sha256


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("-a", "--add-file", type=Path, help="add a license file at the ZIP root")
    args = parser.parse_args()
    try:
        checksum = pack(args.source.resolve(), args.output.resolve(), args.add_file)
    except (OSError, ValueError) as error:
        parser.exit(1, f"pack: {error}\n")
    print(f"{checksum}  {args.output}")
