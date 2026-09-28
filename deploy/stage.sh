#!/usr/bin/env bash
# Copies a built model into Scrypted's data volume, where the ONNX plugin can read
# it through a file:// URL (Scrypted's volume is mounted at /server/volume).
#   deploy/stage.sh dist/wildlife-atlanta [ssh-host] [host-volume-path]
set -euo pipefail
src=${1:?usage: stage.sh <dist/model-dir> [ssh-host] [scrypted-volume-on-host]}
host=${2:-unraid}
volume=${3:-/mnt/nvme/appdata/scrypted}
name=$(basename "$src")
ssh "$host" "mkdir -p '$volume/models/$name'"
for f in config.json model.onnx; do
  ssh "$host" "cat > '$volume/models/$name/$f.tmp' && mv '$volume/models/$name/$f.tmp' '$volume/models/$name/$f'" < "$src/$f"
done
echo "staged: file:///server/volume/models/$name/config.json"
