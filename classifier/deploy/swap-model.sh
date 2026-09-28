#!/usr/bin/env bash
# Replaces the model file behind an installed Scrypted custom classifier (same labels,
# new weights) and reloads the ONNX plugin so it picks it up. The previous file is kept
# as model.onnx.prev; roll back with:  swap-model.sh --rollback <device-id>
#
#   deploy/swap-model.sh <new model.onnx> <scrypted device id, e.g. 248>
set -euo pipefail
host=${SSH_HOST:-unraid}
files=${ONNX_FILES:-/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/files}
cd "$(dirname "$0")"

if [ "${1:-}" = "--rollback" ]; then
  dev=${2:?device id}
  ssh "$host" "cd '$files/$dev' && test -f model.onnx.prev && mv model.onnx model.onnx.rejected && mv model.onnx.prev model.onnx"
else
  src=${1:?usage: swap-model.sh <model.onnx> <device-id> | --rollback <device-id>}
  dev=${2:?device id}
  ssh "$host" "cat > '$files/$dev/model.onnx.new'" < "$src"
  ssh "$host" "cd '$files/$dev' && mv -f model.onnx model.onnx.prev && mv model.onnx.new model.onnx && rm -f model.onnx.rejected"
fi
node reload-plugin.mjs @scrypted/onnx
echo "swapped model for device $dev and reloaded @scrypted/onnx"
