#!/usr/bin/env bash
# Runs a list of candidates over a list of modes on the P40 (sequential, resumable). usage: run_matrix.sh "cand1 cand2" "mode1 mode2"
set -u
cd "$(dirname "$0")/.."
. .venv/bin/activate
for cand in $1; do
  for mode in $2; do
    echo "### $cand $mode $(date +%H:%M:%S)"
    python scripts/run_eval.py --cand "$cand" --mode "$mode" --provider gpu 2>&1 | tail -3
  done
done
echo "### matrix done $(date +%H:%M:%S)"
