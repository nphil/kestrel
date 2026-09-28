"""Teach the wildlife classifier from Kestrel corrections, and install it only if it wins.

Only the final layer (one row of weights per species) is retrained; the 300 M-parameter
image backbone stays exactly as trained on iNaturalist. Each corrected or confirmed crop
becomes a training example, and the new weights are held close to the current ones
(an "anchor" penalty), so a handful of corrections nudges the model instead of
overwriting what it already knows.

Two gates must both pass before anything is installed:
  1. Corrections: accuracy on corrections it did NOT train on (k-fold cross-validation)
     beats the current model by at least --min-gain.
  2. No regressions: on the evaluation photos (eval/make_testset.py, "camera" variant),
     first-guess accuracy drops by no more than --max-drop.

Sources (pick one):
  --plugin http://192.168.1.69:11080/endpoint/@nphil/kestrel/public/  (+ --key-file)
  --export-json corrections.json --media-root <dir that the item paths are relative to>

--install copies the new model into Scrypted's ONNX plugin (keeping model.onnx.prev for
rollback), reloads that plugin, and tells Kestrel the retrain happened.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from export import export_onnx, load_model  # noqa: E402

HERE = Path(__file__).resolve().parent.parent  # classifier/
SKIP_LABELS = {"not_animal", "unknown"}


# ---------------------------------------------------------------- data
class Source:
    def __init__(self, plugin: str | None, key_file: Path | None, export_json: Path | None, media_root: Path | None):
        self.plugin, self.media_root = plugin, media_root
        self.key = key_file.read_text().strip() if key_file else None
        self.export = json.loads(export_json.read_text()) if export_json else json.loads(self.get("corrections/export"))

    def get(self, path: str) -> bytes:
        if self.media_root is not None:
            return (self.media_root / path).read_bytes()
        req = urllib.request.Request(self.plugin.rstrip("/") + "/" + path, headers={"X-Kestrel-Key": self.key})
        return urllib.request.urlopen(req, timeout=60).read()

    def post(self, path: str, body: dict) -> None:
        if self.plugin is None:
            return
        req = urllib.request.Request(self.plugin.rstrip("/") + "/" + path, data=json.dumps(body).encode(),
                                     headers={"X-Kestrel-Key": self.key, "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=60).read()


# ---------------------------------------------------------------- features
class Featurizer:
    """Pooled backbone features, preprocessed exactly as Scrypted feeds the model
    (stretch-resize to the input size, 0..1, mean/std), cached on disk by image hash."""

    def __init__(self, model: torch.nn.Module, cache: Path):
        self.model, self.cache = model, cache
        cfg = model.pretrained_cfg
        self.size = cfg["input_size"][1]
        self.mean = torch.tensor(cfg["mean"]).view(1, 3, 1, 1)
        self.std = torch.tensor(cfg["std"]).view(1, 3, 1, 1)
        cache.mkdir(parents=True, exist_ok=True)

    @torch.no_grad()
    def __call__(self, jpeg: bytes) -> np.ndarray:
        path = self.cache / (hashlib.sha1(jpeg).hexdigest() + ".npy")
        if path.exists():
            return np.load(path)
        img = Image.open(io.BytesIO(jpeg)).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        x = torch.from_numpy(np.asarray(img, dtype=np.float32)).permute(2, 0, 1)[None] / 255.0
        x = (x - self.mean) / self.std
        feat = self.model.forward_head(self.model.forward_features(x), pre_logits=True)[0].numpy()
        np.save(path, feat)
        return feat


# ---------------------------------------------------------------- training
def train_head(w0: torch.Tensor, b0: torch.Tensor, x: torch.Tensor, y: torch.Tensor, anchor: float,
               steps: int = 300) -> tuple[torch.Tensor, torch.Tensor]:
    w, b = w0.clone().requires_grad_(True), b0.clone().requires_grad_(True)
    opt = torch.optim.Adam([w, b], lr=1e-3)
    for _ in range(steps):
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(x @ w.T + b, y)
        loss = loss + anchor * ((w - w0).pow(2).sum() + (b - b0).pow(2).sum())
        loss.backward()
        opt.step()
    return w.detach(), b.detach()


def accuracy(w: torch.Tensor, b: torch.Tensor, x: torch.Tensor, y: torch.Tensor) -> float:
    return float(((x @ w.T + b).argmax(1) == y).float().mean()) if len(y) else float("nan")


def cross_validate(w0, b0, x, y, anchor: float, folds: int) -> float:
    idx = torch.randperm(len(y), generator=torch.Generator().manual_seed(0))
    correct = 0
    for k in range(folds):
        test = idx[k::folds]
        train = torch.cat([idx[j::folds] for j in range(folds) if j != k])
        w, b = train_head(w0, b0, x[train], y[train], anchor)
        correct += int(((x[test] @ w.T + b).argmax(1) == y[test]).sum())
    return correct / len(y)


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", type=Path, default=HERE / "species/atlanta.json")
    ap.add_argument("--name", default="wildlife-atlanta", help="model name under dist/ (and the staged folder)")
    ap.add_argument("--plugin")
    ap.add_argument("--key-file", type=Path, default=Path("/data/home/kestrel/.kestrel-key"))
    ap.add_argument("--export-json", type=Path)
    ap.add_argument("--media-root", type=Path)
    ap.add_argument("--testset", type=Path, default=HERE / "data/testset", help="gate set (make_testset.py output)")
    ap.add_argument("--exclude-from-gate", type=Path, help="JSON list of test files used as corrections (self-test only)")
    ap.add_argument("--min-items", type=int, default=10)
    ap.add_argument("--min-gain", type=float, default=0.05, help="required gain on unseen corrections ...")
    ap.add_argument("--min-gate-gain", type=float, default=0.02, help="... or on the evaluation photos")
    ap.add_argument("--max-drop", type=float, default=0.01)
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--scrypted-device", default="248")
    args = ap.parse_args()
    if not args.plugin and not args.export_json:
        ap.error("give --plugin or --export-json")

    rows = json.loads(args.species.read_text())
    labels = [r["label"] for r in rows]
    label_idx = {l: i for i, l in enumerate(labels)}
    dist = HERE / "dist" / args.name
    current_head = dist / "head.pt"
    model = load_model(rows, current_head if current_head.exists() else None)
    feats = Featurizer(model, HERE / "data/feature-cache")
    w0, b0 = model.head.weight.detach().clone(), model.head.bias.detach().clone()

    src = Source(args.plugin if not args.export_json else None,
                 args.key_file if not args.export_json else None, args.export_json, args.media_root)
    exported = src.export.get("classifier", {}).get("labels")
    if exported and exported != labels:
        raise SystemExit("the installed classifier's labels differ from --species; retrain from the matching species file")

    items = [it for it in src.export["items"] if it["to"] not in SKIP_LABELS and it["to"] in label_idx]
    print(f"{len(items)} usable examples ({len(src.export['items']) - len(items)} not-an-animal/unknown skipped)")
    if len(items) < args.min_items:
        print(f"not enough examples yet (need {args.min_items}); nothing changed")
        return
    x = torch.from_numpy(np.stack([feats(src.get(it["crop"])) for it in items]))
    y = torch.tensor([label_idx[it["to"]] for it in items])

    # Gate set: evaluation photos in the "camera" variant.
    manifest = json.loads((args.testset / "manifest.json").read_text())
    excluded = set(json.loads(args.exclude_from_gate.read_text())) if args.exclude_from_gate else set()
    gate = [m for m in manifest if m["label"] in label_idx and m["file"] not in excluded]
    gx = torch.from_numpy(np.stack([feats((args.testset / "camera" / m["file"]).read_bytes()) for m in gate]))
    gy = torch.tensor([label_idx[m["label"]] for m in gate])

    before_corr = accuracy(w0, b0, x, y)
    before_gate = accuracy(w0, b0, gx, gy)
    folds = min(5, len(y))
    best = max(((cross_validate(w0, b0, x, y, a, folds), a) for a in (0.003, 0.01, 0.03, 0.1, 0.3, 1.0)), key=lambda t: t[0])
    cv_acc, anchor = best
    w, b = train_head(w0, b0, x, y, anchor)
    after_gate = accuracy(w, b, gx, gy)
    report = {"examples": len(y), "anchor": anchor,
              "corrections_before": round(before_corr, 3), "corrections_after_cv": round(cv_acc, 3),
              "gate_before": round(before_gate, 3), "gate_after": round(after_gate, 3), "gate_n": len(gy)}
    print(json.dumps(report))
    corr_gain, gate_gain = cv_acc - before_corr, after_gate - before_gate
    if corr_gain < 0 or gate_gain < -args.max_drop:
        print("REJECTED: it got worse on photos it did not train on; nothing changed")
        return
    if corr_gain < args.min_gain and gate_gain < args.min_gate_gain:
        print("REJECTED: not clearly better yet; nothing changed")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = HERE / "dist" / f"{args.name}-r{stamp}"
    out.mkdir(parents=True)
    head_file = out / "head.pt"
    torch.save({"weight": w, "bias": b}, head_file)
    model.head.weight.data.copy_(w)
    model.head.bias.data.copy_(b)
    export_onnx(model, rows, out)
    (out / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(f"ACCEPTED: new model in {out}")
    if not args.install:
        print("run again with --install (or deploy/swap-model.sh) to put it live")
        return
    subprocess.run([str(HERE / "deploy/swap-model.sh"), str(out / "model.onnx"), args.scrypted_device], check=True)
    torch.save({"weight": w, "bias": b}, current_head)
    src.post("corrections/retrained", {"at": int(time.time() * 1000)})
    print("installed")


if __name__ == "__main__":
    main()
