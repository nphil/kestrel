#!/usr/bin/env python3
"""Collect everything measured about models/<name>/ and fill the tables of research/models-report.md.

Reads  research/models-report.src.md (hand-written text with the placeholders {{TABLE_MAIN}} {{TABLE_INAT}} {{TABLE_SIZES}}
       {{TABLE_FAILED}} {{COUNTS}}) and per-model files: meta.json, bench_cpu.json, bench_p40.json, bench_p40_paused.json,
       plugin_check.json, inat_squash.json
Writes research/models-report.md and models/summary.json (one record per model; machine readable).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "models"

LIC = {   # name prefix -> (code, weights) short forms
    "scrypted_": ("GPL-3.0 arch (YOLOv9); Scrypted code n/a", "MIT (HF card)"),
    "mdv6_": ("MIT + Ultralytics AGPL-3.0", "AGPL-3.0"),
    "mdv1000_cedar": ("GPL-3.0 (yolov9 repo)", "unstated (repo MIT)"),
    "mdv1000_sorrel": ("AGPL-3.0 (Ultralytics)", "AGPL-3.0 stamp"),
    "mdv1000_larch": ("AGPL-3.0 (Ultralytics)", "AGPL-3.0 stamp"),
    "mdv1000_redwood": ("GPL-3.0 (yolov5 v7.0)", "unstated (repo MIT)"),
    "mdv1000_spruce": ("GPL-3.0 (yolov5 v7.0)", "unstated (repo MIT)"),
    "mdv5a": ("GPL-3.0 (yolov5 v7.0)", "MIT (MegaDetector repo)"),
    "yoloworld": ("AGPL-3.0 (Ultralytics), GPL-3.0 upstream, CLIP MIT", "AGPL-3.0"),
    "yolo11": ("AGPL-3.0", "AGPL-3.0"),
    "yolov8": ("AGPL-3.0", "AGPL-3.0"),
    "yolov9c_coco": ("AGPL-3.0 (port), GPL-3.0 upstream", "AGPL-3.0 (upstream GPL-3.0)"),
}


def lic(name: str) -> tuple[str, str]:
    for k, v in LIC.items():
        if name.startswith(k):
            return v
    return ("?", "?")


def jload(p: Path):
    return json.loads(p.read_text()) if p.exists() else None


def fmt_e(x: float | None) -> str:
    return "-" if x is None else f"{x:.1e}".replace("e-0", "e-").replace("e+0", "e+")


def inat_timing(d: Path):
    """ORT-run p50 / p95 in ms during the iNat sweep (P40, idle daemon active, 1170 images) or None."""
    f = d / "inat_squash_timing.txt"
    if not f.exists():
        return None
    try:
        t = json.loads(f.read_text().split("timing:", 1)[1].split("|")[0].strip())
        return {"p50": t["ort_ms_p50"], "p95": t["ort_ms_p95"]}
    except Exception:
        return None


def collect() -> list[dict]:
    out = []
    for d in sorted(MODELS.iterdir()):
        if not (d / "meta.json").exists() or not (d / "model.onnx").exists() or d.name.startswith("kestrel_"):
            continue                      # kestrel_* folders are DetectorAgent's fused test models, not part of this library
        m = jload(d / "meta.json")
        r = {"name": m["name"], "meta": m, "cpu": jload(d / "bench_cpu.json"), "p40": jload(d / "bench_p40.json"),
             "p40_paused": jload(d / "bench_p40_paused.json"), "plugin": jload(d / "plugin_check.json"),
             "inat": jload(d / "inat_squash.json"), "inat_ms": inat_timing(d)}
        out.append(r)
    return out


def order_key(r: dict):
    n = r["name"]
    fam = ("scrypted_" if n.startswith("scrypted_") else "mdv6_yolov9c_" if n.startswith("mdv6_yolov9c_") and "1280" not in n else
           "mdv1000_cedar" if n.startswith("mdv1000_cedar") else "mdv6_other" if n.startswith("mdv6_") else
           "mdv1000_other" if n.startswith("mdv1000_") else "mdv5a" if n.startswith("mdv5a") else
           "yoloworld" if n.startswith("yoloworld") else "coco")
    fams = ["scrypted_", "mdv6_yolov9c_", "mdv1000_cedar", "mdv6_other", "mdv1000_other", "mdv5a", "coco", "yoloworld"]
    return (fams.index(fam), r["meta"]["gflops"], n)


def conv_text(r: dict) -> str:
    m = r["meta"]
    fmt = m["output"]["format"]
    if m.get("converted_from"):
        return f"done: converted from `{m['converted_from']}` (top-k step removed)"
    if fmt == "yolov8_raw":
        if m["name"].startswith("yoloworld"):
            return "none for loading; NVR drops non-alias class names -> rename ONNX `names` (all animals -> `animal`)"
        if m["name"].startswith("yolo") and "coco" in m["name"]:
            return "none (NVR maps bird/cat/dog.. to animal)"
        if m["input"]["w"] != 320 and not m["name"].startswith("scrypted"):
            return "none; model dir must be loadable by the patched plugin"
        return "none"
    if fmt == "yolov5_raw":
        return "remap [1,N,5+nc] -> [1,4+nc,N] with score=obj*cls (done in `mdv5a_1280_v8fmt`)" if "mdv5a" in m["name"] else "same remap"
    if fmt == "end2end_xyxy":
        c = m["name"] + "_v8fmt"
        return f"re-export head without top-k -> `{c}`" + (" (done)" if (MODELS / c).exists() else "")
    return "?"


def main_table(rows: list[dict]) -> str:
    h = ("| model | input | classes | params M / GFLOPs | licence: code / weights | CPU ms (6 thr, median [min]) | P40 ms: active, continuous / after 2 s idle | "
         "P40 ms: daemon paused | P40 VRAM MB | parity vs PyTorch: max |Δ| scores / boxes px | runs in Scrypted plugin as-is? | conversion needed |\n"
         "|---|---|---|---|---|---|---|---|---|---|---|---|\n")
    lines = []
    for r in sorted(rows, key=order_key):
        m = r["meta"]
        nc = len(m["classes"])
        cls = ("3: " + "/".join(m["classes"].values())) if nc <= 3 else (f"{nc} COCO (animals 14-23)" if "coco" in m["name"] else f"{nc}: vocabulary")
        cpu = r["cpu"]
        cpu_s = f"{cpu['median_ms']:.0f} [{cpu['min_ms']:.0f}]" if cpu else ("cap (>4 GB)" if m["gflops"] > 500 else "-")
        p = r["p40"]
        if p and "real" in p:
            act = f"{p['real']['median_ms']:.1f}" + (f" / {p['sporadic']['median_ms']:.0f}" if p.get("sporadic") else "")
            vram = str(p.get("peak_process_vram_mib", "-"))
        elif p and p.get("failed"):
            act, vram = "does not fit 1 GB", "> 1024"
        elif r["inat_ms"]:
            act, vram = f"{r['inat_ms']['p50']:.1f} (p50 during iNat run)", "-"
        else:
            act, vram = "-", "-"
        pp = r["p40_paused"]
        pau = f"{pp['real']['median_ms']:.1f}" if pp and "real" in pp else "-"
        par = m.get("parity")
        if par:
            pars = f"{fmt_e(par['max_abs_diff_scores'])} / {par['max_abs_diff_boxes_px']:.4f}"
        elif m.get("frozen_vs_original_maxdiff") is not None:
            pars = f"0 (frozen == published ONNX, bit-exact)" if m["frozen_vs_original_maxdiff"] == 0 else f"{m['frozen_vs_original_maxdiff']:.1e} (frozen vs published)"
        else:
            g = p.get("gpu_vs_cpu_real") if p else None
            pars = f"n/a (copied as-is; GPU vs CPU {fmt_e(g['max_abs_diff_scores'])})" if g else "n/a (copied as-is)"
        pl = r["plugin"]
        plug = "-" if not pl else ("**yes**" if pl.get("runs_as_is") else "no")
        cl = lic(m["name"])
        lines.append(f"| `{m['name']}` | {m['input']['w']}x{m['input']['h']} | {cls} | {m['params_m']} / {m['gflops']} | {cl[0]} / {cl[1]} | {cpu_s} | {act} | {pau} | {vram} | {pars} | {plug} | {conv_text(r)} |")
    return h + "\n".join(lines) + "\n"


def inat_table(rows: list[dict]) -> str:
    h = ("| model | input | clean birds | clean mammals | camera birds | camera mammals | night birds | night mammals |\n"
         "|---|---|---|---|---|---|---|---|\n")
    lines = []
    for r in sorted(rows, key=order_key):
        it = r["inat"]
        if not it:
            continue
        res = it["results"]

        def cell(k):
            c = res.get(k)
            return f"{c['>=0.7']:.2f} / {c['>=0.5']:.2f} / {c['>=0.2']:.2f}" if c else "-"
        m = r["meta"]
        lines.append(f"| `{m['name']}` | {m['input']['w']} | " + " | ".join(cell(f"{v}/{g}") for v in ("clean", "camera", "night") for g in ("Birds", "Mammals")) + " |")
    return h + "\n".join(lines) + "\n"


def sizes_table(rows: list[dict]) -> str:
    by = {r["name"]: r for r in rows}
    h = "| input | " + " | ".join(f"{f}" for f in ("mdv6_yolov9c: ms / GFLOPs / clean birds@.7 / mammals@.7", "cedar: ms / GFLOPs / clean birds@.7 / mammals@.7")) + " |\n|---|---|---|\n"
    lines = []
    for s in (320, 384, 448, 512, 640):
        cells = []
        for fam in ("mdv6_yolov9c", "mdv1000_cedar"):
            r = by.get(f"{fam}_{s}")
            if not r:
                cells.append("-")
                continue
            p = r["p40"]
            ms = f"{p['real']['median_ms']:.1f}" if p and "real" in p else (f"{r['inat_ms']['p50']:.1f}" if r["inat_ms"] else "-")
            it = r["inat"]["results"] if r["inat"] else None
            b = f"{it['clean/Birds']['>=0.7']:.2f}" if it else "-"
            mm = f"{it['clean/Mammals']['>=0.7']:.2f}" if it else "-"
            cells.append(f"{ms} ms / {r['meta']['gflops']} / {b} / {mm}")
        lines.append(f"| {s} | " + " | ".join(cells) + " |")
    return h + "\n".join(lines) + "\n"


def main() -> None:
    rows = collect()
    summary = [{"name": r["name"], "format": r["meta"]["output"]["format"], "input": r["meta"]["input"]["w"], "params_m": r["meta"]["params_m"],
                "gflops": r["meta"]["gflops"], "cpu_median_ms": (r["cpu"] or {}).get("median_ms"),
                "p40_median_ms": ((r["p40"] or {}).get("real") or {}).get("median_ms"),
                "p40_paused_median_ms": ((r["p40_paused"] or {}).get("real") or {}).get("median_ms"),
                "p40_vram_mib": (r["p40"] or {}).get("peak_process_vram_mib"),
                "plugin_as_is": (r["plugin"] or {}).get("runs_as_is"), "inat": (r["inat"] or {}).get("results")} for r in rows]
    (MODELS / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    src = ROOT / "research/models-report.src.md"
    if not src.exists():
        print("no report source yet; wrote models/summary.json only")
        return
    failed = [r for r in rows if r["p40"] and r["p40"].get("failed")]
    txt = src.read_text()
    txt = txt.replace("{{COUNTS}}", f"{len(rows)} model folders")
    txt = txt.replace("{{TABLE_MAIN}}", main_table(rows)).replace("{{TABLE_INAT}}", inat_table(rows)).replace("{{TABLE_SIZES}}", sizes_table(rows))
    txt = txt.replace("{{COUNTS}}", f"{len(rows)} model folders")
    (ROOT / "research/models-report.md").write_text(txt)
    print(f"wrote research/models-report.md ({len(rows)} models)")


if __name__ == "__main__":
    main()
