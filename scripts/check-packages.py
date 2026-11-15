#!/usr/bin/env python3
"""Validate and statically scan the exact ZIPs offered by the community catalog."""

import hashlib
import json
import re
import stat
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile

from pack import MAX_DATA, MAX_FILES, MAX_ZIP, pack

ROOT = Path(__file__).resolve().parent.parent
RELEASE_ZIP = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/releases/download/[\w.-]+/[\w.-]+\.zip", re.I)
ASSET_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
JS_EXTENSIONS = {".js", ".cjs", ".mjs"}


class ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlsplit(newurl)
        if (
            url.scheme != "https"
            or url.hostname not in ASSET_HOSTS
            or url.port
            or url.username
            or url.password
        ):
            raise ValueError("unexpected GitHub release redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_release(url: str, output: Path) -> None:
    if not RELEASE_ZIP.fullmatch(url):
        raise ValueError("external ZIP must be a versioned GitHub release asset")
    with build_opener(ReleaseRedirect).open(url, timeout=20) as response:
        data = response.read(MAX_ZIP + 1)
    if len(data) > MAX_ZIP:
        raise ValueError("archive exceeds the Hub's compressed size limit")
    output.write_bytes(data)


def contents(archive_path: Path) -> dict[str, bytes]:
    if archive_path.stat().st_size > MAX_ZIP:
        raise ValueError("archive exceeds the Hub's compressed size limit")
    with ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_DATA:
            raise ValueError("archive exceeds the Hub's entry count or uncompressed size limit")
        files = {}
        seen_names = set()
        for entry in entries:
            name = entry.orig_filename.replace("\\", "/")
            is_directory = name.endswith("/")
            name = name[:-1] if is_directory else name
            if (
                any(part in {"", ".", "..", "__proto__"} or part.endswith((".", " "))
                    for part in name.split("/"))
                or re.search(r'[\x00-\x1f:<>"|?*]', name)
            ):
                raise ValueError(f"unsafe archive path: {name!r}")
            if name.casefold() in seen_names:
                raise ValueError(f"duplicate archive path: {name!r}")
            seen_names.add(name.casefold())
            if entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
                raise ValueError(f"unsupported ZIP encoding for {name!r}")
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f"symlink in archive: {name!r}")
            if entry.extract_version >= 45:
                raise ValueError(f"unsupported ZIP version for {name!r}")
            if any(part in {"__MACOSX", ".DS_Store"} for part in name.split("/")):
                continue
            if not is_directory:
                files[name] = archive.read(entry)

    if "plugin.json" not in files:
        roots = {name.split("/", 1)[0] for name in files}
        if len(roots) == 1:
            root = roots.pop() + "/"
            if root + "plugin.json" in files:
                files = {name.removeprefix(root): data for name, data in files.items()}
    if "plugin.json" not in files:
        raise ValueError("expected a root or single-folder plugin.json")
    for name in files:
        if any(str(parent) in files for parent in PurePosixPath(name).parents):
            raise ValueError(f"file cannot also be a directory: {name!r}")
    return files


def check(plugin: dict, temporary_dir: Path) -> None:
    plugin_id, version = plugin["id"], plugin["version"]
    if not re.fullmatch(r"[a-z0-9-]{1,40}", plugin_id) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("invalid plugin ID or version")
    filename = f'{plugin_id}-{plugin["version"]}.zip'
    source = ROOT / "plugins" / plugin_id
    local = plugin["download"] == f"downloads/{filename}"
    if local:
        download = ROOT / "downloads" / filename
    else:
        download = temporary_dir / filename
        download_release(plugin["download"], download)
    if download.stat().st_size > MAX_ZIP:
        raise ValueError("archive exceeds the Hub's compressed size limit")
    if hashlib.sha256(download.read_bytes()).hexdigest() != plugin["sha256"]:
        raise ValueError(f"catalog SHA-256 mismatch for {download.name}")

    actual = contents(download)
    manifest = json.loads(actual["plugin.json"])
    if not isinstance(manifest, dict):
        raise ValueError("plugin.json must be an object")
    for key in ("id", "name", "version", "minCore", "defaultEnabled"):
        if manifest.get(key) != plugin[key] or (key == "defaultEnabled" and manifest[key] is not False):
            raise ValueError(f"ZIP manifest mismatch on {key}")
    main = manifest.get("main")
    if not isinstance(main, str) or main not in actual or PurePosixPath(main).suffix not in JS_EXTENSIONS:
        raise ValueError("manifest main must name a JavaScript file inside the plugin")

    if local:
        # Compare file bytes independently of compression and the wrapping folder.
        expected_archive = temporary_dir / ("repacked-" + filename)
        license_path = ROOT / "LICENSE" if plugin["license"] == "MIT" and not (source / "LICENSE").exists() else None
        pack(source, expected_archive, license_path)
        expected = contents(expected_archive)
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name])
        if missing or extra or changed:
            raise ValueError(f"archive differs from source (missing={missing}, extra={extra}, changed={changed})")

    files = {name: data.decode("utf-8") if PurePosixPath(name).suffix.lower() in JS_EXTENSIONS else ""
             for name, data in actual.items()}
    subprocess.run(
        ["node", str(ROOT / "scripts" / "scan-plugin.cjs")],
        input=json.dumps({"id": plugin_id, "files": files}),
        text=True,
        check=True,
        timeout=30,
    )
    print(f"{plugin_id}: ZIP integrity, manifest and static security scan passed", flush=True)


def main() -> None:
    catalog = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    packages = [plugin for plugin in catalog["plugins"] if plugin["kind"] == "community"]
    with tempfile.TemporaryDirectory() as directory:
        for plugin in packages:
            try:
                check(plugin, Path(directory))
            except (OSError, ValueError, BadZipFile, subprocess.SubprocessError) as error:
                raise SystemExit(f'{plugin["id"]}: {error}') from error
    print(f"Checked {len(packages)} installable ZIP packages")


if __name__ == "__main__":
    main()
