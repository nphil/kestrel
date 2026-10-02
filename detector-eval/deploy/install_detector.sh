#!/usr/bin/env bash
# Installs a local detector model into Scrypted's ONNX plugin (reversible, see rollback_detector.sh).
#   deploy/install_detector.sh <models/<name> directory name>   e.g. kestrel_ens_c448
# 1. patches the plugin so it accepts models from <plugin volume>/files/local-models/ (idempotent, keeps ort/__init__.py.orig)
# 2. copies <name>/model.onnx there   3. selects it in the ONNX plugin settings (the plugin restarts itself, ~1 min)
set -euo pipefail
cd "$(dirname "$0")/.."
name=${1:?model dir name}
host=${SSH_HOST:-unraid}
plugin=/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx
. /data/home/Kestrel/.scrypted-cred; export SCRYPTED_USER SCRYPTED_PASS
# patch locally (the Unraid host has no python) and write back atomically; the patch keeps ort/__init__.py.orig next to it
tmp=$(mktemp -d); f=$plugin/zip/unzipped/ort/__init__.py
ssh "$host" "cat $f" > "$tmp/__init__.py"; ssh "$host" "test -f $f.orig" || ssh "$host" "cp $f $f.orig"
python3 deploy/patch_onnx_local_models.py "$tmp/__init__.py"
ssh "$host" "cat > $f.new && mv $f.new $f" < "$tmp/__init__.py"; rm -rf "$tmp"
ssh "$host" "mkdir -p $plugin/files/local-models/$name"
cat "models/$name/model.onnx" | ssh "$host" "cat > $plugin/files/local-models/$name/model.onnx.tmp && mv $plugin/files/local-models/$name/model.onnx.tmp $plugin/files/local-models/$name/model.onnx"
node deploy/scrypted_set.mjs 152 model "$name" "ONNX plugin detector model (revert: set back to Default)"
echo "selected $name; plugin is restarting"
