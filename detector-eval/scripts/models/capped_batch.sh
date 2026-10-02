#!/usr/bin/env bash
# Run `python <script> <model>` once per model, each in its own capped process (capped.sh: 4 GB address space, cores
# 0-4,8-12, nice 15, needs >= 10 GB RAM available). A crash (e.g. memory cap) is logged and the batch continues.
#   usage: capped_batch.sh <python-script> <flags-or-empty> model [model ...]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT=$1; FLAGS=$2; shift 2
for m in "$@"; do
  # wait (max 20 min) for >= 10 GB available
  for i in $(seq 1 40); do
    AVAIL=$(free -g | awk '/^Mem:/ {print $7}')
    [ "$AVAIL" -ge 10 ] && break
    echo "  waiting for RAM ($AVAIL GB available)"; sleep 30
  done
  OMP_NUM_THREADS=${OMP_NUM_THREADS:-6} "$HERE/capped.sh" "$ROOT/.venv/bin/python" "$SCRIPT" $FLAGS "$m" 2>&1 | grep -v -i "warn"
  rc=${PIPESTATUS[0]}
  [ "$rc" -ne 0 ] && echo "$m: exit code $rc (killed by the 4 GB cap or failed)"
done
