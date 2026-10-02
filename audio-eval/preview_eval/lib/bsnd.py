"""Shared helpers for the bird-sound clarity bake-off (scratch code, lives in /tmp/bsnd only)."""
from __future__ import annotations

import io
import json
import pathlib
import subprocess
import tarfile
import tempfile

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import resample_poly

ROOT = pathlib.Path("/tmp/bsnd")
WORK = ROOT / "work"
SR = 22050
CLIP_SECONDS = 15
N = SR * CLIP_SECONDS
TARGET_LUFS = -18.0
TP_LIMIT_DB = -1.5

SCI = {
    "Eastern Chipmunk": "Tamias striatus",
    "Fish Crow": "Corvus ossifragus",
    "Blue Jay": "Cyanocitta cristata",
    "Tufted Titmouse": "Baeolophus bicolor",
    "Eastern Towhee": "Pipilo erythrophthalmus",
    "Carolina Wren": "Thryothorus ludovicianus",
    "Gray Catbird": "Dumetella carolinensis",
    "Red-bellied Woodpecker": "Melanerpes carolinus",
    "Great Horned Owl": "Bubo virginianus",
    "Barred Owl": "Strix varia",
    "Coyote": "Canis latrans",
    "Spring Peeper": "Pseudacris crucifer",
    "Eastern Screech-Owl": "Megascops asio",
    "Eastern Gray Squirrel": "Sciurus carolinensis",
    "American Bullfrog": "Lithobates catesbeianus",
    "American Robin": "Turdus migratorius",
    "Red-shouldered Hawk": "Buteo lineatus",
}


def picked() -> list[dict]:
    return json.loads((ROOT / "picked.json").read_text())


def load_raw(name: str) -> np.ndarray:
    """Raw (unscaled) 15 s clip at 22.05 kHz mono float32, decoded from the real opus."""
    cache = WORK / "raw22k" / f"{name}.npy"
    if cache.exists():
        return np.load(cache)
    cache.parent.mkdir(parents=True, exist_ok=True)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(ROOT / f"{name}.opus"), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).copy()
    x = np.pad(x, (0, max(0, N - len(x))))[:N]
    np.save(cache, x)
    return x


# ----------------------------------------------------------------------------- loudness

_METER = pyln.Meter(SR)  # BS.1770-4 K-weighting + gating, filters designed for SR


def lufs(x: np.ndarray) -> float:
    try:
        v = _METER.integrated_loudness(x.astype(np.float64))
    except Exception:
        return float("-inf")
    return float(v)


def true_peak_db(x: np.ndarray) -> float:
    up = resample_poly(x.astype(np.float64), 4, 1)
    p = float(np.max(np.abs(up))) if up.size else 0.0
    return 20 * np.log10(p + 1e-12)


def limit_true_peak(x: np.ndarray, limit_db: float = TP_LIMIT_DB, lookahead_ms: float = 3.0, release_ms: float = 50.0):
    """Lookahead limiter on a 4x-oversampled peak envelope (true-peak safe). Returns (y, max_gain_reduction_db)."""
    lim = 10 ** (limit_db / 20)
    x = x.astype(np.float64)
    up = resample_poly(x, 4, 1)
    env_up = np.abs(up)
    # per-sample peak over the 4 oversampled points
    m = (len(x) * 4) // 4 * 4
    env = env_up[: len(x) * 4].reshape(-1, 4).max(axis=1)
    need = np.minimum(1.0, lim / np.maximum(env, 1e-12))
    if np.all(need >= 1.0):
        return x.astype(np.float32), 0.0
    L = max(2, int(lookahead_ms * 1e-3 * SR))
    # sliding minimum over lookahead window, centred so the gain is already down when the peak arrives
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    g = minimum_filter1d(need, size=2 * L + 1, mode="nearest")
    g = uniform_filter1d(g, size=2 * L + 1, mode="nearest")   # smoothing keeps g <= need at peaks
    # release: g may rise only slowly
    a = np.exp(-1.0 / (release_ms * 1e-3 * SR))
    r = np.empty_like(g)
    cur = 1.0
    for i in range(len(g)):
        gi = g[i]
        cur = gi if gi < cur else a * cur + (1 - a) * gi
        r[i] = cur
    r = np.minimum(r, need)  # never exceed what the peak needs (safety)
    y = x * r
    return y.astype(np.float32), float(-20 * np.log10(max(r.min(), 1e-6)))


