#!/usr/bin/env bash
cd "$(dirname "$0")/.."; . .venv/bin/activate
while ! grep -q "matrix3 done" data/cache/matrix3.log; do sleep 20; done
run() { while [ "$(free -g | awk '/Mem:/{print $7}')" -lt 7 ]; do sleep 30; done
  echo "### $1 $2 $3 $(date +%H:%M:%S)"; python scripts/run_eval.py --cand "$1" --mode "$2" --kinds "$3" --provider gpu 2>&1 | tail -2 | cut -c1-200; }
c=kestrel_ens_c448
run $c nvr neg,comp,real; run $c oracle comp,real; run $c oracle reg; run $c full reg; run $c nvr_nofloor neg,comp,real
echo "### matrix4 done $(date +%H:%M:%S)"
