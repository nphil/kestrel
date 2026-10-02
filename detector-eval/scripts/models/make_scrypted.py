#!/usr/bin/env python3
"""Tier 1: build models/scrypted_yolov9*_relu[_test]/ from the Scrypted plugin-models HF repo.

The CURRENT production model (scrypted_yolov9c_relu_test) is taken from the Unraid copy that Scrypted loads
(/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/files/hf/...), the other seven are downloaded from
https://huggingface.co/scrypted/plugin-models (onnx/<name>/<name>.onnx). Models are copied byte-for-byte; only
meta.json is written. Re-runnable: existing downloads are reused.
"""
import ast
import shutil
import subprocess
import sys
from pathlib import Path

import onnxruntime as ort
import requests

sys.path.insert(0, str(Path(__file__).parent))
import modelkit as mk  # noqa: E402

NAMES = [
    "scrypted_yolov9c_relu_test", "scrypted_yolov9c_relu",
    "scrypted_yolov9m_relu_test", "scrypted_yolov9m_relu",
    "scrypted_yolov9s_relu_test", "scrypted_yolov9s_relu",
    "scrypted_yolov9t_relu_test", "scrypted_yolov9t_relu",
]
UNRAID_CURRENT = ("/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/files/hf/onnx/scrypted_yolov9c_relu_test/"
                  "onnx/scrypted_yolov9c_relu_test/scrypted_yolov9c_relu_test.onnx")
HF = "https://huggingface.co/scrypted/plugin-models/resolve/main/onnx/{n}/{n}.onnx"
DL = mk.ROOT / "research" / "dl"

NOTE = ("[1, 4+nc, N] float32, nc=3, N=2100=40^2+20^2+10^2 anchors for 320 input (strides 8/16/32). Rows 0-3 = box "
        "centre x, centre y, width, height in INPUT pixels (0..320, so for a squashed crop multiply by crop_w/320 "
        "and crop_h/320); rows 4-6 = per-class score already passed through sigmoid (no objectness). DFL box decode "
        "is inside the graph; NO NMS in the graph and none in Scrypted's plugin (parse_yolov9 keeps every "
        "(anchor, class) score > 0.2). Input RGB 0..1, no mean/std.")


def main() -> None:
    DL.mkdir(parents=True, exist_ok=True)
    for n in NAMES:
        dst_dir = mk.MODELS / n
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / "model.onnx"
        if not dst.exists():
            src = DL / f"{n}.onnx"
            if n == "scrypted_yolov9c_relu_test":
                src = DL / "current_scrypted_yolov9c_relu_test.onnx"
                if not src.exists():
                    subprocess.run(["scp", "-q", f"unraid:{UNRAID_CURRENT}", str(src)], check=True)
            elif not src.exists():
                r = requests.get(HF.format(n=n), timeout=600)
                r.raise_for_status()
                src.write_bytes(r.content)
            shutil.copyfile(src, dst)
        sess = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        out = sess.get_outputs()[0]
        names = ast.literal_eval(sess.get_modelmeta().custom_metadata_map["names"])
        classes = {int(k): v for k, v in names.items()}
        assert inp.shape[2] == inp.shape[3]
        animal = [k for k, v in classes.items() if v == "animal"]
        person = [k for k, v in classes.items() if v == "person"]
        vehicle = [k for k, v in classes.items() if v == "vehicle"]
        mk.write_meta(
            n, family="scrypted-yolov9-relu", w=inp.shape[3], h=inp.shape[2], fmt="yolov8_raw",
            output_note=NOTE, output_shape=list(out.shape), classes=classes, animal_classes=animal,
            person_classes=person, vehicle_classes=vehicle,
            licence_code="YOLOv9 architecture is GPL-3.0 upstream (WongKinYiu/yolov9); Scrypted's ReLU re-implementation/training code not published",
            licence_weights="MIT per the Hugging Face repo card of scrypted/plugin-models (training data undisclosed)",
            source=("https://huggingface.co/scrypted/plugin-models/tree/main/onnx/" + n
                    + (" (identical to the file in use on Unraid, sha256 verified)" if n == "scrypted_yolov9c_relu_test" else "")),
            pad_value=0,
            stride=int(sess.get_modelmeta().custom_metadata_map.get("stride", 32)),
            extra={"scrypted_pad_note": "Scrypted's optional 'pad' setting letterboxes with BLACK (0), default is squash"},
        )
        print(f"{n}: {inp.shape} -> {out.shape} classes={classes}")


if __name__ == "__main__":
    main()
