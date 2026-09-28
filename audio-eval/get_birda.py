#!/usr/bin/env python3
"""Download the pinned official Birda CLI release into ignored audio-eval/data/."""
from __future__ import annotations

import hashlib
import json
import pathlib
import tarfile
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
VERSION = "v1.8.1"
API = f"https://api.github.com/repos/tphakala/birda/releases/tags/{VERSION}"
USER_AGENT = "KestrelAudioEval/1.0"


def request(url: str, accept: str = "application/octet-stream"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    return urllib.request.urlopen(req, timeout=90)


def main() -> int:
    DATA.mkdir(parents=True, exist_ok=True)
    tools_dir = DATA / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)
    with request(API, "application/vnd.github+json") as response:
        release = json.load(response)
    # The plain "-bin-" release requires an externally supplied ONNX Runtime
    # via ORT_DYLIB_PATH ("load-dynamic" mode). On this host that path hangs
    # indefinitely inside ONNX Runtime's own init (confirmed: birda's Rust
    # `ort` bindings never return from provider enumeration alone, 0% CPU,
    # futex_do_wait, reproduced bare-metal and in-container, independent of
    # model/CPU-affinity/ORT-version; Python's onnxruntime package works fine
    # in the same environment, so it's specific to birda's dynamic-load path;
    # see github.com/tphakala/birda issues #184/#185/#406). The "-embed-"
    # build bundles its own matched libonnxruntime.so next to the binary and
    # sidesteps that code path entirely; confirmed working.
    asset_name = f"birda-linux-x64-embed-{VERSION}.tar.gz"
    asset = next((item for item in release.get("assets", []) if item.get("name") == asset_name), None)
    if not asset:
        raise SystemExit(f"Pinned Birda asset not found in release {VERSION}.")
    archive_path = tools_dir / asset_name
    with request(asset["browser_download_url"]) as response, archive_path.open("wb") as output:
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            output.write(block)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    expected = asset.get("digest")
    if expected and expected.lower() != f"sha256:{digest}":
        archive_path.unlink(missing_ok=True)
        raise SystemExit("Birda archive checksum does not match GitHub's release metadata.")

    install_dir = tools_dir / f"birda-{VERSION}"
    if install_dir.exists():
        import shutil
        shutil.rmtree(install_dir)
    install_dir.mkdir()
    base = install_dir.resolve()
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            target = (install_dir / member.name).resolve()
            if target != base and base not in target.parents:
                raise SystemExit("Birda archive contains an unsafe path.")
            if member.issym() or member.islnk():
                raise SystemExit("Birda archive contains an unexpected link.")
        archive.extractall(install_dir, members=members)
    binary = next((p for p in install_dir.rglob("birda") if p.is_file()), None)
    if binary is None:
        raise SystemExit("Birda archive did not contain its CLI binary.")
    binary.chmod(0o755)
    metadata = {"version": VERSION, "asset": asset_name, "sha256": digest, "binary": str(binary.relative_to(DATA))}
    (tools_dir / "birda.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Installed Birda {VERSION} ({digest[:12]}) under audio-eval/data/tools/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
