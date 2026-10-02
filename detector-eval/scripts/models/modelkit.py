"""Shared helpers for building models/<name>/ folders (meta.json contract, ONNX statistics).

Used by the export_*.py / make_*.py scripts in this folder. Pure python + onnx + numpy.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import onnx
from onnx import shape_inference

ROOT = Path(__file__).resolve().parents[2]          # detector-eval/
MODELS = ROOT / "models"

COCO80 = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster",
    "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]
COCO_ANIMALS = list(range(14, 24))            # bird cat dog horse sheep cow elephant bear zebra giraffe
COCO_PERSON = [0]
COCO_VEHICLES = [1, 2, 3, 5, 7]               # bicycle car motorcycle bus truck


def sha256_file(path: str | Path, bufsize: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(bufsize):
            h.update(chunk)
    return h.hexdigest()


def _shape_of(vi) -> list[int] | None:
    dims = vi.type.tensor_type.shape.dim
    out = []
    for d in dims:
        if d.dim_value:
            out.append(d.dim_value)
        else:
            return None
    return out


def onnx_stats(path: str | Path) -> dict:
    """Parameter count (sum of all initializer elements = after BN folding) and GFLOPs.

    GFLOPs = 2 x multiply-accumulates of Conv + MatMul + Gemm nodes (the same convention Ultralytics prints),
    at the model's static input size. Elementwise / pooling / resize ops are ignored.
    """
    m = onnx.load(str(path), load_external_data=False)
    g = m.graph
    params = 0
    inits = {}
    for t in g.initializer:
        inits[t.name] = t
        params += int(np.prod(t.dims)) if len(t.dims) else 1
    mi = shape_inference.infer_shapes(m)
    shapes = {}
    for vi in list(mi.graph.value_info) + list(mi.graph.input) + list(mi.graph.output):
        s = _shape_of(vi)
        if s is not None:
            shapes[vi.name] = s
    for t in g.initializer:
        shapes[t.name] = list(t.dims)
    macs = 0
    unknown = 0
    for n in g.node:
        if n.op_type == "Conv":
            w = shapes.get(n.input[1])
            o = shapes.get(n.output[0])
            if w is None or o is None:
                unknown += 1
                continue
            group = next((a.i for a in n.attribute if a.name == "group"), 1)
            cout, cin_g = w[0], w[1]
            macs += int(np.prod(o[2:])) * cout * cin_g * int(np.prod(w[2:]))
        elif n.op_type in ("MatMul", "Gemm"):
            a = shapes.get(n.input[0])
            b = shapes.get(n.input[1])
            o = shapes.get(n.output[0])
            if a is None or b is None or o is None:
                unknown += 1
                continue
            if n.op_type == "Gemm":
                ta = next((x.i for x in n.attribute if x.name == "transA"), 0)
                k = a[0] if ta else a[-1]
            else:
                k = a[-1]
            macs += int(np.prod(o)) * k
    return {"params_m": round(params / 1e6, 3), "gflops": round(2 * macs / 1e9, 2), "unshaped_nodes": unknown}


def read_io(path: str | Path) -> dict:
    m = onnx.load(str(path), load_external_data=False)
    g = m.graph
    init = {t.name for t in g.initializer}
    ins = [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in g.input if i.name not in init]
    outs = [(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim]) for o in g.output]
    meta = {e.key: e.value for e in m.metadata_props}
    return {"inputs": ins, "outputs": outs, "metadata": meta,
            "opset": max((o.version for o in m.opset_import if o.domain in ("", "ai.onnx")), default=None),
            "producer": f"{m.producer_name} {m.producer_version}".strip()}


def write_meta(name: str, *, family: str, w: int, h: int, fmt: str, output_note: str, output_shape: list[int],
               classes: dict[int, str], animal_classes: list[int], person_classes: list[int],
               vehicle_classes: list[int], licence_code: str, licence_weights: str, source: str,
               pad_value: int = 114, stride: int = 32, extra: dict | None = None) -> dict:
    d = MODELS / name
    onnx_path = d / "model.onnx"
    st = onnx_stats(onnx_path)
    meta = {
        "name": name,
        "family": family,
        "input": {"w": w, "h": h, "layout": "NCHW", "range": "0-1", "color": "RGB", "name": None},
        "output": {"format": fmt, "shape": output_shape, "note": output_note},
        "classes": {str(k): v for k, v in sorted(classes.items())},
        "animal_classes": animal_classes,
        "animal_class_names": [classes[i] for i in animal_classes],
        "person_classes": person_classes,
        "vehicle_classes": vehicle_classes,
        "nvr_class": nvr_class_map(classes, animal_classes, person_classes, vehicle_classes),
        "licence": f"code: {licence_code}; weights: {licence_weights}",
        "licence_code": licence_code,
        "licence_weights": licence_weights,
        "source": source,
        "sha256": sha256_file(onnx_path),
        "size_mb": round(os.path.getsize(onnx_path) / 1e6, 1),
        "params_m": st["params_m"],
        "gflops": st["gflops"],
        "pad_value": pad_value,
        "stride": stride,
    }
    io = read_io(onnx_path)
    meta["input"]["name"] = io["inputs"][0][0]
    meta["output"]["name"] = io["outputs"][0][0]
    meta["onnx"] = {"opset": io["opset"], "producer": io["producer"]}
    if extra:
        meta.update(extra)
    (d / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def add_onnx_metadata(path: str | Path, props: dict) -> None:
    """Set metadata_props on an onnx file in place (values are stringified; existing keys are replaced)."""
    m = onnx.load(str(path))
    keep = [e for e in m.metadata_props if e.key not in props]
    del m.metadata_props[:]
    for e in keep:
        m.metadata_props.add(key=e.key, value=e.value)
    for k, v in props.items():
        m.metadata_props.add(key=k, value=str(v))
    onnx.save(m, str(path))


def freeze_onnx(src: str | Path, dst: str | Path, input_name: str, shape: list[int]) -> None:
    """Turn a dynamic-axes onnx into a static-shape one (constant-folds the shape arithmetic with onnxslim)
    and keep the original metadata_props."""
    from onnxslim import slim

    orig = onnx.load(str(src), load_external_data=False)
    meta = {e.key: e.value for e in orig.metadata_props}
    slim(str(src), str(dst), input_shapes=[f"{input_name}:{','.join(map(str, shape))}"], no_shape_infer=False)
    add_onnx_metadata(dst, meta)


def note_yolov8_raw(nc: int, n: int, w: int, h: int, extra: str = "") -> str:
    return (f"[1, 4+nc, N] float32, nc={nc}, N={n} anchors for the {w}x{h} input. Rows 0-3 = box centre x, centre y, "
            f"width, height in INPUT pixels (0..{w} / 0..{h}); rows 4..{3 + nc} = per-class score already passed "
            f"through sigmoid (no objectness). Box decode (DFL) is inside the graph; NO NMS in the graph. "
            f"Input RGB 0..1, no mean/std. {extra}").strip()


def note_end2end(n: int, w: int, h: int, extra: str = "") -> str:
    return (f"[1, {n}, 6] float32: x1, y1, x2, y2 in INPUT pixels (0..{w} / 0..{h}), score (max class probability), "
            f"class id (float). Fixed {n} rows sorted by score, the top-k selection happens inside the graph (the net is "
            f"NMS-free by design, so no NMS is needed, rows with tiny scores are padding). Input RGB 0..1. {extra}").strip()


def note_yolov5_raw(nc: int, n: int, w: int, h: int, extra: str = "") -> str:
    return (f"[1, N, 5+nc] float32, nc={nc}, N={n} anchors for the {w}x{h} input. Columns 0-3 = box centre x, centre y, "
            f"width, height in INPUT pixels, column 4 = objectness (sigmoid), columns 5.. = per-class probability "
            f"(sigmoid); final score = objectness * class probability. Box decode is inside the graph; NO NMS in the "
            f"graph. Input RGB 0..1. {extra}").strip()


def nvr_class_map(classes: dict[int, str], animal: list[int], person: list[int], vehicle: list[int]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for k in classes:
        out[str(k)] = "animal" if k in animal else "person" if k in person else "vehicle" if k in vehicle else None
    return out


# ----------------------------------------------------------------------------------------------------------------------
# parity helpers (PyTorch reference vs onnxruntime-CPU) shared by the export scripts
# ----------------------------------------------------------------------------------------------------------------------
PARITY_IMAGES = [ROOT / p for p in ("data/truth/raccoon_snap.jpg", "data/probe/103_main.jpg", "data/probe/104_main.jpg",
                                    "data/probe/106_main.jpg")]


def real_tensors(w: int, h: int) -> list[tuple[str, np.ndarray]]:
    """The 4 real camera frames as float32 [1,3,h,w] 0..1 RGB; alternating squash / grey-letterbox so both ways are covered."""
    from PIL import Image

    out = []
    for i, p in enumerate(PARITY_IMAGES):
        im = Image.open(p).convert("RGB")
        if i % 2 == 0:
            canvas = im.resize((w, h), Image.BILINEAR)
            tag = "squash"
        else:
            r = min(w / im.width, h / im.height)
            nw, nh = round(im.width * r), round(im.height * r)
            canvas = Image.new("RGB", (w, h), (114, 114, 114))
            canvas.paste(im.resize((nw, nh), Image.BILINEAR), ((w - nw) // 2, (h - nh) // 2))
            tag = "letterbox"
        x = np.asarray(canvas, dtype=np.uint8).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out.append((f"{p.name}:{tag}", np.ascontiguousarray(x)))
    return out


def compare_outputs(ref: np.ndarray, out: np.ndarray, fmt: str, relevant: float = 0.05) -> dict:
    """max abs differences between the PyTorch reference and the ONNX result of one frame (see models-report.md)."""
    ref = np.asarray(ref, dtype=np.float64)
    out = np.asarray(out, dtype=np.float64)
    assert ref.shape == out.shape, (ref.shape, out.shape)
    res: dict = {}
    if fmt == "yolov8_raw":
        r, o = ref[0], out[0]
        res["max_abs_diff_scores"] = float(np.abs(r[4:] - o[4:]).max())
        res["max_abs_diff_boxes_px_all"] = float(np.abs(r[:4] - o[:4]).max())
        keep = r[4:].max(0) > relevant
        res["n_relevant_anchors"] = int(keep.sum())
        res["max_abs_diff_boxes_px"] = float(np.abs(r[:4][:, keep] - o[:4][:, keep]).max()) if keep.any() else 0.0
        res["max_score"] = float(r[4:].max())
    elif fmt == "yolov5_raw":
        r, o = ref[0], out[0]
        sr, so = r[:, 5:] * r[:, 4:5], o[:, 5:] * o[:, 4:5]
        res["max_abs_diff_scores"] = float(np.abs(sr - so).max())
        res["max_abs_diff_objectness"] = float(np.abs(r[:, 4] - o[:, 4]).max())
        res["max_abs_diff_boxes_px_all"] = float(np.abs(r[:, :4] - o[:, :4]).max())
        keep = sr.max(1) > relevant
        res["n_relevant_anchors"] = int(keep.sum())
        res["max_abs_diff_boxes_px"] = float(np.abs(r[keep, :4] - o[keep, :4]).max()) if keep.any() else 0.0
        res["max_score"] = float(sr.max())
    elif fmt == "end2end_xyxy":
        # rows are top-k sorted by score; near-tied rows may swap order between torch and onnxruntime, so every confident
        # reference row is matched to the closest onnx row of the same class with a score within 1e-3.
        r, o = ref[0], out[0]
        ir, io = np.argsort(-r[:, 4], kind="stable"), np.argsort(-o[:, 4], kind="stable")
        r, o = r[ir], o[io]
        res["max_abs_diff_scores"] = float(np.abs(r[:, 4] - o[:, 4]).max())   # sorted score profile
        k = np.nonzero(r[:, 4] > 0.01)[0]
        res["n_relevant_rows"] = int(len(k))
        worst, unmatched = 0.0, 0
        for i in k:
            cand = np.nonzero((o[:, 5] == r[i, 5]) & (np.abs(o[:, 4] - r[i, 4]) <= 1e-3))[0]
            if len(cand) == 0:
                unmatched += 1
                continue
            worst = max(worst, float(np.abs(o[cand, :4] - r[i, :4]).max(axis=1).min()))
        res["max_abs_diff_boxes_px"] = worst
        res["class_mismatch_rows"] = unmatched          # confident rows with no counterpart (same class, score within 1e-3)
        res["max_score"] = float(r[:, 4].max())
    else:
        raise ValueError(fmt)
    return res


def summarize_parity(per_image: dict[str, dict]) -> dict:
    keys = ("max_abs_diff_scores", "max_abs_diff_boxes_px", "max_abs_diff_boxes_px_all", "max_abs_diff_objectness")
    s = {k: max(v[k] for v in per_image.values() if k in v) for k in keys if any(k in v for v in per_image.values())}
    s["images"] = len(per_image)
    s["max_score_seen"] = max(v["max_score"] for v in per_image.values())
    if any("class_mismatch_rows" in v for v in per_image.values()):
        s["class_mismatch_rows"] = sum(v.get("class_mismatch_rows", 0) for v in per_image.values())
    return s


def try_slim(f: str | Path, w: int, h: int, tens: list[tuple[str, np.ndarray]], refs: list[np.ndarray], fmt: str,
             tol_score: float = 1e-4, tol_box_px: float = 5e-3, threads: int = 4, baseline: dict | None = None) -> dict:
    """Constant-fold the exported graph with onnxslim and keep the result ONLY if it still matches the PyTorch
    reference (max abs diff of scores <= tol_score, of confident boxes <= tol_box_px). Metadata is preserved.
    Returns {"slimmed": bool, "summary": parity summary of the slim candidate, "nodes_before": n, "nodes_after": n}."""
    import contextlib
    import io
    import shutil

    import onnxruntime as ort
    from onnxslim import slim

    f = Path(f)
    cand = f.with_suffix(".slim.onnx")
    orig = onnx.load(str(f), load_external_data=False)
    meta = {e.key: e.value for e in orig.metadata_props}
    with contextlib.redirect_stdout(io.StringIO()):
        slim(str(f), str(cand), input_shapes=[f"{orig.graph.input[0].name}:1,3,{h},{w}"])
    add_onnx_metadata(cand, meta)
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    sess = ort.InferenceSession(str(cand), so, providers=["CPUExecutionProvider"])
    per = {}
    for (tag, x), ref in zip(tens, refs):
        per[tag] = compare_outputs(ref, sess.run(None, {sess.get_inputs()[0].name: x})[0], fmt)
    par = summarize_parity(per)
    if baseline:   # never demand more than the un-slimmed export itself achieves (x1.5)
        tol_score = max(tol_score, 1.5 * baseline["max_abs_diff_scores"])
        tol_box_px = max(tol_box_px, 1.5 * baseline["max_abs_diff_boxes_px"])
    ok = par["max_abs_diff_scores"] <= tol_score and par["max_abs_diff_boxes_px"] <= tol_box_px
    res = {"slimmed": bool(ok), "summary": par, "nodes_before": len(orig.graph.node),
           "nodes_after": len(onnx.load(str(cand), load_external_data=False).graph.node)}
    if ok:
        shutil.move(str(cand), str(f))
    else:
        cand.unlink()
    return res
