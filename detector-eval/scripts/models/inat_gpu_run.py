#!/usr/bin/env python3
"""scripts/inat_gpu.py for the throwaway GPU container (never the production scrypted container).

usage: inat_gpu_run.py <model> [squash|letterbox] [gpu_mem_mb]
Needs the container from `gpu_container.sh up`. Stages (once) the 390x3 iNat test photos, lib/evallib and
scripts/gpu_batch_detect.py plus models/<model> into /tmp/de of GPU_CONTAINER (default de-models-gpu), runs the detector on the
P40 (ORT gpu_mem_limit <= gpu_mem_mb, default 1024) over all 1170 images, stores the detections in
data/cache/inat/<model>__<mode>.gpu.jsonl, prints the timing line and the summary (see inat_summary.py), and removes the staged
model again.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import inat_summary  # noqa: E402

C = os.environ.get("GPU_CONTAINER", "de-models-gpu")
assert C not in ("scrypted", "homeassistant", "llama-swap"), "never run experiments in a production container"
name = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "squash"
mem = sys.argv[3] if len(sys.argv) > 3 else "1024"
base = Path("/data/home/Kestrel/classifier/data/testset")
man = json.loads((base / "manifest.json").read_text())
rd = f"/tmp/de/run_{name}_{mode}"


def sh(cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, shell=True, **kw)


def dexec(cmd: str) -> str:
    return f"ssh unraid \"docker exec -i {C} bash -c '{cmd}'\""


if sh(f"ssh unraid 'docker exec {C} test -d /tmp/de/testset'").returncode != 0:      # photos: staged once per container
    sh(f"tar cf - -C /data/home/Kestrel/classifier/data testset | " + dexec("mkdir -p /tmp/de && tar xf - -C /tmp/de"), check=True)
sh(f"tar cf - -C {ROOT} lib/evallib scripts/gpu_batch_detect.py models/{name} | " + dexec("mkdir -p /tmp/de && tar xf - -C /tmp/de"), check=True)

jobs = []
for v in ("clean", "camera", "night"):
    for m in man:
        if (base / v / m["file"]).exists():
            jobs.append({"key": f'{v}/{m["file"]}|f', "image": f'/tmp/de/testset/{v}/{m["file"]}', "crop": None, "mode": mode})
jp = ROOT / f"data/cache/jobs/inat_{name}_{mode}_mine.jsonl"
jp.parent.mkdir(parents=True, exist_ok=True)
jp.write_text("\n".join(json.dumps(j) for j in jobs) + "\n")
sh(f"cat {jp} | " + dexec(f"mkdir -p {rd} && cat > {rd}/jobs.jsonl"), check=True)

r = subprocess.run(["ssh", "unraid", f"docker exec -e GPU_MEM_MB={mem} -e THREADS=2 {C} /usr/bin/python3.12 /tmp/de/scripts/gpu_batch_detect.py "
                    f"/tmp/de/models/{name} {rd}/jobs.jsonl {rd}/out.jsonl"], capture_output=True, text=True)
print("timing:", r.stdout.strip(), "|", "\n".join(l for l in r.stderr.splitlines() if "pthread_setaffinity" not in l)[-400:])
out = ROOT / f"data/cache/inat/{name}__{mode}.gpu.jsonl"
out.parent.mkdir(parents=True, exist_ok=True)
tmp = out.with_suffix(".tmp")
with open(tmp, "wb") as f:
    subprocess.run(["ssh", "unraid", f"docker exec {C} cat {rd}/out.jsonl"], stdout=f, check=True)
os.replace(tmp, out)
sh(f"ssh unraid 'docker exec {C} rm -rf {rd} /tmp/de/models/{name}'")
res = inat_summary.summarize(name, mode)
print(json.dumps(res))
