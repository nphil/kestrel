#!/usr/bin/env python3
"""Compare Perch v2 and BirdNET+ V3.0-dev alone vs. several ways of combining them.

Uses the existing per-clip outputs under data/results/ and score_results.py's own reader, so
every single-model number is computed the same way. The script first checks that its metric
code reproduces score_results.summarize() (and the stored score-summary.json) before it prints
anything about combinations.

Metrics for a "prediction" = (top species, score) per clip:
  top-1       : top species is the recorded species (no threshold).
  precision@t : of clips where the prediction's score >= t, share where species is right.
  recall@t    : right-and-emitted clips / all clips in the band (a missed or wrong clip is a miss).
  emitted@t   : clips where something was emitted at >= t.
  bg FP@t     : emissions on the screened background-only clips (same 25-clip screen as
                score_results.py; there should be no bird there).
"""
from __future__ import annotations

import json
import pathlib
import sys

import score_results as sr

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = sr.RESULTS
BANDS = ("loud", "medium", "faint")
THRESHOLDS = (0.50, 0.70)
PERCH, V24, V3 = "perch-v2", "birdnet-v24", "birdnet-v30-dev"
SWEEP = (0.30, 0.40, 0.50, 0.60, 0.70)
AGREE_MIN = 0.50  # a model "has an opinion" for flag purposes when its top score >= this


# ---------------------------------------------------------------- prediction helpers
def make(scores: dict[str, float]) -> dict:
    if not scores:
        return {"scores": {}, "top_species": None, "top_score": 0.0}
    species, score = max(scores.items(), key=lambda item: item[1])
    return {"scores": scores, "top_species": species, "top_score": score}


def mean_rule(a: dict, b: dict) -> dict:
    keys = a["scores"].keys() | b["scores"].keys()
    return make({k: (a["scores"].get(k, 0.0) + b["scores"].get(k, 0.0)) / 2 for k in keys})


def max_rule(a: dict, b: dict) -> dict:
    keys = a["scores"].keys() | b["scores"].keys()
    return make({k: max(a["scores"].get(k, 0.0), b["scores"].get(k, 0.0)) for k in keys})


def or_rule(threshold: float):
    """Perch first; if Perch is below the threshold, fall back to V3.0 if it clears it."""
    def rule(a: dict, b: dict) -> dict:  # a = Perch, b = V3.0
        if a["top_score"] >= threshold:
            return a
        if b["top_score"] >= threshold:
            return b
        # nobody clears it: return the stronger of the two so top-1 stays comparable
        return a if a["top_score"] >= b["top_score"] else b
    return rule


def agree_boost(a: dict, b: dict) -> dict:
    """Max of the two models, but when both models' top-1 is the same species, combine as
    independent evidence: 1 - (1-a)(1-b). Never lowers a score."""
    scores = {k: max(a["scores"].get(k, 0.0), b["scores"].get(k, 0.0)) for k in a["scores"].keys() | b["scores"].keys()}
    if a["top_species"] and a["top_species"] == b["top_species"]:
        s = a["top_species"]
        scores[s] = 1.0 - (1.0 - a["top_score"]) * (1.0 - b["top_score"])
    return make(scores)


def flags(a: dict, b: dict) -> dict[str, bool]:
    """Disagreement review flags (top-1 species differ)."""
    differ = a["top_species"] != b["top_species"]
    a_on, b_on = a["top_score"] >= AGREE_MIN, b["top_score"] >= AGREE_MIN
    return {
        # both models speak up (>= 0.50) and name different species: a real contradiction
        "contradiction": differ and a_on and b_on,
        # at least one model speaks up (>= 0.50) and the two top-1s differ (includes one silent)
        "any_disagreement": differ and (a_on or b_on),
    }


# ---------------------------------------------------------------- metrics
def rate(n: int, d: int) -> float | None:
    return n / d if d else None


def band_rows(dataset: list[dict], band: str | None) -> list[dict]:
    return [r for r in dataset if r["kind"] == "bird" and (band is None or r["snr_name"] == band)]


