#!/usr/bin/env bash
# Runs a LOCAL heavy command while holding the shared host lock (Main's rule: one heavy job at a time across agents):
#   scripts/heavy.sh <command...>
set -u
d=$(mktemp -d); mkfifo "$d/in"
ssh unraid "flock /tmp/agents-heavy.lock sh -c 'echo LOCKED; cat >/dev/null'" < "$d/in" > "$d/out" 2>/dev/null &
sshpid=$!
exec 9> "$d/in"
until grep -q LOCKED "$d/out" 2>/dev/null; do sleep 3; kill -0 $sshpid 2>/dev/null || break; done
nice -n 19 "$@"; rc=$?
exec 9>&-; wait $sshpid 2>/dev/null; rm -rf "$d"
exit $rc
