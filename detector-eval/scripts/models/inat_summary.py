#!/usr/bin/env python3
"""Summarise the iNaturalist smoke test (scripts/inat_gpu.py / inat_quick.py output in data/cache/inat/) per model:
share of photos whose best 'animal'-group detection scores >= 0.7 / 0.5 / 0.3 / 0.2, for clean / camera / night variants
and Birds / Mammals (390 photos: 290 birds, 100 mammals).

The group of a detection comes from the detection's own 'nvr' field when present, else from the model's meta.json
`nvr_class` map (so species-named vocabularies like YOLO-World count too).

usage: inat_summary.py [mode=squash] [model ...]   (default: every model that has a result file)  -> prints a table + writes
models/<name>/inat_<mode>.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data/cache/inat"
MAN = json.loads(Path("/data/home/Kestrel/classifier/data/testset/manifest.json").read_text())
GROUP = {m["file"]: m["group"] for m in MAN}
THR = (0.7, 0.5, 0.3, 0.2)


def rows_for(name: str, mode: str):
    """-> list of (variant, file, [dets]) from whichever result file exists (gpu jsonl preferred, newest wins)."""
    cands = [p for p in (CACHE / f"{name}__{mode}.gpu.jsonl", CACHE / f"{name}__{mode}.json") if p.exists()]
    if not cands:
        return None, None
    p = max(cands, key=lambda q: q.stat().st_mtime)
    out = []
    if p.suffix == ".jsonl":
        for line in open(p):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:      # file still being written
                continue
            v, f = r["key"].split("|")[0].split("/", 1)
            out.append((v, f, r["dets"]))
        if len(out) < 1170:
            return None, None
    else:
        j = json.loads(p.read_text())
        for v, rows in j["rows"].items():
            for g, best, label in rows:     # the cpu script stores only the best animal score per photo
                out.append((v, None, [{"nvr": "animal", "score": best, "_group": g}]))
    return out, p.name


def summarize(name: str, mode: str = "squash") -> dict | None:
    rows, src = rows_for(name, mode)
    if rows is None:
        return None
    meta = json.loads((ROOT / "models" / name / "meta.json").read_text())
    nvr = meta.get("nvr_class", {})
    res: dict = {}
    for v in ("clean", "camera", "night"):
        for g in ("Birds", "Mammals"):
            best = []
            for vv, f, dets in rows:
                if vv != v:
                    continue
                grp = GROUP.get(f) if f else dets[0].get("_group")
                if grp != g:
                    continue
                best.append(max([d["score"] for d in dets if (d.get("nvr") or nvr.get(str(d.get("cls")))) == "animal"], default=0.0))
            if best:
                res[f"{v}/{g}"] = {f">={t}": round(sum(x >= t for x in best) / len(best), 3) for t in THR} | {"n": len(best)}
    out = {"model": name, "mode": mode, "source_file": src, "results": res}
    (ROOT / "models" / name / f"inat_{mode}.json").write_text(json.dumps(out, indent=2) + "\n")
    return out


def main() -> None:
    args = sys.argv[1:]
    mode = "squash"
    if args and args[0] in ("squash", "letterbox"):
        mode, args = args[0], args[1:]
    names = args or sorted({p.name.split("__")[0] for p in CACHE.glob(f"*__{mode}.*") if (ROOT / "models" / p.name.split("__")[0]).exists()})
    print(f"{'model':28s} " + " ".join(f"{v[:3]}/{g[:2]}@.7/.5/.2" for v in ("clean", "camera", "night") for g in ("Birds", "Mammals")))
    for n in names:
        r = summarize(n, mode)
        if not r:
            continue
        cells = []
        for v in ("clean", "camera", "night"):
            for g in ("Birds", "Mammals"):
                c = r["results"].get(f"{v}/{g}")
                cells.append(f"{c['>=0.7']:.2f}/{c['>=0.5']:.2f}/{c['>=0.2']:.2f}" if c else "   -   ")
        print(f"{n:28s} " + "  ".join(cells))


if __name__ == "__main__":
    main()
