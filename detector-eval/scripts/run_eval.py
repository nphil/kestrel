#!/usr/bin/env python3
"""Runs a detector candidate over the evaluation pairs and caches raw detections (score >= 0.05, frame px).

  python scripts/run_eval.py --cand scrypted_yolov9c_relu_test --mode nvr    --provider cpu
  python scripts/run_eval.py --cand mdv6_yolov9c_640          --mode oracle --provider gpu
modes:
  nvr    crops the NVR would produce (data/cache/gating, run scripts/run_gating.py first), squashed to model input
  oracle crop the NVR would produce if its motion box were exactly the ground-truth box (positives only)
  full   whole frame, letterboxed to model input (what a Kestrel-side / full-frame pass would see)
  tile   native-resolution 640 px tiles (25 % overlap) over the whole frame (side-process second look, costly)
  nvr_noband / nvr_nofloor  NVR crops with the 10 % edge band / the motion size floor removed (see lib/evallib/nvr.py)
Output: data/cache/det/<cand>__<mode>.jsonl   (resumable: finished keys are skipped)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "lib"))
from evallib import dataset, nvr
from evallib import boxes as B

CACHE = os.path.join(ROOT, "data", "cache")


def gating_for(pair, variant="stock"):
    d = "gating" if variant == "stock" else "gating_" + variant
    p = os.path.join(CACHE, d, pair.id.replace("/", "__") + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


def build_jobs(pairs, mode, mode_override=None):
    jobs = []
    for p in pairs:
        if mode.startswith("nvr"):
            g = gating_for(p, mode[4:] or "stock")
            if not g:
                continue
            for i, c in enumerate(g["crops"]):
                jobs.append({"key": f"{p.id}|c{i}", "image": p.test, "crop": [int(v) for v in c], "mode": "squash"})
        elif mode == "oracle":
            if not p.gt:
                continue
            from PIL import Image
            W, H = Image.open(p.test).size
            for gi, g in enumerate(p.gt):
                crops = nvr.select_crops([g["box"]], (W, H))
                for i, c in enumerate(crops):
                    jobs.append({"key": f"{p.id}|o{gi}_{i}", "image": p.test, "crop": [int(v) for v in c], "mode": "squash"})
        elif mode == "full":
            jobs.append({"key": f"{p.id}|f", "image": p.test, "crop": None, "mode": mode_override or "letterbox"})
        elif mode == "tile":
            # native-resolution 640 px tiles with 25 % overlap over the whole frame (what a side-process 'second look' could do)
            from PIL import Image
            W, H = Image.open(p.test).size
            T, S = 640, 480
            xs = list(range(0, max(1, W - T + 1), S)); xs = xs + ([W - T] if xs[-1] + T < W else [])
            ys = list(range(0, max(1, H - T + 1), S)); ys = ys + ([H - T] if ys[-1] + T < H else [])
            for yi, y in enumerate(ys):
                for xi, x in enumerate(xs):
                    jobs.append({"key": f"{p.id}|t{yi}_{xi}", "image": p.test, "crop": [x, y, min(T, W), min(T, H)], "mode": "squash"})
    return jobs


def done_keys(path):
    if not os.path.exists(path):
        return set()
    return {json.loads(l)["key"] for l in open(path) if l.strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cand", required=True)
    ap.add_argument("--mode", required=True, choices=["nvr", "nvr_noband", "nvr_nofloor", "oracle", "full", "tile"])
    ap.add_argument("--provider", default="cpu", choices=["cpu", "gpu", "docker"])
    ap.add_argument("--kinds", default="neg,comp,real")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--gpu-mem-mb", type=int, default=1024)
    ap.add_argument("--full-mode", default=None, help="override letterbox/squash for mode=full")
    a = ap.parse_args()

    os.makedirs(os.path.join(CACHE, "det"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "jobs"), exist_ok=True)
    out_path = os.path.join(CACHE, "det", f"{a.cand}__{a.mode}.jsonl")
    pairs = dataset.load_all(tuple(a.kinds.split(",")))
    jobs = build_jobs(pairs, a.mode, a.full_mode)
    if a.limit:
        jobs = jobs[:a.limit]
    have = done_keys(out_path)
    todo = [j for j in jobs if j["key"] not in have]
    print(f"{a.cand} {a.mode}: {len(jobs)} jobs, {len(have)} cached, {len(todo)} to run", flush=True)
    if not todo:
        return
    model_dir = os.path.join(ROOT, "models", a.cand)
    jobs_path = os.path.join(CACHE, "jobs", f"{a.cand}__{a.mode}.jsonl")
    tmp_out = out_path + ".new"
    t0 = time.time()
    if a.provider == "cpu":
        with open(jobs_path, "w") as f:
            for j in todo:
                f.write(json.dumps(j) + "\n")
        env = dict(os.environ, THREADS=str(a.threads), OMP_NUM_THREADS=str(a.threads))
        r = subprocess.run(["nice", "-n", "10", sys.executable, os.path.join(ROOT, "scripts", "gpu_batch_detect.py"),
                            model_dir, jobs_path, tmp_out, "--cpu"], env=env, capture_output=True, text=True)
        print(r.stdout.strip(), r.stderr.strip()[-500:])
    elif a.provider == "docker":
        # one foreground `docker run --rm` per batch, under the shared host lock, 4 GB / 4 CPU caps, repo mounted read-only
        HOSTROOT = "/mnt/nvme/appdata/cody/home/kestrel/detector-eval"
        os.makedirs(os.path.join(CACHE, "out"), exist_ok=True)
        tag = f"{a.cand}__{a.mode}__{os.getpid()}"
        rj = []
        for j in todo:
            j = dict(j); j["image"] = "/work/" + os.path.relpath(j["image"], ROOT); rj.append(j)
        jp2 = os.path.join(CACHE, "jobs", tag + ".jsonl")
        with open(jp2, "w") as f:
            for j in rj:
                f.write(json.dumps(j) + "\n")
        cmd = (f"flock /tmp/agents-heavy.lock docker run --rm --name de-run-{os.getpid()} --runtime=nvidia --memory=4g --memory-swap=4g "
               f"--cpus=4 --cpuset-cpus=0-4,8-12 -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=compute,utility "
               f"-v {HOSTROOT}:/work:ro -v {HOSTROOT}/data/cache/out:/out "
               f"-v /mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/python3.12-Linux-x86_64-20240317:/opt/pylib:ro "
               f"-e PYTHONPATH=/opt/pylib:/work/lib -e GPU_MEM_MB={a.gpu_mem_mb} --entrypoint /usr/bin/python3.12 ghcr.io/koush/scrypted:nvidia-legacy "
               f"/work/scripts/gpu_batch_detect.py /work/models/{a.cand} /work/data/cache/jobs/{tag}.jsonl /out/{tag}.jsonl")
        r = subprocess.run(["ssh", "unraid", cmd], capture_output=True, text=True)
        print(r.stdout.strip()[-400:], r.stderr.strip().replace("pthread_setaffinity_np", "")[-200:])
        shutil.move(os.path.join(CACHE, "out", tag + ".jsonl"), tmp_out) if os.path.exists(os.path.join(CACHE, "out", tag + ".jsonl")) else None
    else:
        stage = os.path.join(ROOT, "scripts", "gpu_stage.sh")
        # stage code, model, images
        images = sorted({j["image"] for j in todo})
        staged_list = os.path.join(CACHE, "staged_gpu.txt")
        staged = set(open(staged_list).read().split("\n")) if os.path.exists(staged_list) else set()
        rel = [os.path.relpath(i, ROOT) for i in images if os.path.relpath(i, ROOT) not in staged]
        subprocess.run([stage, "put", "lib/evallib", "scripts/gpu_batch_detect.py", os.path.relpath(model_dir, ROOT)], check=True)
        if rel:
            print(f"staging {len(rel)} images", flush=True)
            lst = os.path.join(CACHE, "to_stage.txt")
            open(lst, "w").write("\n".join(rel))
            subprocess.run(f"cd {ROOT} && tar cf - -T {lst} | ssh unraid \"docker exec -i de-detector bash -c 'mkdir -p /tmp/de && tar xf - -C /tmp/de'\"",
                           shell=True, check=True)
            open(staged_list, "a").write("\n" + "\n".join(rel))
        remote_jobs = []
        for j in todo:
            j = dict(j)
            j["image"] = "/tmp/de/" + os.path.relpath(j["image"], ROOT)
            remote_jobs.append(j)
        with open(jobs_path, "w") as f:
            for j in remote_jobs:
                f.write(json.dumps(j) + "\n")
        RUN = f"/tmp/de/run_dh_{a.cand}_{a.mode}_{os.getpid()}"
        subprocess.run(f"cat {jobs_path} | ssh unraid \"docker exec -i de-detector bash -c 'mkdir -p {RUN} && cat > {RUN}/jobs.jsonl'\"", shell=True, check=True)
        env = dict(os.environ, GPU_MEM_MB=str(a.gpu_mem_mb))
        r = subprocess.run([stage, "run", "/tmp/de/scripts/gpu_batch_detect.py", f"/tmp/de/models/{a.cand}", f"{RUN}/jobs.jsonl", f"{RUN}/out.jsonl"],
                           env=env, capture_output=True, text=True)
        print(r.stdout.strip(), r.stderr.strip()[-500:])
        subprocess.run([stage, "get", f"{RUN}/out.jsonl", tmp_out], check=True)
        subprocess.run(f'ssh unraid "docker exec de-detector rm -rf {RUN}"', shell=True)
    if os.path.exists(tmp_out):
        with open(out_path, "a") as f:
            f.write(open(tmp_out).read())
        os.remove(tmp_out)
    print(f"done in {time.time() - t0:.0f}s -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
