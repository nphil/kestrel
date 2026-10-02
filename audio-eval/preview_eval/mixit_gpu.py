"""Run a bird_mixit checkpoint over a directory of 22.05 kHz float32 .npy clips on the GPU with a hard VRAM cap.

Runs inside tensorflow/tensorflow:2.12.0-gpu. Writes <name>__s<i>.npy per source plus timing_<N>src.json
(per-clip wall time, allocator peak, nvidia-smi peak delta, cold-start load time).
"""
import argparse, glob, json, os, subprocess, threading, time
import numpy as np
import tensorflow as tf

ap = argparse.ArgumentParser()
ap.add_argument("--ckpt-dir", required=True)
ap.add_argument("--prefix", required=True)
ap.add_argument("--num-sources", type=int, required=True)
ap.add_argument("--inp", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--mem-mb", type=int, default=1536)
ap.add_argument("--tag", default="")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)


def smi_used():
    try:
        r = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], timeout=5)
        return int(r.decode().split()[0])
    except Exception:
        return -1


gpus = tf.config.list_physical_devices("GPU")
print("physical GPUs:", gpus, flush=True)
# NOTE: tf.config.set_logical_device_configuration does NOT apply to explicit compat.v1 Sessions (verified: the first run
# grabbed ~9.7 GB). The cap must go through the session's ConfigProto.gpu_options instead.
total_mb = int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"]).decode().split()[0])

tf1 = tf.compat.v1
tf1.disable_v2_behavior()

baseline = smi_used()
samples = []
stop = threading.Event()


def poll():
    while not stop.is_set():
        samples.append((time.time(), smi_used()))
        time.sleep(0.1)


th = threading.Thread(target=poll, daemon=True)
th.start()

t0 = time.perf_counter()
g = tf1.Graph()
with g.as_default():
    saver = tf1.train.import_meta_graph(os.path.join(args.ckpt_dir, "inference.meta"))
cfg = tf1.ConfigProto(allow_soft_placement=True)
cfg.gpu_options.per_process_gpu_memory_fraction = args.mem_mb / total_mb
cfg.gpu_options.allow_growth = True
sess = tf1.Session(graph=g, config=cfg)
with g.as_default():
    saver.restore(sess, os.path.join(args.ckpt_dir, args.prefix))
inp = g.get_tensor_by_name("input_audio/receiver_audio:0")
out = g.get_tensor_by_name("denoised_waveforms:0")
load_s = time.perf_counter() - t0
print(f"graph+checkpoint load {load_s:.2f}s", flush=True)

# prove the ops run on the GPU: count device placements of the heavy ops in the graph
dev_counts = {}
for op in g.get_operations():
    d = op.device or "(auto)"
    dev_counts[d] = dev_counts.get(d, 0) + 1

results = []
files = sorted(glob.glob(os.path.join(args.inp, "*.npy")))
for i, f in enumerate(files):
    name = os.path.splitext(os.path.basename(f))[0]
    x = np.load(f).astype(np.float32)
    s0 = time.perf_counter()
    y = sess.run(out, feed_dict={inp: x[None, None, :]})[0]
    wall = time.perf_counter() - s0
    assert y.shape[0] == args.num_sources, y.shape
    for k in range(args.num_sources):
        np.save(os.path.join(args.out, f"{name}__s{k}.npy"), y[k].astype(np.float32))
    try:
        mi = tf.config.experimental.get_memory_info("GPU:0")
        cur, peak = mi["current"], mi["peak"]
    except Exception as e:  # noqa
        cur = peak = -1
    results.append({"name": name, "wall_s": wall, "alloc_current_mb": cur / 2**20, "alloc_peak_mb": peak / 2**20})
    print(f"[{i+1}/{len(files)}] {name} {wall:.3f}s alloc_peak={peak/2**20:.0f}MB", flush=True)

stop.set()
th.join(timeout=2)
used = [u for _, u in samples if u >= 0]
steady = sorted(r["wall_s"] for r in results[1:]) or [results[0]["wall_s"]]
summary = {
    "tag": args.tag,
    "num_sources": args.num_sources,
    "tf_version": tf.__version__,
    "gpu_visible": [d.name for d in gpus],
    "mem_cap_mb": args.mem_mb,
    "clips": len(results),
    "load_s": load_s,
    "first_clip_wall_s": results[0]["wall_s"],
    "steady_wall_median_s": steady[len(steady) // 2],
    "steady_wall_min_s": steady[0],
    "steady_wall_max_s": steady[-1],
    "alloc_peak_mb_max": max(r["alloc_peak_mb"] for r in results),
    "smi_baseline_mb": baseline,
    "smi_peak_mb": max(used) if used else None,
    "smi_peak_delta_mb": (max(used) - baseline) if used and baseline >= 0 else None,
    "smi_samples": len(used),
    "smi_min_mb": min(used) if used else None,
    "op_device_counts": dev_counts,
    "per_clip": results,
}
json.dump(summary, open(os.path.join(args.out, f"timing_{args.num_sources}src.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in summary.items() if k not in ("per_clip", "op_device_counts")}, indent=1), flush=True)
