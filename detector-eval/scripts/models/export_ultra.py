#!/usr/bin/env python3
"""Export Ultralytics-format detectors to static-shape FP32 ONNX (raw head output, no NMS) -> models/<name>/.

Venv: detector-eval/.venv-export (torch CPU + ultralytics). Checkpoints live in research/dl/ (downloaded by fetch_weights()).

    nice -n 10 .venv-export/bin/python scripts/models/export_ultra.py sorrel_960 yolo11m_coco_640 ...
    export_ultra.py --list

What is exported (same as Ultralytics' own `export(format='onnx', simplify=False, dynamic=False, half=False, nms=False)`):
  * model.eval().float().fuse() (Conv+BN folded), head in export mode, opset 18, input 'images' [1,3,H,W] RGB 0..1
  * Detect heads (YOLOv8/9/11, YOLO-World)  -> output0 [1, 4+nc, N]      "yolov8_raw"   (xywh centre px + sigmoid scores)
  * v10Detect heads (YOLOv10)               -> output0 [1, 300, 6]       "end2end_xyxy" (one-to-one head, top-300 in graph)
  * RT-DETR                                 -> output0 [1, 300, 6]       "end2end_xyxy" (boxes converted from normalised
                                                                         cx,cy,w,h to xyxy input px by a tiny wrapper)
  * metadata_props: names (python dict string), stride, imgsz, task, batch, license, source (what Scrypted's loader reads)
Verification: PyTorch (same fused module) vs onnxruntime-CPU on 4 real frames -> parity.json + meta.json["parity"].
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time
import warnings
from pathlib import Path

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
import modelkit as mk  # noqa: E402

DL = mk.ROOT / "research" / "dl"
MD6 = DL / "md"
MD1000 = DL / "md1000"
COCO_DIR = DL / "coco"

MD_LIC_CODE = "MIT (microsoft/MegaDetector, Pytorch-Wildlife); Ultralytics training/export code AGPL-3.0"
MD6_LIC_W = ("AGPL-3.0 (stamped in the checkpoint by Ultralytics; Microsoft MegaDetector Model Zoo lists it as AGPL-3.0; "
             "the Zenodo record 'Pytorch-wildlife-model-weights' is tagged CC BY 4.0)")
ULTRA_LIC = "AGPL-3.0 (Ultralytics)"
ZENODO = "https://zenodo.org/records/18177050/files/{f}"


def S(**kw):
    kw.setdefault("arch", "yolo")
    kw.setdefault("force_end2end", False)
    kw.setdefault("v8fmt", False)
    kw.setdefault("groups", "md")
    kw.setdefault("licence_code", MD_LIC_CODE)
    kw.setdefault("licence_weights", MD6_LIC_W)
    kw.setdefault("pad_value", 114)
    kw.setdefault("extra", {})
    return kw


WORLD_DIR = DL / "world"
WORLD_VOCAB = ["person", "car", "truck", "bird", "songbird", "squirrel", "chipmunk", "raccoon", "opossum", "rabbit", "deer",
               "fox", "coyote", "groundhog", "skunk", "cat", "dog", "rat"]
WORLD_LIC_CODE = ("AGPL-3.0 (Ultralytics port); original YOLO-World code GPL-3.0 (AILab-CVC/YOLO-World); "
                  "text encoder CLIP ViT-B/32 MIT (OpenAI), baked into the graph as constant embeddings")
WORLD_LIC_W = "AGPL-3.0 (Ultralytics release of the YOLO-Worldv2 weights, trained by Tencent AI Lab; upstream YOLO-World weights GPL-3.0)"

SPECS: dict[str, dict] = {
    # ---- MegaDetector v6 (Microsoft AI for Good) -- checkpoints from Zenodo ------------------------------------------
    "mdv6_yolov9c_1280": S(ckpt=MD6 / "MDV6-yolov9-c.pt", imgsz=1280, family="megadetector-v6-yolov9c",
                           source=ZENODO.format(f="MDV6-yolov9-c.pt"), extra={"trained_imgsz": 640, "published_params_m": 25.5,
                                                                              "note": "trained at 640, Pytorch-Wildlife runs it at 1280"}),
    "mdv6_yolov10c_640": S(ckpt=MD6 / "MDV6-yolov10-c.pt", imgsz=640, force_end2end=True, family="megadetector-v6-yolov10c",
                           source=ZENODO.format(f="MDV6-yolov10-c.pt"), extra={"trained_imgsz": 640, "published_params_m": 2.3}),
    "mdv6_yolov10c_1280": S(ckpt=MD6 / "MDV6-yolov10-c.pt", imgsz=1280, force_end2end=True, family="megadetector-v6-yolov10c",
                            source=ZENODO.format(f="MDV6-yolov10-c.pt"), extra={"trained_imgsz": 640, "published_params_m": 2.3,
                                                                               "note": "trained at 640, Pytorch-Wildlife runs it at 1280"}),
    "mdv6_rtdetrc_640": S(ckpt=MD6 / "MDV6-rtdetr-c.pt", arch="rtdetr", imgsz=640, family="megadetector-v6-rtdetr-l",
                          source=ZENODO.format(f="MDV6-rtdetr-c.pt"), extra={"trained_imgsz": 640, "published_params_m": 31.9}),
    "mdv6_yolov10e_1280": S(ckpt=MD6 / "MDV6-yolov10-e-1280.pt", imgsz=1280, force_end2end=True, family="megadetector-v6-yolov10x",
                            source=ZENODO.format(f="MDV6-yolov10-e-1280.pt"), extra={"trained_imgsz": 1280, "published_params_m": 29.5}),
    "mdv6_yolov9e_1280": S(ckpt=MD6 / "MDV6-yolov9-e-1280.pt", imgsz=1280, family="megadetector-v6-yolov9e",
                           source=ZENODO.format(f="MDV6-yolov9-e-1280.pt"), extra={"trained_imgsz": 1280, "published_params_m": 58.1}),
    # ---- same networks, output converted to the yolov8_raw layout (no top-k): loadable by Scrypted's parse_yolov9 ----
    "mdv6_yolov10c_640_v8fmt": None,    # filled in below (copies of the end2end specs with v8fmt=True)
    "mdv6_rtdetrc_640_v8fmt": None,
    # ---- MegaDetector v1000 (agentmorris) Ultralytics-trained members -----------------------------------------------
    "mdv1000_sorrel_960": S(ckpt=MD1000 / "md_v1000.0.0-sorrel.pt", imgsz=960, family="megadetector-v1000-sorrel-yolo11s",
                            licence_code="MIT (agentmorris/MegaDetector); Ultralytics code AGPL-3.0",
                            licence_weights="AGPL-3.0 stamp inside the checkpoint (Ultralytics); release notes list inference licence AGPL; no separate weights licence stated",
                            source="https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-sorrel.pt",
                            extra={"trained_imgsz": 960, "normalized_animal_ap": 0.967,
                                   "recommended_conf": "0.3-0.4 (author: MDv1000 scores run lower than MDv5's 0.2)"}),
    "mdv1000_larch_640": S(ckpt=MD1000 / "md_v1000.0.0-larch.pt", imgsz=640, family="megadetector-v1000-larch-yolo11l",
                           licence_code="MIT (agentmorris/MegaDetector); Ultralytics code AGPL-3.0",
                           licence_weights="AGPL-3.0 stamp inside the checkpoint (Ultralytics); release notes list inference licence AGPL; no separate weights licence stated",
                           source="https://github.com/agentmorris/MegaDetector/releases/download/v1000.0/md_v1000.0.0-larch.pt",
                           extra={"trained_imgsz": 640, "normalized_animal_ap": 0.969,
                                  "recommended_conf": "0.3-0.4 (author: MDv1000 scores run lower than MDv5's 0.2)"}),
    # ---- open-vocabulary YOLO-World v2 with a BAKED vocabulary (CLIP text embeddings become constants) -------------
    "yoloworld_v8s_640": S(ckpt=WORLD_DIR / "yolov8s-worldv2.pt", arch="world", imgsz=640, groups="world", family="yolo-world-v2-s",
                           licence_code=WORLD_LIC_CODE, licence_weights=WORLD_LIC_W,
                           source="https://github.com/ultralytics/assets/releases (yolov8s-worldv2.pt) + set_classes(vocabulary)",
                           extra={"vocabulary": WORLD_VOCAB}),
    "yoloworld_v8m_640": S(ckpt=WORLD_DIR / "yolov8m-worldv2.pt", arch="world", imgsz=640, groups="world", family="yolo-world-v2-m",
                           licence_code=WORLD_LIC_CODE, licence_weights=WORLD_LIC_W,
                           source="https://github.com/ultralytics/assets/releases (yolov8m-worldv2.pt) + set_classes(vocabulary)",
                           extra={"vocabulary": WORLD_VOCAB}),
    # ---- COCO baselines (80 classes; animals 14-23, person 0, vehicles 1,2,3,5,7) -----------------------------------
    "yolo11s_coco_640": S(ckpt=COCO_DIR / "yolo11s.pt", imgsz=640, groups="coco", family="ultralytics-yolo11",
                          licence_code=ULTRA_LIC, licence_weights="AGPL-3.0 (Ultralytics pretrained COCO weights)",
                          source="https://github.com/ultralytics/assets/releases (yolo11s.pt)"),
    "yolo11m_coco_640": S(ckpt=COCO_DIR / "yolo11m.pt", imgsz=640, groups="coco", family="ultralytics-yolo11",
                          licence_code=ULTRA_LIC, licence_weights="AGPL-3.0 (Ultralytics pretrained COCO weights)",
                          source="https://github.com/ultralytics/assets/releases (yolo11m.pt)"),
    "yolov8s_coco_640": S(ckpt=COCO_DIR / "yolov8s.pt", imgsz=640, groups="coco", family="ultralytics-yolov8",
                          licence_code=ULTRA_LIC, licence_weights="AGPL-3.0 (Ultralytics pretrained COCO weights)",
                          source="https://github.com/ultralytics/assets/releases (yolov8s.pt)"),
    "yolov8m_coco_640": S(ckpt=COCO_DIR / "yolov8m.pt", imgsz=640, groups="coco", family="ultralytics-yolov8",
                          licence_code=ULTRA_LIC, licence_weights="AGPL-3.0 (Ultralytics pretrained COCO weights)",
                          source="https://github.com/ultralytics/assets/releases (yolov8m.pt)"),
    "yolov8m_coco_1280": S(ckpt=COCO_DIR / "yolov8m.pt", imgsz=1280, groups="coco", family="ultralytics-yolov8",
                           licence_code=ULTRA_LIC, licence_weights="AGPL-3.0 (Ultralytics pretrained COCO weights)",
                           source="https://github.com/ultralytics/assets/releases (yolov8m.pt)",
                           extra={"note": "COCO weights are trained at 640; run at 1280 for small objects"}),
    "yolov9c_coco_640": S(ckpt=COCO_DIR / "yolov9c.pt", imgsz=640, groups="coco", family="ultralytics-yolov9c",
                          licence_code="AGPL-3.0 (Ultralytics port); original YOLOv9 code GPL-3.0 (WongKinYiu/yolov9)",
                          licence_weights="AGPL-3.0 (Ultralytics release of the converted official YOLOv9-C COCO weights; original weights GPL-3.0)",
                          source="https://github.com/ultralytics/assets/releases (yolov9c.pt)"),
}

SPECS["mdv6_yolov10c_640_v8fmt"] = {**SPECS["mdv6_yolov10c_640"], "v8fmt": True, "family": "megadetector-v6-yolov10c-v8fmt"}
SPECS["mdv6_rtdetrc_640_v8fmt"] = {**SPECS["mdv6_rtdetrc_640"], "v8fmt": True, "family": "megadetector-v6-rtdetr-l-v8fmt"}


# ----------------------------------------------------------------------------------------------------------------------
class ToV8Raw(nn.Module):
    """End-to-end heads (YOLOv10 one-to-one head / RT-DETR decoder) -> yolov8_raw layout [1, 4+nc, N] WITHOUT the top-k step:
    boxes as centre x, centre y, w, h in input px, per-class sigmoid scores. The head's own `postprocess` (top-k) is replaced by
    a pass-through, so N = 8400 anchors (YOLOv10) or 300 queries (RT-DETR). The nets are NMS-free by training, so the plugin's
    parse_yolov9 (threshold only, no NMS) gives the same detections as the end2end export."""

    def __init__(self, m: nn.Module, kind: str, w: int, h: int):
        super().__init__()
        self.m, self.kind = m, kind
        self.register_buffer("scale", torch.tensor([w, h, w, h], dtype=torch.float32))
        head = m.model[-1]
        if kind == "detr":
            head.postprocess = lambda boxes, scores: torch.cat([boxes, scores], -1)       # [B,Q,4+nc]
        else:
            head.postprocess = lambda preds: preds                                         # [B,N,4+nc] xyxy px

    def forward(self, x):
        y = self.m(x)
        y = y[0] if isinstance(y, (tuple, list)) else y
        if self.kind == "detr":
            box = y[..., :4] * self.scale
        else:
            x1, y1, x2, y2 = y[..., 0:1], y[..., 1:2], y[..., 2:3], y[..., 3:4]
            box = torch.cat([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1], -1)
        return torch.cat([box, y[..., 4:]], -1).permute(0, 2, 1)


class RTDETRXYXY(nn.Module):
    """RT-DETR export output [1,k,6] = cx,cy,w,h (normalised 0..1), score, class  ->  x1,y1,x2,y2 (input px), score, class."""

    def __init__(self, m: nn.Module, w: int, h: int):
        super().__init__()
        self.m = m
        self.register_buffer("scale", torch.tensor([w, h, w, h], dtype=torch.float32))

    def forward(self, x):
        y = self.m(x)
        if isinstance(y, (tuple, list)):
            y = y[0]
        c, rest = y[..., :4], y[..., 4:]
        xy = torch.cat([c[..., :2] - c[..., 2:] / 2, c[..., :2] + c[..., 2:] / 2], -1) * self.scale
        return torch.cat([xy, rest], -1)


def fetch_coco_weights() -> None:
    from ultralytics.utils.downloads import attempt_download_asset

    COCO_DIR.mkdir(parents=True, exist_ok=True)
    cwd = os.getcwd()
    os.chdir(COCO_DIR)
    try:
        for n in ("yolo11s.pt", "yolo11m.pt", "yolov8s.pt", "yolov8m.pt", "yolov9c.pt"):
            if not (COCO_DIR / n).exists():
                attempt_download_asset(n)
    finally:
        os.chdir(cwd)


def fetch_world_weights() -> None:
    from ultralytics.utils.downloads import attempt_download_asset

    WORLD_DIR.mkdir(parents=True, exist_ok=True)
    cwd = os.getcwd()
    os.chdir(WORLD_DIR)
    try:
        for n in ("yolov8s-worldv2.pt", "yolov8m-worldv2.pt"):
            if not (WORLD_DIR / n).exists():
                attempt_download_asset(n)
    finally:
        os.chdir(cwd)


def load_model(spec: dict) -> nn.Module:
    from ultralytics import RTDETR, YOLO, YOLOWorld

    if spec["arch"] == "world":
        y = YOLOWorld(str(spec["ckpt"]))
        y.set_classes(list(spec["extra"]["vocabulary"]))      # CLIP text embeddings -> model.txt_feats (constants in the graph)
        return y.model
    y = (RTDETR if spec["arch"] == "rtdetr" else YOLO)(str(spec["ckpt"]))
    return y.model


def prepare(model: nn.Module, spec: dict) -> nn.Module:
    from ultralytics.nn.modules import C2f, Detect, RTDETRDecoder

    m = copy.deepcopy(model).cpu().eval().float()
    for p in m.parameters():
        p.requires_grad_(False)
    if spec["force_end2end"]:
        # checkpoints trained with ultralytics 8.3.x: the one-to-one head exists but the new `end2end` flag is unset
        for mod in m.modules():
            if getattr(mod, "one2one_cv2", None) is not None:
                mod.end2end = True
    m = m.fuse(verbose=False)
    for mod in m.modules():
        if isinstance(mod, (Detect, RTDETRDecoder)):
            mod.dynamic = False
            mod.export = True
            mod.format = "onnx"
            mod.max_det = 300
            mod.xyxy = False
        elif isinstance(mod, C2f):
            mod.forward = mod.forward_split
    return m


def groups_for(spec: dict, names: dict[int, str]) -> tuple[list[int], list[int], list[int]]:
    if spec["groups"] == "coco":
        return mk.COCO_ANIMALS, mk.COCO_PERSON, mk.COCO_VEHICLES
    if spec["groups"] == "world":
        v = spec["extra"]["vocabulary"]
        return ([i for i, n in enumerate(v) if n not in ("person", "car", "truck")], [v.index("person")],
                [v.index("car"), v.index("truck")])
    inv = {v: k for k, v in names.items()}
    return [inv["animal"]], [inv["person"]], [inv["vehicle"]]


def export_one(name: str, spec: dict, force: bool = False) -> dict:
    d = mk.MODELS / name
    if (d / "meta.json").exists() and not force:
        print(f"{name}: exists, skipping (use --force)")
        return json.loads((d / "meta.json").read_text())
    d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    imgsz = spec["imgsz"]
    base = load_model(spec)
    nm = base.names
    names = {int(k): v for k, v in (nm.items() if isinstance(nm, dict) else enumerate(nm))}
    m = prepare(base, spec)
    head = m.model[-1]
    is_detr = type(head).__name__ == "RTDETRDecoder"
    e2e = bool(getattr(head, "end2end", False)) or is_detr
    if spec["v8fmt"]:
        assert e2e, "v8fmt only applies to end-to-end heads"
        wrapper: nn.Module = ToV8Raw(m, "detr" if is_detr else "v10", imgsz, imgsz)
    else:
        wrapper = RTDETRXYXY(m, imgsz, imgsz) if is_detr else m
    wrapper.eval()
    fmt = "yolov8_raw" if spec["v8fmt"] else ("end2end_xyxy" if e2e else "yolov8_raw")
    stride = int(max(m.stride))
    tens = mk.real_tensors(imgsz, imgsz)
    torch.set_num_threads(int(os.environ.get("EXPORT_THREADS", "4")))
    with torch.no_grad():
        for _ in range(2):   # dry runs initialise the anchor grids
            y = wrapper(torch.from_numpy(tens[0][1]))
    out_shape = list(y[0].shape if isinstance(y, (tuple, list)) else y.shape)
    print(f"{name}: torch out {out_shape} fmt={fmt} head={type(head).__name__} names={names} stride={stride}", flush=True)

    f = d / "model.onnx"
    torch.onnx.export(wrapper, torch.from_numpy(tens[0][1]), str(f), opset_version=18, input_names=["images"],
                      output_names=["output0"], dynamic_axes=None, dynamo=False)
    onnx.checker.check_model(onnx.load(str(f), load_external_data=False))
    mk.add_onnx_metadata(f, {
        "names": str(names), "stride": stride, "imgsz": [imgsz, imgsz], "task": "detect", "batch": 1,
        "output_format": fmt, "source_weights": str(spec["source"]), "license": spec["licence_weights"],
        "exporter": f"torch {torch.__version__} dynamo=False opset 18 + ultralytics {__import__('ultralytics').__version__} modules",
    })

    # ---- parity vs PyTorch ------------------------------------------------------------------------------------------
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

    animal, person, vehicle = groups_for(spec, names)
    n = out_shape[-1] if fmt == "yolov8_raw" else out_shape[1]
    v8x = ("CONVERTED from the end-to-end head: one-to-one predictions of the " + ("RT-DETR decoder (300 queries; boxes de-normalised "
           "by the input size)" if is_detr else "YOLOv10 head (8400 anchors; xyxy -> xywh)") + " without the top-k step, so Scrypted's "
           "parse_yolov9 (threshold, no NMS) can read it. The net is NMS-free by training.") if spec["v8fmt"] else ""
    note = (mk.note_yolov8_raw(len(names), n, imgsz, imgsz, v8x) if fmt == "yolov8_raw" else
            mk.note_end2end(n, imgsz, imgsz, "RT-DETR: boxes converted from normalised cx,cy,w,h by a wrapper baked into the graph."
                            if is_detr else "YOLOv10 one-to-one head."))
    extra = dict(spec["extra"])
    if spec["v8fmt"]:
        extra["converted_from"] = name.replace("_v8fmt", "")
    extra.update({"parity": par, "onnxslim": slim["slimmed"], "export_seconds": round(time.time() - t0, 1), "train_ckpt": str(spec["ckpt"].name),
                  "ultralytics": __import__("ultralytics").__version__, "torch": torch.__version__})
    meta = mk.write_meta(
        name, family=spec["family"], w=imgsz, h=imgsz, fmt=fmt, output_note=note, output_shape=out_shape,
        classes=names, animal_classes=animal, person_classes=person, vehicle_classes=vehicle,
        licence_code=spec["licence_code"], licence_weights=spec["licence_weights"], source=spec["source"],
        pad_value=spec["pad_value"], stride=stride, extra=extra)
    print(f"{name}: done in {time.time() - t0:.0f}s  params {meta['params_m']}M  {meta['gflops']} GFLOPs  {meta['size_mb']} MB", flush=True)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list or not a.names:
        print("\n".join(SPECS))
        return
    if any(SPECS[n]["groups"] == "coco" for n in a.names):
        fetch_coco_weights()
    if any(SPECS[n]["arch"] == "world" for n in a.names):
        fetch_world_weights()
    for n in a.names:
        export_one(n, SPECS[n], a.force)


if __name__ == "__main__":
    main()
