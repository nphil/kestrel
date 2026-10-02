#!/usr/bin/env python3
"""Turn proof/result-<label>/results.json into the tables for the report.

usage: report.py gpu [cpu ...]
"""
import json
import statistics
import sys

BASE = "/data/home/Kestrel/audio-eval/preview_eval/proof"


def centre(a, b):
    return (a + b) / 2.0


def classify(rows):
    out = []
    for r in rows:
        ev_clean = r["eval_pick"] != "orig"
        sv_clean = bool(r["cleaned"])
        seg = r.get("segment") or {}
        es, ee = r["eval_segment"]
        dc = abs(centre(seg["start"], seg["end"]) - centre(es, ee)) if seg else None
        same_variant = (not ev_clean and not sv_clean) or (ev_clean and sv_clean and r["variant"] == r["eval_pick"])
        sc = r.get("scores") or {}
        regress = None
        if sc.get("original") is not None and sc.get("preview") is not None:
            regress = round(sc["preview"] - sc["original"], 4)
        out.append(dict(r, ev_clean=ev_clean, sv_clean=sv_clean, same_kind=ev_clean == sv_clean, same_variant=same_variant,
                        seg_same=bool(seg) and seg["start"] == es and seg["end"] == ee, centre_dist=None if dc is None else round(dc, 2),
                        perch_delta=regress))
    return out


def one(label):
    d = json.load(open(f"{BASE}/result-{label}/results.json"))
    rows = classify(d["rows"])
    s = d["summary"]
    n = len(rows)
    ok = [r for r in rows if r["state"] == "ready"]
    print(f"\n=== {label}: {len(ok)}/{n} ready, {s['failed']} failed, {s['cleaned']} cleaned by the service ({sum(r['ev_clean'] for r in rows)} by the evaluation)")
    print(f"same kind of result (cleaned vs untouched) as the evaluation: {sum(r['same_kind'] for r in ok)}/{len(ok)}")
    print(f"same variant (untouched==untouched, or the same clean-up id): {sum(r['same_variant'] for r in ok)}/{len(ok)}")
    print(f"segment identical: {sum(r['seg_same'] for r in ok)}/{len(ok)}   centres within 1 s: {sum(1 for r in ok if r['centre_dist'] is not None and r['centre_dist'] <= 1.0)}/{len(ok)}"
          f"   IoU >= 0.5: {sum(1 for r in ok if (r['seg_iou'] or 0) >= 0.5)}/{len(ok)}")
    bad = [r for r in ok if r["perch_delta"] is not None and r["perch_delta"] < -0.02]
    print(f"previews that Perch likes LESS than the untouched moment by more than 0.02: {len(bad)}  {[r['name'] for r in bad]}")
    cl = [r for r in ok if r["sv_clean"]]
    if cl:
        print("cleaned previews (Perch preview - original): " + ", ".join(f"{r['name'].rsplit('_', 1)[0]} {r['variant']} {r['perch_delta']:+.3f}" for r in cl))
    w = [r["wall_s"] for r in ok]
    if w:
        print(f"wall per clip: median {statistics.median(w):.1f}s  min {min(w):.1f}  max {max(w):.1f}   total {s['total_wall_s']}s   [PROVISIONAL unless load<8: before {s['load_before'][0]}, after jobs {s['load_after_jobs'][0]}]")
    print(f"devices: {s['devices_seen']}  modes seen: {s['modes_seen']}")
    vp = [r["vramPeakMiBSelf"] for r in ok if r.get("vramPeakMiBSelf") is not None]
    hv = [r["host_peak_vram_mib"] for r in ok]
    hr = [r["host_resident_vram_mib"] for r in ok if r.get("host_resident_vram_mib", -1) >= 0]
    if hr:
        print(f"GPU memory resident between clips (host-measured): median {statistics.median(hr):.0f} MiB, min {min(hr)}, max {max(hr)}")
    print(f"GPU memory: host-measured peak {max(hv) if hv else None} MiB (container total), self-reported peak max {max(vp) if vp else None} MiB; "
          f"resident-after-job {sorted({r['vramMiBEnd'] for r in ok if r.get('vramMiBEnd') is not None})} MiB; after idle unload {s['vram_after_unload_mib']} MiB; "
          f"unloaded after {None if s['idle_unload_after_s'] is None else round(s['idle_unload_after_s'])}s of quiet")
    print(f"container RAM peak {s.get('container_ram_peak_mib')} MiB (cap 4096), CPU peak {s.get('container_cpu_peak_pct')}%, RAM after unload {s.get('container_ram_idle_after_unload_mib')} MiB")
    tm = {}
    for r in ok:
        for k, v in (r.get("timings") or {}).items():
            tm.setdefault(k, []).append(v)
    if tm:
        print("median stage seconds: " + ", ".join(f"{k} {statistics.median(v):.1f}" for k, v in tm.items()))
    print("\n| # | clip | evaluation | service | seg (service vs eval) | IoU | Perch orig→preview | wall s | GPU MiB peak |")
    print("|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows):
        seg = r.get("segment") or {}
        sc = r.get("scores") or {}
        print(f"| {i} | {r['name'].rsplit('_', 1)[0]} | {r['eval_pick']} | {r['variant']}{'' if r['state'] == 'ready' else ' FAILED'} | "
              f"{seg.get('start')}-{seg.get('end')} vs {r['eval_segment'][0]}-{r['eval_segment'][1]} | {r['seg_iou']} | "
              f"{sc.get('original')}→{sc.get('preview')} | {r['wall_s']} | {r['host_peak_vram_mib']} |")
    json.dump({"summary": s, "rows": rows}, open(f"{BASE}/result-{label}/classified.json", "w"), indent=1)


for lab in sys.argv[1:]:
    one(lab)
