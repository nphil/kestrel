#!/usr/bin/env bash
# Full evaluation on the final data set, resource-capped (see Main's rules): gating for all pairs (3 variants), then candidates on the P40 in the de-detector container.
cd "$(dirname "$0")/.."; . .venv/bin/activate
for v in stock noband nofloor; do nice -n 15 prlimit --as=4294967296 python scripts/run_gating.py --kinds neg,comp,real --workers 2 --variant $v 2>&1 | tail -1; done
run() { while [ "$(free -g | awk '/Mem:/{print $7}')" -lt 7 ]; do sleep 30; done
  echo "### $1 $2 $3 $(date +%H:%M:%S)"; python scripts/run_eval.py --cand "$1" --mode "$2" --kinds "$3" --provider gpu 2>&1 | tail -2 | cut -c1-200; }
ALL="scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv6_yolov9c_448 mdv6_yolov9c_320 mdv1000_cedar_640 mdv1000_cedar_448 mdv1000_cedar_320 kestrel_ens_c448"
for c in $ALL; do run $c nvr neg,comp,real; done
for c in $ALL; do run $c oracle comp,real; done
for c in scrypted_yolov9c_relu_test mdv1000_cedar_448 kestrel_ens_c448 mdv6_yolov9c_448; do run $c nvr_nofloor neg,comp,real; done
for c in scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv1000_cedar_448 kestrel_ens_c448; do run $c oracle reg; run $c full reg; done
echo "### final pipeline done $(date +%H:%M:%S)"
