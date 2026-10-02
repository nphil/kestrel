#!/usr/bin/env python3
"""Does models/<name>/model.onnx work in Scrypted's ONNX plugin without code changes?

Replays the plugin's own code path (read from /mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/zip/unzipped):
  ort/__init__.py  ONNXPlugin.__init__ : InferenceSession(...); input = get_inputs()[0]; model_dim = input.shape[2];
                   labels = parse_labels(get_modelmeta().custom_metadata_map["names"])   (ast.literal_eval)
  ort/__init__.py  detect_once         : RGB -> BCHW float32 /255, session.run, yolo.parse_yolov9(output[0][0])
  predict/custom_detect.py             : the "custom detection device" path uses the same parse_yolov9 and takes the
                                         input size from a config json instead of the model.
The REAL common/yolo.py is imported (verbatim copy kept in research/plugin-src/, re-fetched over ssh if missing); only
`predict.Prediction` is stubbed because the real package needs the Scrypted runtime.

Verdicts per model: loader ok / fails (why), parse_yolov9 result vs run_model.detect(nms=None, thr=0.2, squash) so a
compatible model must give IDENTICAL detections; plus the reason when it is not compatible.

usage: check_plugin_path.py [model ...]   (default: every model in models/)   -> writes models/<n>/plugin_check.json
"""
from __future__ import annotations

import ast
import importlib.util
import json
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import run_model as rm  # noqa: E402

SRC = ROOT / "research" / "plugin-src"
REMOTE = "/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/zip/unzipped"
IMAGES = [ROOT / "data/truth/raccoon_snap.jpg", ROOT / "data/probe/103_main.jpg",
          ROOT / "data/probe/104_main.jpg", ROOT / "data/probe/106_main.jpg"]


def _fetch(local: str, remote: str) -> Path:
    p = SRC / local
    if not p.exists():
        SRC.mkdir(parents=True, exist_ok=True)
        p.write_bytes(subprocess.run(["ssh", "unraid", f"cat {REMOTE}/{remote}"], check=True, capture_output=True).stdout)
    return p