def normalize(x: np.ndarray, target: float = TARGET_LUFS, tp_db: float = TP_LIMIT_DB, max_iter: int = 8, max_gr_db: float = 22.0):
    """Gain to `target` LUFS integrated, limited to `tp_db` dBTP. Iterates the gain so the LUFS measured AFTER limiting hits
    the target (or stops when the limiter would need > max_gr_db). Returns (y, info)."""
    x = x.astype(np.float64)
    l0 = lufs(x)
    if not np.isfinite(l0):
        return x.astype(np.float32), {"lufs_in": l0, "lufs_out": l0, "gain_db": 0.0, "max_gr_db": 0.0, "tp_out_db": true_peak_db(x), "note": "silent"}
    gain = target - l0
    best = None
    for it in range(max_iter):
        y, gr = limit_true_peak((x * 10 ** (gain / 20)).astype(np.float32), tp_db)
        l1 = lufs(y)
        best = (y, gr, l1, gain)
        err = target - l1
        if abs(err) < 0.15 or gr > max_gr_db:
            break
        gain += err
    y, gr, l1, gain = best
    if gr > max_gr_db:
        note = "gain capped: limiter needed > %.0f dB" % max_gr_db
    elif abs(target - l1) > 0.5:
        note = "target not reached"
    else:
        note = ""
    return y, {"lufs_in": l0, "lufs_out": l1, "gain_db": gain, "max_gr_db": gr, "tp_out_db": true_peak_db(y), "note": note}


# ----------------------------------------------------------------------------- Perch v2 scoring (birda in a throwaway container)

SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "unraid"]


def _run_birda(items: dict[str, np.ndarray], extra: str, min_conf: float, container: str, sr: int = SR, model: str = "perch-v2") -> dict[str, list[dict]]:
    """Run birda/Perch v2 in the throwaway container over arrays; returns {key: [csv rows as dicts]}."""
    import csv
    keys = sorted(items)
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        for k in keys:
            sf.write(td / f"{k}.wav", items[k].astype(np.float32), sr, subtype="FLOAT")
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for k in keys:
                tar.add(td / f"{k}.wav", arcname=f"{k}.wav")
        script = (
            "rm -rf /work/in /work/out; mkdir -p /work/in /work/out; tar -x -C /work/in; "
            "export HOME=/work/home LD_LIBRARY_PATH=/opt/birda; "
            f"/opt/birda/birda --cpu --model {model} --format csv --min-confidence {min_conf} {extra} --no-progress --force "
            "--output-dir /work/out /work/in > /work/birda.log 2>&1; echo $? > /work/birda.rc; "
            "cp /work/birda.log /work/birda.rc /work/out/; tar -C /work/out -c ."
        )
        p = subprocess.run(SSH + [f"docker exec -i {container} bash -c '{script}'"], input=buf.getvalue(), capture_output=True)
        if p.returncode != 0 or not p.stdout:
            raise RuntimeError("perch scoring failed: " + p.stderr.decode(errors="replace")[-800:])
        out = pathlib.Path(tempfile.mkdtemp(prefix="perch-out-"))
        with tarfile.open(fileobj=io.BytesIO(p.stdout), mode="r") as tar:
            tar.extractall(out)
    rc = (out / "birda.rc").read_text().strip() if (out / "birda.rc").exists() else "?"
    if rc != "0":
        raise RuntimeError("birda exit " + rc + ": " + (out / "birda.log").read_text()[-800:])
    res: dict[str, list[dict]] = {k: [] for k in keys}
    for f in out.glob("*.csv"):
        stem = f.name
        for suf in (".BirdNET.results.csv", ".results.csv", ".csv"):
            if stem.endswith(suf):
                stem = stem[: -len(suf)]
                break
        if stem.endswith(".wav"):
            stem = stem[:-4]
        if stem not in res:
            continue
        with f.open(encoding="utf-8-sig", newline="") as h:
            for row in csv.DictReader(h):
                try:
                    res[stem].append({"start": float(row["Start (s)"]), "end": float(row["End (s)"]), "sci": row["Scientific name"], "conf": float(row["Confidence"])})
                except (KeyError, ValueError):
                    continue
    return res


def perch_score(items: dict[str, np.ndarray], min_conf: float = 0.0002, container: str = "bsnd-birda") -> dict[str, dict[str, float]]:
    """Score arrays (22.05 kHz float32) with Perch v2 via birda. Returns {key: {scientific_name: max confidence over segments}}."""
    rows = _run_birda(items, "", min_conf, container)
    res: dict[str, dict[str, float]] = {k: {} for k in rows}
    for k, lst in rows.items():
        for r in lst:
            if r["conf"] > res[k].get(r["sci"], 0.0):
                res[k][r["sci"]] = r["conf"]
    return res


def perch_windows(items: dict[str, np.ndarray], overlap: float = 4.5, min_conf: float = 0.0002, container: str = "bsnd-birda") -> dict[str, list[dict]]:
    """Sliding 5 s Perch windows (hop = 5 - overlap seconds). Returns {key: [{start,end,sci,conf}, ...]} (only rows >= min_conf)."""
    return _run_birda(items, f"--overlap {overlap}", min_conf, container)


def birdnet_windows(items: dict[str, np.ndarray], overlap: float = 1.5, min_conf: float = 0.0002, container: str = "bsnd-birda") -> dict[str, list[dict]]:
    """BirdNET v2.4 sliding 3 s windows (the model BirdNET-Go itself runs). Same row format as perch_windows."""
    return _run_birda(items, f"--overlap {overlap}", min_conf, container, model="birdnet-v24")
