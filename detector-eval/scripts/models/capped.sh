#!/usr/bin/env bash
# Run a local (Cody container) job inside Main's resource rules: 4 GB address space, cores 0-4,8-12 only (Scrypted owns
# 5,6,7,13,14,15), low priority. Refuses to start when the host has < 10 GB RAM available.  usage: capped.sh cmd args...
set -euo pipefail
AVAIL=$(free -g | awk '/^Mem:/ {print $7}')
if [ "$AVAIL" -lt "${MIN_RAM_GB:-10}" ]; then echo "capped.sh: only ${AVAIL} GB RAM available (< ${MIN_RAM_GB:-10}); not starting" >&2; exit 3; fi
exec prlimit --as=4294967296 taskset -c 0-4,8-12 nice -n 15 "$@"
