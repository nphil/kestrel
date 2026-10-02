#!/usr/bin/env bash
cd "$(dirname "$0")/.."; . .venv/bin/activate
run() { # cand mode kinds
  while [ "$(free -g | awk '/Mem:/{print $7}')" -lt 7 ]; do sleep 30; done
  echo "### $1 $2 $3 $(date +%H:%M:%S)"; python scripts/run_eval.py --cand "$1" --mode "$2" --kinds "$3" --provider gpu 2>&1 | tail -2 | cut -c1-200
}
for c in scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv6_yolov9c_448 mdv6_yolov9c_320 mdv1000_cedar_640 mdv1000_cedar_448 mdv1000_cedar_320; do run $c nvr neg,comp,real; done
for c in scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv6_yolov9c_448 mdv1000_cedar_448 mdv6_yolov9c_320 mdv1000_cedar_640 mdv1000_cedar_320; do run $c oracle comp,real; done
for c in scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv6_yolov9c_448 mdv1000_cedar_448 mdv1000_cedar_640; do run $c oracle reg; run $c full reg; done
echo "### matrix3 done $(date +%H:%M:%S)"
