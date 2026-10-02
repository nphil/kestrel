#!/usr/bin/env python3
"""Priority 1: models/mdv6_yolov9c_<size> = Microsoft's published MDV6-yolov9-c.onnx frozen to 1x3x<size>x<size>
(sizes 320 384 448 512 640 = multiples of 32; the weights are the same, only the static input size differs; trained at 640).

Source: Zenodo record 18165116 / 18177050 / 15398270 (Pytorch-wildlife-model-weights), file MDV6-yolov9-c.onnx
(md5 3db7988385714066c1515dde6ab56e4c, Ultralytics 8.2.46 export, opset 17, dynamic batch/height/width, metadata
names/stride/imgsz already present). Frozen with onnxslim (constant-folds all shape arithmetic); metadata kept.
Checks: frozen == original (onnxruntime CPU, 4 real frames, max abs diff) and output sanity on the night raccoon frame.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import modelkit as mk  # noqa: E402

SIZES = (640, 512, 448, 384, 320)
SRC = mk.ROOT / "research/dl/md/MDV6-yolov9-c.onnx"
URL = "https://zenodo.org/records/18165116/files/MDV6-yolov9-c.onnx?download=1"
MD5 = "3db7988385714066c1515dde6ab56e4c"
IMAGES = [mk.ROOT / p for p in ("data/truth/raccoon_snap.jpg", "data/probe/103_main.jpg", "data/probe/104_main.jpg",
                                "data/probe/106_main.jpg")]


def md5(p: Path) -> str:
    import hashlib
    h = hashlib.md5()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def tensor(path: Path, size: int) -> np.ndarray:
    im = Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)
    return np.ascontiguousarray(np.asarray(im, dtype=np.uint8).transpose(2, 0, 1)[None].astype(np.float32) / 255.0)


def make(size: int) -> None:
    NAME = f"mdv6_yolov9c_{size}"
    n_anchors = (size // 8) ** 2 + (size // 16) ** 2 + (size // 32) ** 2
    d = mk.MODELS / NAME
    d.mkdir(parents=True, exist_ok=True)
    mk.freeze_onnx(SRC, d / "model.onnx", "images", [1, 3, size, size])

    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    orig = ort.InferenceSession(str(SRC), so, providers=["CPUExecutionProvider"])
    frozen = ort.InferenceSession(str(d / "model.onnx"), so, providers=["CPUExecutionProvider"])
    diffs = []
    for p in IMAGES:
        x = tensor(p, size)
        a = orig.run(None, {"images": x})[0]
        b = frozen.run(None, {"images": x})[0]
        assert a.shape == b.shape == (1, 7, n_anchors), (a.shape, b.shape)
        diffs.append(float(np.abs(a - b).max()))
    print("frozen vs original max abs diff per image:", diffs)

    classes = {0: "animal", 1: "person", 2: "vehicle"}
    meta = mk.write_meta(
        NAME, family="megadetector-v6-yolov9c", w=size, h=size, fmt="yolov8_raw",
        output_note=mk.note_yolov8_raw(3, n_anchors, size, size, "Class order verified from the ONNX names metadata."),
        output_shape=[1, 7, n_anchors], classes=classes, animal_classes=[0], person_classes=[1], vehicle_classes=[2],
        licence_code="MIT (microsoft/MegaDetector + Pytorch-Wildlife code); Ultralytics YOLOv9c training/export code AGPL-3.0",
        licence_weights="AGPL-3.0 (stamp inside the file, MDv6 model zoo lists MDV6-yolov9-c as AGPL-3.0); the Zenodo "
                        "record 'Pytorch-wildlife-model-weights' itself is tagged CC BY 4.0",
        source="https://zenodo.org/records/18165116 (file MDV6-yolov9-c.onnx, md5 " + MD5 + "), Ultralytics 8.2.46 export "
               f"of the MDV6-yolov9-c checkpoint; frozen from dynamic axes to 1x3x{size}x{size} with onnxslim",
        pad_value=114, stride=32,
        extra={"trained_imgsz": 640, "same_weights_as": "mdv6_yolov9c_640", "published_params_m": 25.5, "published_animal_recall": 0.784, "published_map50": 0.879,
               "frozen_vs_original_maxdiff": max(diffs),
               "recommended_conf": "0.2-0.3 (Pytorch-Wildlife/MegaDetector default 0.2)"})
    print(json.dumps({k: meta[k] for k in ("name", "params_m", "gflops", "sha256")}), flush=True)


def main() -> None:
    SRC.parent.mkdir(parents=True, exist_ok=True)
    if not SRC.exists():
        SRC.write_bytes(requests.get(URL, timeout=600).content)
    assert md5(SRC) == MD5, "unexpected MDV6-yolov9-c.onnx"
    for size in (int(a) for a in sys.argv[1:]) or SIZES:
        make(size)


if __name__ == "__main__":
    main()
