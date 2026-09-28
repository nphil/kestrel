"""Cut EVA-02 (iNat21) down to a species list and export it for Scrypted's ONNX plugin.

Scrypted's ONNX plugin loads "custom models" from a config.json next to the model
file. With `"model": "resnet"` it treats the model as a plain image classifier: it
resizes the detected animal's crop to `input_shape`, normalises it with `mean` /
`std`, takes the first output as one logit per class, applies softmax, and reports
the top classes above 50%. Any classifier with that shape works; the name "resnet"
is just the plugin's type tag.

Cutting the head (keeping only the rows of the final linear layer for local
species) is what makes softmax pick among local animals only, so a crop can never
be labelled as a species that does not live here.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import timm
import torch

MODEL_ID = "eva02_large_patch14_clip_336.merged2b_ft_inat21"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", type=Path, required=True, help="output of species.py")
    ap.add_argument("--out", type=Path, required=True, help="directory for model.onnx + config.json")
    args = ap.parse_args()

    rows = json.loads(args.species.read_text())
    keep = torch.tensor([r["index"] for r in rows])

    # timm's fused attention passes a tensor as `is_causal`, which the ONNX tracer
    # rejects; the plain attention path computes the same thing and traces cleanly.
    timm.layers.set_fused_attn(False)
    model = timm.create_model(f"hf-hub:timm/{MODEL_ID}", pretrained=True).eval()
    head: torch.nn.Linear = model.head
    trimmed = torch.nn.Linear(head.in_features, len(rows))
    with torch.no_grad():
        trimmed.weight.copy_(head.weight[keep])
        trimmed.bias.copy_(head.bias[keep])
    model.head = trimmed

    cfg = model.pretrained_cfg
    size = cfg["input_size"][1]
    args.out.mkdir(parents=True, exist_ok=True)
    onnx_path = args.out / "model.onnx"
    dummy = torch.randn(1, 3, size, size)
    torch.onnx.export(model, (dummy,), str(onnx_path), input_names=["input"], output_names=["logits"],
                      opset_version=17, dynamo=False)

    # The exported graph must agree with PyTorch, or every label downstream is wrong.
    with torch.no_grad():
        want = model(dummy).numpy()
    got = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"]).run(None, {"input": dummy.numpy()})[0]
    err = float(np.abs(want - got).max())
    if err > 1e-2 or int(want.argmax()) != int(got.argmax()):
        raise SystemExit(f"ONNX output does not match PyTorch (max abs diff {err})")

    config = {
        "input_shape": [1, 3, size, size],
        "model": "resnet",
        "mean": list(cfg["mean"]),
        "std": list(cfg["std"]),
        "files": ["model.onnx"],
        "labels": {str(i): r["label"] for i, r in enumerate(rows)},
    }
    (args.out / "config.json").write_text(json.dumps(config, indent=1) + "\n")
    print(f"exported {onnx_path} ({onnx_path.stat().st_size / 1e6:.0f} MB), {len(rows)} classes, "
          f"input {size}px, max diff vs torch {err:.2e}")


if __name__ == "__main__":
    main()
