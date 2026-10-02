#!/usr/bin/env bash
# Puts the stock detector back: selects "Default" in the ONNX plugin (and, with --unpatch, restores the plugin source).
set -euo pipefail
cd "$(dirname "$0")/.."
. /data/home/Kestrel/.scrypted-cred; export SCRYPTED_USER SCRYPTED_PASS
node deploy/scrypted_set.mjs 152 model Default "ROLLBACK to stock detector"
if [ "${1:-}" = "--unpatch" ]; then
  ssh "${SSH_HOST:-unraid}" "f=/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/zip/unzipped/ort/__init__.py; [ -f \$f.orig ] && cp \$f.orig \$f && echo restored \$f"
fi
