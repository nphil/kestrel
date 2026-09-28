"""Score classifiers on the test set exactly the way Scrypted runs them.

Each model is fed the way Scrypted's ONNX plugin feeds a custom "resnet" model:
the crop is stretched to the model's input size, scaled to 0..1, normalised with
the config's mean/std, and the first output is softmaxed. Scrypted then reports
the top class only if it scores above 50%, so three numbers matter:

  top1     -- the best guess is the right species (ignoring the 50% cut)
  top5     -- the right species is among the five best guesses
  shown    -- share of crops where Scrypted would show a label at all (> 50%)
  shown_ok -- of the labels Scrypted would show, the share that are right;
              1 - shown_ok is how often you would see a confident wrong name

A model can only be right about species it knows. The Bird Classifier knows
North-American birds and no mammals, so the head-to-head table is limited to
birds both models know; mammals are reported for the wildlife model alone.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

SCRYPTED_THRESHOLD = 0.5


def norm(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


class ScryptedClassifier:
    def __init__(self, model_dir: Path, threads: int):
        self.config = json.loads((model_dir / "config.json").read_text())
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(model_dir / "model.onnx"), opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.labels = {int(k): v for k, v in self.config["labels"].items()}
        _, _, self.width, self.height = self.config["input_shape"]
        self.mean = np.array(self.config["mean"]).reshape(1, -1, 1, 1)
        self.std = np.array(self.config["std"]).reshape(1, -1, 1, 1)

    def probs(self, img: Image.Image) -> np.ndarray:
        im = np.asarray(img.resize((self.width, self.height), Image.BILINEAR), dtype=np.float32)[None]
        im = im.transpose(0, 3, 1, 2) / 255.0
        im = ((im - self.mean) / self.std).astype(np.float32)
        logits = self.session.run(None, {self.input: im})[0][0].astype(np.float64)
        e = np.exp(logits - logits.max())
        return e / e.sum()


def score(model: ScryptedClassifier, items: list[dict], root: Path, variant: str) -> dict:
    by_label = {norm(v): k for k, v in model.labels.items()}
    stats = defaultdict(int)
    for it in items:
        truth = by_label[norm(it["label"])]
        p = model.probs(Image.open(root / variant / it["file"]).convert("RGB"))
        order = np.argsort(p)[::-1]
        stats["n"] += 1
        stats["top1"] += int(order[0] == truth)
        stats["top5"] += int(truth in order[:5])
        if p[order[0]] > SCRYPTED_THRESHOLD:
            stats["shown"] += 1
            stats["shown_ok"] += int(order[0] == truth)
    n = stats["n"]
    return {"n": n, "top1": stats["top1"] / n, "top5": stats["top5"] / n, "shown": stats["shown"] / n,
            "shown_ok": stats["shown_ok"] / max(stats["shown"], 1)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--testset", type=Path, default=Path("data/testset"))
    ap.add_argument("--wildlife", type=Path, required=True, help="dir with model.onnx + config.json")
    ap.add_argument("--baseline", type=Path, help="Scrypted Bird Classifier dir (model.onnx + config.json)")
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--out", type=Path, default=Path("eval/results.json"))
    args = ap.parse_args()

    items = json.loads((args.testset / "manifest.json").read_text())
    wildlife = ScryptedClassifier(args.wildlife, args.threads)
    baseline = ScryptedClassifier(args.baseline, args.threads) if args.baseline else None

    birds_both = [i for i in items if i["group"] == "Birds"]
    if baseline:
        known = {norm(v) for v in baseline.labels.values()}
        birds_both = [i for i in birds_both if norm(i["label"]) in known]
    mammals = [i for i in items if i["group"] == "Mammals"]

    results: dict = {"birds_both_know": len(birds_both), "mammals": len(mammals), "variants": {}}
    for variant in ("clean", "camera", "night"):
        row = {"wildlife_birds": score(wildlife, birds_both, args.testset, variant),
               "wildlife_mammals": score(wildlife, mammals, args.testset, variant)}
        if baseline:
            row["bird_classifier_birds"] = score(baseline, birds_both, args.testset, variant)
        results["variants"][variant] = row
        for name, s in row.items():
            print(f"{variant:6} {name:22} n={s['n']:3}  top1 {s['top1']:.0%}  top5 {s['top5']:.0%}  "
                  f"shown {s['shown']:.0%}  shown-and-right {s['shown_ok']:.0%}")
    args.out.write_text(json.dumps(results, indent=1) + "\n")


if __name__ == "__main__":
    main()