def metrics(dataset: list[dict], preds: dict[str, dict], negatives: set[str]) -> dict:
    out: dict = {"top1": {}, "thresholds": {}, "bg_fp": {}}
    for band in (*BANDS, None):
        rows = band_rows(dataset, band)
        correct = sum(sr.prediction_for(r["clip_id"], preds)["top_species"] == sr.norm(r["scientific_name"]) for r in rows)
        out["top1"][band or "all"] = {"correct": correct, "total": len(rows), "rate": rate(correct, len(rows))}
    for t in THRESHOLDS:
        per_band = {}
        for band in (*BANDS, None):
            rows = band_rows(dataset, band)
            emitted = right = 0
            for r in rows:
                p = sr.prediction_for(r["clip_id"], preds)
                if p["top_score"] >= t:
                    emitted += 1
                    right += p["top_species"] == sr.norm(r["scientific_name"])
            per_band[band or "all"] = {
                "emitted": emitted, "correct": right, "total": len(rows),
                "precision": rate(right, emitted), "recall": rate(right, len(rows)),
            }
        out["thresholds"][f"{t:.2f}"] = per_band
        fps = sum(sr.prediction_for(c, preds)["top_score"] >= t for c in negatives)
        out["bg_fp"][f"{t:.2f}"] = {"false_positive_clips": fps, "negative_clips": len(negatives)}
    return out


def flag_report(dataset: list[dict], pa: dict, pb: dict, base: dict, negatives: set[str]) -> dict:
    """How many clips each disagreement flag sends to review, and how good the rest is."""
    result = {}
    birds = band_rows(dataset, None)
    for flag_name in ("contradiction", "any_disagreement"):
        flagged, per_band_flagged = [], {b: 0 for b in BANDS}
        for r in birds:
            cid = r["clip_id"]
            if flags(sr.prediction_for(cid, pa), sr.prediction_for(cid, pb))[flag_name]:
                flagged.append(r)
                per_band_flagged[r["snr_name"]] += 1
        flagged_ids = {r["clip_id"] for r in flagged}
        truth = lambda r: sr.norm(r["scientific_name"])
        either_right = sum(
            truth(r) in (sr.prediction_for(r["clip_id"], pa)["top_species"], sr.prediction_for(r["clip_id"], pb)["top_species"])
            for r in flagged
        )
        base_right_flagged = sum(sr.prediction_for(r["clip_id"], base)["top_species"] == truth(r) for r in flagged)
        out_t = {}
        for t in THRESHOLDS:
            # auto-accept = base answer emitted at >= t and NOT flagged
            acc = [r for r in birds if r["clip_id"] not in flagged_ids and sr.prediction_for(r["clip_id"], base)["top_score"] >= t]
            right = sum(sr.prediction_for(r["clip_id"], base)["top_species"] == truth(r) for r in acc)
            out_t[f"{t:.2f}"] = {
                "auto_accepted": len(acc), "correct": right,
                "precision": rate(right, len(acc)), "recall": rate(right, len(birds)),
            }
        neg_flagged = sum(flags(sr.prediction_for(c, pa), sr.prediction_for(c, pb))[flag_name] for c in negatives)
        result[flag_name] = {
            "flagged_bird_clips": len(flagged), "of": len(birds), "by_band": per_band_flagged,
            "flagged_where_either_model_right": either_right,
            "flagged_where_base_answer_right": base_right_flagged,
            "flagged_background_clips": neg_flagged, "background_clips": len(negatives),
            "auto_accept": out_t,
        }
    return result


# ---------------------------------------------------------------- sanity check
def sanity(dataset, preds, negatives) -> None:
    """My metrics must agree with score_results.summarize(), and the stored JSON for the two
    models score_results.py scores."""
    stored = json.loads((RESULTS / "score-summary.json").read_text(encoding="utf-8"))["models"]
    for model in (V24, PERCH, V3):
        ref = sr.summarize(dataset, preds[model], model, negatives)
        mine = metrics(dataset, preds[model], negatives)
        for band in BANDS:
            assert ref["top1_by_snr"][band]["correct"] == mine["top1"][band]["correct"], (model, band)
        for key in ("0.50", "0.70"):
            r, m = ref["thresholds"][key], mine["thresholds"][key]["all"]
            assert r["correct_top1_all"] == m["correct"] and r["emitted_labels"] == m["emitted"], (model, key)
            assert ref["background_false_positive_rate"][key]["false_positive_clips"] == mine["bg_fp"][key]["false_positive_clips"], (model, key)
        if model in stored:
            for band in BANDS:
                assert stored[model]["top1_by_snr"][band]["correct"] == ref["top1_by_snr"][band]["correct"], (model, band, "stored")
            for key in ("0.50", "0.70"):
                assert stored[model]["thresholds"][key]["correct_top1_all"] == ref["thresholds"][key]["correct_top1_all"], (model, key, "stored")
                assert stored[model]["thresholds"][key]["emitted_labels"] == ref["thresholds"][key]["emitted_labels"], (model, key, "stored")
        top1 = [mine["top1"][b]["correct"] for b in BANDS]
        print(f"  sanity OK  {model:18} top-1 correct loud/medium/faint = {top1[0]}/{top1[1]}/{top1[2]}"
              f"  (matches score_results{' + stored JSON' if model in stored else ''})")


