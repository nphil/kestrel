#!/usr/bin/env bash
# Own throwaway GPU container for model timing / iNat tests. NEVER run experiments in the production `scrypted` container.
#   gpu_container.sh up      start (only if the host has >= 10 GB RAM available and the GPU has < 17000 MiB in use)
#   gpu_container.sh down    stop + remove (--rm) the container and everything inside it
#   gpu_container.sh status
# The container uses the same image as scrypted (CUDA 12.6 + cuDNN 9) and mounts the onnx plugin's python site-packages
# read-only (onnxruntime-gpu 1.22, numpy, PIL, cv2): run with `docker exec de-models-gpu /usr/bin/python3.12 ...`.
# Caps (Main's rules): 4 GB RAM (no swap), 4 CPUs on cores 0-4,8-12 (Scrypted owns 5,6,7,13,14,15). VRAM caps are enforced by
# the test scripts (ORT gpu_mem_limit 1 GiB). --entrypoint sleep: the image's /init must NOT start a second Scrypted.
# The container removes itself after 4 h (sleep 14400, --rm) even if nobody calls `down`.
set -euo pipefail
NAME=${GPU_CONTAINER:-de-models-gpu}
HOST=${GPU_HOST:-unraid}
PYLIB=/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/python3.12-Linux-x86_64-20240317
case "${1:-status}" in
  up)
    if ssh "$HOST" "docker ps --format '{{.Names}}' | grep -qx $NAME"; then echo "$NAME already running"; exit 0; fi
    AVAIL=$(ssh "$HOST" "free -g | awk '/^Mem:/ {print \$7}'")
    GPU=$(ssh "$HOST" "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits")
    echo "host RAM available: ${AVAIL} GB, GPU used: ${GPU} MiB"
    [ "$AVAIL" -ge 10 ] || { echo "not starting: < 10 GB RAM available"; exit 3; }
    [ "$GPU" -lt 17000 ] || { echo "not starting: GPU has >= 17000 MiB in use"; exit 4; }
    IMAGE=$(ssh "$HOST" "docker inspect scrypted --format '{{.Config.Image}}'")
    ssh "$HOST" "docker run -d --rm --name $NAME --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=all \
      --memory=4g --memory-swap=4g --cpus=4 --cpuset-cpus=0-4,8-12 --entrypoint /bin/sleep \
      -v $PYLIB:/opt/pylib:ro -e PYTHONPATH=/opt/pylib $IMAGE 14400"
    ssh "$HOST" "docker exec $NAME /usr/bin/python3.12 -c 'import onnxruntime as o; print(o.__version__, o.get_available_providers())'"
    ;;
  down)   ssh "$HOST" "docker rm -f $NAME" || true;;
  status) ssh "$HOST" "docker ps --filter name=$NAME --format '{{.Names}} {{.Status}}'; free -g | head -2; nvidia-smi --query-gpu=memory.used --format=csv,noheader";;
  *) echo "usage: $0 up|down|status"; exit 1;;
esac
