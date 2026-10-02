#!/usr/bin/env python3
"""Export checkpoints that need the OFFICIAL yolov5 / yolov9 repos (pickled `models.yolo.*` classes) -> models/<name>/.

    nice -n 10 .venv-export/bin/python scripts/models/export_official.py mdv1000_cedar_640        # needs research/src/yolov9
    nice -n 10 .venv-export/bin/python scripts/models/export_official.py mdv5a_1280 mdv5a_960 ... # needs research/src/yolov5 (v7.0)
(one repo per process: both repos use the top-level package name `models`).  Clone with:
    git clone --depth 1 https://github.com/WongKinYiu/yolov9 research/src/yolov9
    git clone --depth 1 --branch v7.0 https://github.com/ultralytics/yolov5 research/src/yolov5

Output formats
  yolov9 (DDetect head):  [1, 4+nc, N]  "yolov8_raw"   xywh centre px + sigmoid class scores
  yolov5 (Detect head):   [1, N, 5+nc]  "yolov5_raw"   xywh centre px, objectness, class probs (score = obj*cls), N = 3 x sum(grid^2)
  *_v8fmt variants:       the YOLOv5 head followed by (obj*cls, transpose) baked into the graph -> [1, 4+nc, N] "yolov8_raw",
                          which the Scrypted plugin's parse_yolov9 can read.
Same checks as export_ultra.py (PyTorch vs onnxruntime-CPU on 4 frames, metadata_props names/stride).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

import modelkit as mk  # noqa: E402

DL = ROOT / "research" / "dl"
MD6, MD1000 = DL / "md", DL / "md1000"
MD_LIC_CODE = "MIT (agentmorris/MegaDetector); inference code GPL-3.0 (official yolov5/yolov9 repos)"
MD_V1000_W = ("not stated: repo is MIT, the release notes only list the INFERENCE-code licence (GPL for cedar/redwood/spruce) and "
              "say the licence of exported weights is 'above my pay grade'")


def S(**kw):
    kw.setdefault("v8fmt", False)
    kw.setdefault("groups", "md")
    kw.setdefault("extra", {})
    kw.setdefault("pad_value", 114)
    return kw


SPECS: dict[str, dict] = {
    "mdv1000_cedar_640": S(repo="yolov9", ckpt=MD1000 / "md_v1000.0.0-cedar.pt", imgsz=640, family="megadetector-v1000-cedar-yolov9c",
                           licence_code=MD_LIC_CODE, licence_weights=MD_V1000_W,
                           source="https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-cedar.pt",
                           extra={"trained_imgsz": 640, "normalized_animal_ap": 0.991,
                                  "recommended_conf": "0.3-0.4 (author: MDv1000 scores run lower than MDv5's 0.2)"}),
    "mdv1000_redwood_1280": S(repo="yolov5", ckpt=MD1000 / "md_v1000.0.0-redwood.pt", imgsz=1280, family="megadetector-v1000-redwood-yolov5x6",
                              licence_code=MD_LIC_CODE + "; yolov5 v7.0 is GPL-3.0", licence_weights=MD_V1000_W,
                              source="https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-redwood.pt",
                              extra={"trained_imgsz": 1280, "normalized_animal_ap": 1.009,
                                     "recommended_conf": "0.3-0.4 (author)"}),
    "mdv1000_spruce_640": S(repo="yolov5", ckpt=MD1000 / "md_v1000.0.0-spruce.pt", imgsz=640, family="megadetector-v1000-spruce-yolov5s",
                            licence_code=MD_LIC_CODE + "; yolov5 v7.0 is GPL-3.0", licence_weights=MD_V1000_W,
                            source="https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-spruce.pt",
                            extra={"trained_imgsz": 640, "normalized_animal_ap": 0.864,
                                   "recommended_conf": "0.3-0.4 (author)"}),
}
for _sz in (1280, 960, 640):
    SPECS[f"mdv5a_{_sz}"] = S(repo="yolov5", ckpt=MD6 / "md_v5a.0.0.pt", imgsz=_sz, family="megadetector-v5a-yolov5x6",
                              licence_code=MD_LIC_CODE + "; yolov5 v7.0 is GPL-3.0",
                              licence_weights="MIT per the MegaDetector repo (weights were trained with the GPL-3.0 yolov5 code; "
                                              "the Zenodo record 'Pytorch-wildlife-model-weights' that hosts this copy is tagged CC BY 4.0)",
                              source="https://github.com/agentmorris/MegaDetector/releases/download/v5.0/md_v5a.0.0.pt (md5 ec1d7603ec8cf642d6e0cd008ba2be8c, also on Zenodo 15398270)",
                              extra={"trained_imgsz": 1280, "recommended_conf": "0.2 (MegaDetector default)"})
for _sz in (320, 384, 448, 512):   # same cedar weights, other static input sizes (trained at 640)
    SPECS[f"mdv1000_cedar_{_sz}"] = S(**{**SPECS["mdv1000_cedar_640"], "imgsz": _sz})
SPECS["yolov9c_coco_official_640"] = S(
    repo="yolov9", ckpt=DL / "coco" / "yolov9-c-converted.pt", imgsz=640, groups="coco", family="yolov9-official-c",
    licence_code="GPL-3.0 (WongKinYiu/yolov9)", licence_weights="GPL-3.0 (official release yolov9-c-converted.pt, COCO)",
    source="https://github.com/WongKinYiu/yolov9/releases/download/v0.1/yolov9-c-converted.pt",
    extra={"note": "official YOLOv9-C COCO weights (single-branch 'converted' form), exported with the official repo code"})
SPECS["mdv5a_1280_v8fmt"] = S(**{**SPECS["mdv5a_1280"], "v8fmt": True})


class V8Format(nn.Module):
    """YOLOv5 [1,N,5+nc] -> YOLOv8 layout [1,4+nc,N] with score = objectness * class probability."""

    def __init__(self, m: nn.Module):
        super().__init__()
        self.m = m

    def forward(self, x):
        y = self.m(x)
        y = y[0] if isinstance(y, (tuple, list)) else y
        return torch.cat([y[..., :4], y[..., 4:5] * y[..., 5:]], -1).permute(0, 2, 1)


def load(spec: dict) -> nn.Module:
    repo = ROOT / "research" / "src" / spec["repo"]
    sys.path.insert(0, str(repo))
    ck = torch.load(str(spec["ckpt"]), map_location="cpu", weights_only=False)
    if ck.get("ema") is not None:
        print("  note: checkpoint has an EMA copy; MegaDetector itself loads ck['model'], we do the same")
    model = ck["model"].float()
    for p_ in model.parameters():
        p_.requires_grad_(False)     # before fuse(): fused weights must stay leaf tensors
    for m in model.modules():   # compat fixes from yolov5.models.experimental.attempt_load
        t = type(m)
        if t is nn.Upsample and not hasattr(m, "recompute_scale_factor"):
            m.recompute_scale_factor = None
        if t.__name__ == "Detect":
            if not isinstance(m.anchor_grid, list):
                delattr(m, "anchor_grid")
                setattr(m, "anchor_grid", [torch.zeros(1)] * m.nl)
            m.inplace = False
        if t.__name__ in ("DDetect", "DualDDetect", "Detect"):
            m.inplace = False
    with torch.no_grad():
        model = model.fuse().eval()
    for m in model.modules():
        if type(m).__name__ in ("Detect", "DDetect", "DualDDetect"):
            m.inplace = False
            m.dynamic = False
            m.export = True
    return model


def export_one(name: str, spec: dict, force: bool) -> dict:
    d = mk.MODELS / name
    if (d / "meta.json").exists() and not force:
        print(f"{name}: exists, skipping")
        return json.loads((d / "meta.json").read_text())
    d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    imgsz = spec["imgsz"]
    model = load(spec)
    nm = model.names
    names = {int(k): v for k, v in (nm.items() if isinstance(nm, dict) else enumerate(nm))}
    head = model.model[-1]
    is_v5 = type(head).__name__ == "Detect"
    fmt = "yolov5_raw" if (is_v5 and not spec["v8fmt"]) else "yolov8_raw"
    wrapper: nn.Module = V8Format(model) if spec["v8fmt"] else model
    wrapper.eval()
    stride = int(max(model.stride))
    tens = mk.real_tensors(imgsz, imgsz)
    torch.set_num_threads(int(os.environ.get("EXPORT_THREADS", "4")))
    with torch.no_grad():
        for _ in range(2):
            y = wrapper(torch.from_numpy(tens[0][1]))
    y = y[0] if isinstance(y, (tuple, list)) else y
    out_shape = list(y.shape)
    print(f"{name}: torch out {out_shape} fmt={fmt} head={type(head).__name__} names={names} stride={stride} "
          f"params={sum(p.numel() for p in model.parameters()) / 1e6:.2f}M", flush=True)

    f = d / "model.onnx"
    torch.onnx.export(wrapper, torch.from_numpy(tens[0][1]), str(f), opset_version=17, input_names=["images"],
                      output_names=["output0"], dynamic_axes=None, dynamo=False)
    onnx.checker.check_model(onnx.load(str(f), load_external_data=False))
    mk.add_onnx_metadata(f, {
        "names": str(names), "stride": stride, "imgsz": [imgsz, imgsz], "task": "detect", "batch": 1,
        "output_format": fmt, "source_weights": spec["source"], "license": spec["licence_weights"],
        "exporter": f"torch {torch.__version__} dynamo=False opset 17, official {spec['repo']} model code",
    })

    so = ort.SessionOptions()
    so.intra_op_num_threads = int(os.environ.get("EXPORT_THREADS", "4"))
    sess = ort.InferenceSession(str(f), so, providers=["CPUExecutionProvider"])
    per, refs = {}, []
    for tag, x in tens:
        with torch.no_grad():
            ref = wrapper(torch.from_numpy(x))
        ref = (ref[0] if isinstance(ref, (tuple, list)) else ref).numpy()
        refs.append(ref)
        got = sess.run(None, {"images": x})[0]
        per[tag] = mk.compare_outputs(ref, got, fmt)
    par = mk.summarize_parity(per)
    del sess
    slim = mk.try_slim(f, imgsz, imgsz, tens, refs, fmt, threads=int(os.environ.get("EXPORT_THREADS", "4")), baseline=par)
    print(f"{name}: onnxslim {'KEPT' if slim['slimmed'] else 'rejected'} nodes {slim['nodes_before']} -> {slim['nodes_after']} "
          f"parity of slim candidate {slim['summary']['max_abs_diff_scores']:.2e}", flush=True)
    if slim["slimmed"]:
        par = slim["summary"]
        per = {"note": "per-image numbers are for the un-slimmed export; summary is for the slimmed file", **per}
    (d / "parity.json").write_text(json.dumps({"summary": par, "per_image": per}, indent=2) + "\n")
    print(f"{name}: parity {par}", flush=True)

    inv = {v: k for k, v in names.items()}
    if spec["groups"] == "coco":
        animal, person, vehicle = mk.COCO_ANIMALS, mk.COCO_PERSON, mk.COCO_VEHICLES
    else:
        animal, person, vehicle = [inv["animal"]], [inv["person"]], [inv["vehicle"]]
    n = out_shape[-1] if fmt == "yolov8_raw" else out_shape[1]
    if fmt == "yolov5_raw":
        note = mk.note_yolov5_raw(len(names), n, imgsz, imgsz)
    else:
        note = mk.note_yolov8_raw(len(names), n, imgsz, imgsz,
                                  "YOLOv5 head with the score = objectness x class probability product and the transpose baked into the graph." if spec["v8fmt"] else "")
    extra = dict(spec["extra"])
    if spec["v8fmt"]:
        extra["converted_from"] = name.replace("_v8fmt", "")
    extra.update({"parity": par, "onnxslim": slim["slimmed"], "export_seconds": round(time.time() - t0, 1), "train_ckpt": spec["ckpt"].name, "torch": torch.__version__})
    meta = mk.write_meta(
        name, family=spec["family"], w=imgsz, h=imgsz, fmt=fmt, output_note=note, output_shape=out_shape, classes=names,
        animal_classes=animal, person_classes=person, vehicle_classes=vehicle,
        licence_code=spec["licence_code"], licence_weights=spec["licence_weights"], source=spec["source"],
        pad_value=spec["pad_value"], stride=stride, extra=extra)
    print(f"{name}: done in {time.time() - t0:.0f}s params {meta['params_m']}M {meta['gflops']} GFLOPs {meta['size_mb']} MB", flush=True)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if not a.names:
        print("\n".join(f"{k}  ({v['repo']})" for k, v in SPECS.items()))
        return
    repos = {SPECS[n]["repo"] for n in a.names}
    if len(repos) != 1:
        raise SystemExit("one repo per process (yolov5 and yolov9 both define the package 'models')")
    for n in a.names:
        export_one(n, SPECS[n], a.force)


if __name__ == "__main__":
    main()
