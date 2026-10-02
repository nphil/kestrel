#!/usr/bin/env bash
# waits for the first matrix, then adds the 103/88 empty scenes (gating for all variants + detections for the shortlist)
cd "$(dirname "$0")/.."; . .venv/bin/activate
while pgrep -f "scripts/run_matrix.sh" > /dev/null; do sleep 15; done
for v in stock noband nofloor; do nice -n 15 prlimit --as=4294967296 python scripts/run_gating.py --kinds neg --workers 2 --variant $v 2>&1 | tail -1; done
./scripts/run_matrix.sh "scrypted_yolov9c_relu_test mdv6_yolov9c_640 mdv6_yolov9c_448 mdv6_yolov9c_320 mdv1000_cedar_640 mdv1000_cedar_448 mdv1000_cedar_320" "nvr"
./scripts/run_matrix.sh "scrypted_yolov9c_relu_test mdv6_yolov9c_448 mdv1000_cedar_448" "nvr_nofloor"
echo "### matrix2 done $(date +%H:%M:%S)"
