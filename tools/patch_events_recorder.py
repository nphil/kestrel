"""Repair the published @apocaliss92/scrypted-events-recorder 0.0.52 bundle and redeploy it to Scrypted.

Why: 0.0.52 (npm, 2026-10-05) was bundled so that webpack treated @scrypted/sdk's CommonJS index as an ES module.
Its `exports.sdk` / `exports.default` lines then point at nothing, the plugin throws while loading, Scrypted reports
device 223 ("Events recorder") as unavailable, and no camera clip is saved — Kestrel visits end with "no clip".
0.0.52 also stores a live snapshot for EVERY ObjectDetector update that lacks a detectionId (meant for cameras with
on-board detection), which wrote thousands of JPEGs per hour here.

This script downloads the published tarball, makes two local fixes, and deploys the result under the same plugin id:
  1. in every SDK index module webpack mis-compiled, bind `exports` to `__webpack_exports__`;
  2. take the fallback snapshot only for on-board camera detections (detections present, none with a bounding box).

Usage (needs ~/.scrypted/login.json for the host, and Kestrel's scrypted-plugin node_modules):
  python3 tools/patch_events_recorder.py [version=0.0.52] [host=192.168.1.69:10443]
Drop this once upstream publishes a release that loads (check: `node -e "require('./main.nodejs.js')"` in its plugin.zip).
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

PACKAGE = "@apocaliss92/scrypted-events-recorder"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEPLOY = os.path.join(REPO, "scrypted-plugin", "node_modules", ".bin", "scrypted-deploy")
MARK = "R(__webpack_exports__);"
REGISTER = "__webpack_require__.r(__webpack_exports__);"
FIX_EXPORTS = REGISTER + "\nvar exports = __webpack_exports__; /* local fix: webpack compiled this CJS file as ESM */"
SNAPSHOT_OLD = "if (!mo) {"
SNAPSHOT_NEW = ("if (!mo && !data.detectionId && data.detections?.length && data.detections.every(d => !d.boundingBox)) "
                "{ /* local fix: only on-board camera detections, not every empty update */")


def fix_exports(source: str) -> tuple[str, int]:
    modules = list(re.finditer(r'^/\*\*\*/ "([^"]+)"\n', source, re.M))
    parts, last, fixed = [], 0, 0
    for index, module in enumerate(modules):
        end = modules[index + 1].start() if index + 1 < len(modules) else len(source)
        body = source[module.end():end]
        if REGISTER in body and re.search(r"(?<![\w.])exports\.", body) and "var exports = __webpack_exports__" not in body:
            body = body.replace(REGISTER, FIX_EXPORTS, 1)
            fixed += 1
        parts += [source[last:module.end()], body]
        last = end
    parts.append(source[last:])
    return "".join(parts), fixed


def fix_snapshot(source: str) -> str:
    call = source.index("mo = await this.cameraDevice.takePicture();")
    start = source.rindex(SNAPSHOT_OLD, 0, call)
    if call - start > 600:
        raise SystemExit("snapshot fallback not where expected; inspect the bundle before patching")
    return source[:start] + SNAPSHOT_NEW + source[start + len(SNAPSHOT_OLD):]


def main() -> None:
    version = sys.argv[1] if len(sys.argv) > 1 else "0.0.52"
    host = sys.argv[2] if len(sys.argv) > 2 else "192.168.1.69:10443"
    meta = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/{PACKAGE}/{version}", timeout=30))
    tarball = urllib.request.urlopen(meta["dist"]["tarball"], timeout=60).read()
    work = tempfile.mkdtemp(prefix="events-recorder-")
    try:
        with tarfile.open(fileobj=io.BytesIO(tarball)) as archive:
            archive.extractall(work)  # npm's own tarball, extracted into a private temp dir
        package = os.path.join(work, "package")
        plugin_zip = os.path.join(package, "dist", "plugin.zip")
        with zipfile.ZipFile(plugin_zip) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        source, fixed = fix_exports(files["main.nodejs.js"].decode())
        source = fix_snapshot(source)
        files["main.nodejs.js"] = source.encode()
        with zipfile.ZipFile(plugin_zip, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        unpacked = os.path.join(work, "check")
        os.makedirs(unpacked)
        with open(os.path.join(unpacked, "main.nodejs.js"), "w") as handle:
            handle.write(source)
        subprocess.run(["node", "-e", "require('./main.nodejs.js')"], cwd=unpacked, check=True, capture_output=True)
        print(f"patched {fixed} SDK module(s) and the snapshot fallback; bundle loads")
        env = {**os.environ, "NODE_TLS_REJECT_UNAUTHORIZED": "0"}
        subprocess.run([DEPLOY, host], cwd=package, check=True, env=env)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