# ---------------------------------------------------------------- output
def pct(v: float | None) -> str:
    return "  n/a" if v is None else f"{v * 100:5.1f}"


def main() -> int:
    dataset = sr.read_dataset()
    birds = sr.bird_taxa()
    preds = {m: sr.csv_predictions(m, birds) for m in (V24, PERCH, V3)}
    ids = {r["clip_id"] for r in dataset}
    for m, p in preds.items():
        if ids - p.keys():
            raise SystemExit(f"{m} missing clips")
    # same background screen as score_results.py (v2.4 + Perch agreement at >= 0.70)
    bg_rows = [r for r in dataset if r["kind"] == "background_candidate"]
    negatives = {r["clip_id"] for r in bg_rows}
    for r in bg_rows:
        votes: dict[str, int] = {}
        for m in (V24, PERCH):
            item = sr.prediction_for(r["clip_id"], preds[m])
            if item["top_species"] and item["top_score"] >= sr.SCREEN_CONFIDENCE:
                votes[item["top_species"]] = votes.get(item["top_species"], 0) + 1
        if any(c >= 2 for c in votes.values()):
            negatives.discard(r["clip_id"])
    print(f"Dataset: {len(band_rows(dataset, None))} bird clips, {len(negatives)} screened background clips")
    print("Sanity check against score_results.py:")
    sanity(dataset, preds, negatives)

    all_ids = ids
    P, V = preds[PERCH], preds[V3]
    empty = make({})
    combos: dict[str, dict[str, dict]] = {}
    combos["BirdNET v2.4 alone"] = preds[V24]
    combos["Perch v2 alone"] = P
    combos["V3.0 alone"] = V
    for label, rule in (
        ("Mean(Perch, V3.0)", mean_rule),
        ("Max(Perch, V3.0)", max_rule),
        ("Agree-boost", agree_boost),
        ("OR@0.50 (Perch, else V3.0)", or_rule(0.50)),
        ("OR@0.70 (Perch, else V3.0)", or_rule(0.70)),
    ):
        combos[label] = {c: rule(sr.prediction_for(c, P), sr.prediction_for(c, V)) for c in all_ids}
    results = {name: metrics(dataset, p, negatives) for name, p in combos.items()}

    width = 28
    print("\nTop-1 accuracy (no threshold), % of clips")
    print(f"{'rule':{width}} {'loud':>6} {'medium':>6} {'faint':>6} {'all':>6}")
    for name, r in results.items():
        print(f"{name:{width}} " + " ".join(f"{pct(r['top1'][b]['rate']):>6}" for b in (*BANDS, "all")))
    for t in THRESHOLDS:
        key = f"{t:.2f}"
        print(f"\nPrecision / recall at {key}  (precision = right / spoke up; recall = right / all clips in band)")
        header = f"{'rule':{width}} " + " ".join(f"{b + ' P/R':>13}" for b in (*BANDS, "all")) + f" {'emitted':>8} {'bgFP':>5}"
        print(header)
        for name, r in results.items():
            cells = []
            for b in (*BANDS, "all"):
                c = r["thresholds"][key][b]
                cells.append(f"{pct(c['precision'])}/{pct(c['recall'])}".rjust(13))
            print(f"{name:{width}} " + " ".join(cells) + f" {r['thresholds'][key]['all']['emitted']:>8} {r['bg_fp'][key]['false_positive_clips']:>5}")

    print("\nThreshold sweep (all 483 clips): is a fusion rule better than just moving V3.0's threshold?")
    print(f"{'rule':{width}} " + " ".join(f"{'t=%.2f P/R' % t:>13}" for t in SWEEP) + f" {'bgFP@0.30':>10}")
    sweep_out = {}
    for name in ("Perch v2 alone", "V3.0 alone", "Max(Perch, V3.0)", "Agree-boost", "Mean(Perch, V3.0)"):
        cells, row = [], {}
        for t in SWEEP:
            emitted = right = 0
            for r in band_rows(dataset, None):
                pr = sr.prediction_for(r["clip_id"], combos[name])
                if pr["top_score"] >= t:
                    emitted += 1
                    right += pr["top_species"] == sr.norm(r["scientific_name"])
            row[f"{t:.2f}"] = {"precision": rate(right, emitted), "recall": rate(right, 483), "emitted": emitted}
            cells.append(f"{pct(rate(right, emitted))}/{pct(rate(right, 483))}".rjust(13))
        fp = sum(sr.prediction_for(c, combos[name])["top_score"] >= 0.30 for c in negatives)
        sweep_out[name] = row
        print(f"{name:{width}} " + " ".join(cells) + f" {fp:>10}")

    print("\nTiering with V3.0 as the primary call (emit when V3.0 top score >= 0.50)")
    tiers = {"confirmed (Perch >= 0.50, same species)": lambda a, b: a["top_score"] >= 0.5 and a["top_species"] == b["top_species"],
             "Perch silent (< 0.50)": lambda a, b: a["top_score"] < 0.5,
             "Perch names another species (>= 0.50)": lambda a, b: a["top_score"] >= 0.5 and a["top_species"] != b["top_species"]}
    tier_out = {}
    for tname, test in tiers.items():
        n = right = bgn = 0
        for r in band_rows(dataset, None):
            a, b = sr.prediction_for(r["clip_id"], P), sr.prediction_for(r["clip_id"], V)
            if b["top_score"] >= 0.5 and test(a, b):
                n += 1
                right += b["top_species"] == sr.norm(r["scientific_name"])
        for c in negatives:
            a, b = sr.prediction_for(c, P), sr.prediction_for(c, V)
            bgn += b["top_score"] >= 0.5 and test(a, b)
        tier_out[tname] = {"clips": n, "correct": right, "precision": rate(right, n), "background_clips": bgn}
        print(f"  {tname:42} {n:4} clips, right {right:4}, precision {pct(rate(right, n))}%, background {bgn}/{len(negatives)}")

    print("\nDisagreement -> review flag (Perch vs V3.0 top-1; base answer = Max rule)")
    fr = flag_report(dataset, P, V, combos["Max(Perch, V3.0)"], negatives)
    for name, f in fr.items():
        print(f"  {name}: {f['flagged_bird_clips']}/{f['of']} bird clips flagged "
              f"(loud {f['by_band']['loud']}, medium {f['by_band']['medium']}, faint {f['by_band']['faint']}); "
              f"{f['flagged_background_clips']}/{f['background_clips']} background clips flagged")
        print(f"     among flagged: at least one model right = {f['flagged_where_either_model_right']}, "
              f"Max-rule answer right = {f['flagged_where_base_answer_right']}")
        for key, a in f["auto_accept"].items():
            print(f"     auto-accept (unflagged, Max answer >= {key}): {a['auto_accepted']} clips, "
                  f"precision {pct(a['precision'])}%, recall {pct(a['recall'])}%")

    out = {"rules": results, "review_flags": fr, "threshold_sweep": sweep_out, "v3_primary_tiers": tier_out,
           "definitions": {
               "mean": "per-species mean of Perch and V3.0 scores (missing = 0), top species wins",
               "max": "per-species max of the two scores",
               "or": "use Perch's top-1 if >= threshold, else V3.0's top-1 if >= threshold",
               "agree_boost": "max rule, but if both top-1s are the same species score = 1-(1-a)(1-b)",
               "flag_contradiction": "both models' top score >= 0.50 and top-1 species differ",
               "flag_any_disagreement": "either model's top score >= 0.50 and top-1 species differ",
               "recall": "right-and-emitted clips / all clips in the band",
           }}
    (RESULTS / "fusion-summary.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {RESULTS / 'fusion-summary.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
