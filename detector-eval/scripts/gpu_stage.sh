#!/usr/bin/env bash
# Stage files into the scrypted container's /tmp/de (the only place we write there) and run a command with the
# plugin's Python env. Usage:
#   gpu_stage.sh put <local-dir-or-file>... -- <relative paths under /tmp/de are preserved from detector-eval/>
#   gpu_stage.sh run <python-script-path-in-container> [args...]
#   gpu_stage.sh get <container-path> <local-path>
#   gpu_stage.sh clean
set -euo pipefail
ROOT=/data/home/Kestrel/detector-eval
HOST=${GPU_HOST:-unraid}
C=${GPU_CONTAINER:-de-detector}
case "${1:-}" in
  put)   shift; cd "$ROOT"; tar cf - "$@" | ssh "$HOST" "docker exec -i $C bash -c 'mkdir -p /tmp/de && tar xf - -C /tmp/de'";;
  run)   shift; ssh "$HOST" "docker exec -e PYTHONPATH=/opt/pylib -e GPU_MEM_MB=${GPU_MEM_MB:-1024} $C /usr/bin/python3.12 $*" 2> >(grep -v pthread_setaffinity >&2);;
  get)   ssh "$HOST" "docker exec $C cat $2" > "$3";;
  clean) ssh "$HOST" "docker exec $C rm -rf /tmp/de";;
  *) echo "usage: $0 put|run|get|clean ..."; exit 1;;
esac