def _plugin_yolo():
    """Import the plugin's common/yolo.py with a stub `predict` package (Prediction copied from predict/__init__.py)."""
    rect_src = _fetch("rectangle.py", "predict/rectangle.py")
    yolo_src = _fetch("yolo.py", "common/yolo.py")
    pkg = types.ModuleType("predict")
    pkg.__path__ = []
    rect = types.ModuleType("predict.rectangle")
    exec(compile(rect_src.read_text(), str(rect_src), "exec"), rect.__dict__)

    class Prediction:  # verbatim semantics of predict.Prediction (without embeddings)
        def __init__(self, id, score, bbox, embedding=None, clipPaths=None):
            self.id = int(id)
            self.score = float(score)
            self.bbox = rect.Rectangle(float(bbox.xmin), float(bbox.ymin), float(bbox.xmax), float(bbox.ymax))

    pkg.Prediction = Prediction
    pkg.rectangle = rect
    sys.modules["predict"], sys.modules["predict.rectangle"] = pkg, rect
    spec = importlib.util.spec_from_file_location("plugin_yolo", yolo_src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_labels(names):  # verbatim from ort/__init__.py
    j = ast.literal_eval(names)
    ret = {}
    for k, v in j.items():
        ret[int(k)] = v
    return ret


def check(name: str, yolo) -> dict:
    d = rm.MODELS_DIR / name
    meta = json.loads((d / "meta.json").read_text())
    res: dict = {"name": name, "format": meta["output"]["format"]}
    try:
        sess = ort.InferenceSession(str(d / "model.onnx"), providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        model_dim = inp.shape[2]
        res["model_dim"] = model_dim
        res["square_input"] = bool(inp.shape[2] == inp.shape[3])
        labels = parse_labels(sess.get_modelmeta().custom_metadata_map["names"])
        res["labels"] = labels
        res["loader"] = "ok"
    except KeyError as e:
        res["loader"] = f"fails: model has no custom_metadata_map[{e}]"
        return res
    except Exception as e:  # noqa: BLE001
        res["loader"] = f"fails: {type(e).__name__}: {e}"
        return res
    m = rm.load(name)
    same, details = [], []
    imgs = IMAGES[:1] if meta.get("gflops", 0) > 300 else IMAGES[:2] if meta.get("gflops", 0) > 150 else IMAGES   # keep CPU time/RAM sane for the 1280 px models
    conv = meta.get("converted_from")
    mc = rm.load(conv) if conv else None
    for ip in imgs:
        img = Image.open(ip).convert("RGB")
        # --- the plugin's own prepare(): squash to model_dim x model_dim, RGB, /255 ---
        data = img.resize((model_dim, model_dim), Image.BILINEAR)
        im = np.expand_dims(data, axis=0).transpose((0, 3, 1, 2)).astype(np.float32) / 255.0
        out = sess.run(None, {inp.name: np.ascontiguousarray(im)})
        try:
            objs = yolo.parse_yolov9(out[0][0])
            plugin = sorted(((o.id, round(o.score, 4), tuple(round(v, 1) for v in o.bbox)) for o in objs),
                            key=lambda t: (-t[1], t[0]))
        except Exception as e:  # noqa: BLE001
            res["parse_yolov9"] = f"crashes: {type(e).__name__}: {e}"
            return res
        mine = rm.detect(m, img, mode="squash", thr=0.2, nms_iou=None)
        mine_t = sorted(((t["cls"], round(t["score"], 4)) for t in mine), key=lambda t: (-t[1], t[0]))
        plug_t = [(c, s) for c, s, _ in plugin]
        n_bad_boxes = sum(1 for _, s, b in plugin if not all(np.isfinite(b)) or b[2] <= b[0] or b[3] <= b[1])
        same.append(len(plug_t) == len(mine_t) and all(a[0] == b[0] and abs(a[1] - b[1]) < 1e-3 for a, b in zip(plug_t, mine_t)))
        detail = {"image": ip.name, "plugin_detections": len(plugin), "run_model_detections": len(mine),
                  "degenerate_boxes": n_bad_boxes}
        if mc is not None:      # converted (v8fmt) model vs the end-to-end original: same detections at the plugin's 0.2 threshold?
            ref = rm.detect(mc, img, mode="squash", thr=0.2, nms_iou=None)
            ref_t = sorted(((t["cls"], round(t["score"], 3)) for t in ref), key=lambda t: (-t[1], t[0]))
            plug_t3 = sorted(((c, round(s_, 3)) for c, s_, _ in plugin), key=lambda t: (-t[1], t[0]))
            detail["converted_matches_original"] = (len(ref_t) == len(plug_t3) and all(a[0] == b[0] and abs(a[1] - b[1]) < 2e-3 for a, b in zip(ref_t, plug_t3)))
            detail["original_detections"] = len(ref)
        details.append(detail)
    res["images"] = details
    res["parse_matches_run_model"] = all(same)
    if conv:
        res["converted_from"] = conv
        res["converted_matches_original"] = all(d.get("converted_matches_original") for d in details)
    shape_ok = meta["output"]["format"] == "yolov8_raw"
    res["runs_as_is"] = bool(res["loader"] == "ok" and res["square_input"] and shape_ok and all(same))
    if not shape_ok:
        res["why_not"] = ("output format %s is not the [1,4+nc,N] xywh-centre + class-scores layout that "
                          "parse_yolov9(output[0][0]) reads" % meta["output"]["format"])
    return res


def main() -> None:
    names = sys.argv[1:] or rm.list_models()
    yolo = _plugin_yolo()
    for n in names:
        r = check(n, yolo)
        (rm.MODELS_DIR / n / "plugin_check.json").write_text(json.dumps(r, indent=2, default=str) + "\n")
        print(f"{n:34s} loader={r.get('loader')} dim={r.get('model_dim')} fmt={r['format']} "
              f"parse==run_model={r.get('parse_matches_run_model')} runs_as_is={r.get('runs_as_is')} {r.get('why_not', '')}")


if __name__ == "__main__":
    main()
