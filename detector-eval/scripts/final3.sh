#!/usr/bin/env bash
# Reduced final run under Main's rules: every heavy step takes the shared lock (heavy.sh locally, flock inside run_eval for docker).
cd "$(dirname "$0")/.."; . .venv/bin/activate
echo "### gating stock $(date +%H:%M:%S) load: $(ssh unraid cat /proc/loadavg)"
./scripts/heavy.sh prlimit --as=4294967296 python scripts/run_gating.py --kinds neg,comp,real --workers 1 --variant stock 2>&1 | tail -1
run() { while [ "$(free -g | awk '/Mem:/{print $7}')" -lt 7 ]; do sleep 30; done
  echo "### $1 $2 $3 $(date +%H:%M:%S) load: $(ssh unraid cat /proc/loadavg | cut -d' ' -f1-3)"; python scripts/run_eval.py --cand "$1" --mode "$2" --kinds "$3" --provider docker 2>&1 | tail -2 | cut -c1-220; }
for c in scrypted_yolov9c_relu_test kestrel_ens_c448 mdv1000_cedar_448 mdv6_yolov9c_448; do run $c nvr neg,comp,real; done
for c in scrypted_yolov9c_relu_test kestrel_ens_c448 mdv1000_cedar_448; do run $c oracle reg; run $c full reg; done
echo "### gating noband+nofloor (comp,real,neg) $(date +%H:%M:%S)"
for v in noband nofloor; do ./scripts/heavy.sh prlimit --as=4294967296 python scripts/run_gating.py --kinds neg,comp,real --workers 1 --variant $v 2>&1 | tail -1; done
for c in scrypted_yolov9c_relu_test kestrel_ens_c448; do run $c nvr_nofloor comp,real; done
echo "### final3 done $(date +%H:%M:%S)"
