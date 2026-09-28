#!/usr/bin/env python3
"""Score per-clip Birda CSVs for accuracy, faint-call detection, negatives, and CPU cost."""
from __future__ import annotations

import csv
import json
import pathlib
import re
import statistics

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = HERE / "data"
RESULTS = DATA / "results"
MODELS = ("birdnet-v24", "perch-v2")
THRESHOLDS = (0.50, 0.70, 0.80)
SCREEN_CONFIDENCE = 0.70
CONSENSUS_PAIR = ("birdnet-v24", "perch-v2")


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().casefold())


def read_dataset() -> list[dict]:
    with (DATA / "dataset.csv").open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def bird_taxa() -> set[str]:
    rows = json.loads((ROOT / "classifier" / "species" / "atlanta.json").read_text(encoding="utf-8"))
    return {norm(row["scientific"]) for row in rows if row.get("group") == "Birds"}


def csv_predictions(model: str, bird_names: set[str]) -> dict[str, dict]:
    folder = RESULTS / model
    if not folder.exists():
        raise SystemExit(f"Missing model output folder: {folder}")
    predictions: dict[str, dict] = {}
    csv_paths = list(folder.rglob("*.csv"))
    if not csv_paths:
        raise SystemExit(f"No Birda CSV output found for {model}.")
    for path in csv_paths:
        name = path.name
        clip_id = name
        for suffix in (".BirdNET.results.csv", ".results.csv", ".csv"):
            if clip_id.endswith(suffix):
                clip_id = clip_id[:-len(suffix)]
                break
        if clip_id.endswith((".m4a", ".aac", ".wav")):
            clip_id = clip_id.rsplit(".", 1)[0]
        if clip_id not in predictions:
            predictions[clip_id] = {"scores": {}, "top_species": None, "top_score": 0.0}
        entry = predictions[clip_id]
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                scientific = row.get("Scientific name") or row.get("scientific_name") or row.get("Scientific Name") or ""
                if not scientific:
                    label = row.get("label") or ""
                    scientific = label.split("_", 1)[0] if label else ""
                confidence = row.get("Confidence") or row.get("confidence") or row.get("Score") or ""
                try:
                    score = float(confidence)
                except (TypeError, ValueError):
                    continue
                if score > 1.0:
                    score /= 100.0
                species = norm(scientific)
                if species not in bird_names:
                    continue
                entry["scores"][species] = max(score, entry["scores"].get(species, 0.0))
        if entry["scores"]:
            species, score = max(entry["scores"].items(), key=lambda item: item[1])
            entry["top_species"] = species
            entry["top_score"] = score
    return predictions


def prediction_for(clip_id: str, all_predictions: dict[str, dict]) -> dict:
    return all_predictions.get(clip_id, {"scores": {}, "top_species": None, "top_score": 0.0})


def ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def summarize(dataset: list[dict], predictions: dict[str, dict], model: str, negative_ids: set[str]) -> dict:
    birds = [row for row in dataset if row["kind"] == "bird"]
    result = {"top1_by_snr": {}, "thresholds": {}, "faint_call_detection": {}, "background_false_positive_rate": {}}
    for snr_name in ("loud", "medium", "faint"):
        group = [row for row in birds if row["snr_name"] == snr_name]
        correct = sum(prediction_for(row["clip_id"], predictions)["top_species"] == norm(row["scientific_name"]) for row in group)
        result["top1_by_snr"][snr_name] = {"correct": correct, "total": len(group), "accuracy": ratio(correct, len(group))}
    for threshold in THRESHOLDS:
        threshold_key = f"{threshold:.2f}"
        emitted = correct_emitted = target_detected = 0
        for row in birds:
            prediction = prediction_for(row["clip_id"], predictions)
            if prediction["top_score"] >= threshold:
                emitted += 1
                correct_emitted += prediction["top_species"] == norm(row["scientific_name"])
            target_detected += prediction["scores"].get(norm(row["scientific_name"]), 0.0) >= threshold
        result["thresholds"][threshold_key] = {
            "correct_top1_all": correct_emitted,
            "all_call_clips": len(birds),
            "top1_accuracy_all": ratio(correct_emitted, len(birds)),
            "emitted_labels": emitted,
            "precision_when_emitted": ratio(correct_emitted, emitted),
        }
        result["faint_call_detection"][threshold_key] = {
            "detected_target_species": sum(
                prediction_for(row["clip_id"], predictions)["scores"].get(norm(row["scientific_name"]), 0.0) >= threshold
                for row in birds if row["snr_name"] == "faint"
            ),
            "faint_clips": sum(row["snr_name"] == "faint" for row in birds),
        }
        result["faint_call_detection"][threshold_key]["rate"] = ratio(
            result["faint_call_detection"][threshold_key]["detected_target_species"],
            result["faint_call_detection"][threshold_key]["faint_clips"],
        )
        fps = sum(prediction_for(clip_id, predictions)["top_score"] >= threshold for clip_id in negative_ids)
        result["background_false_positive_rate"][threshold_key] = {
            "false_positive_clips": fps,
            "screened_negative_clips": len(negative_ids),
            "rate": ratio(fps, len(negative_ids)),
        }
    return result


def consensus_metrics(dataset: list[dict], prediction_by_model: dict[str, dict], negative_ids: set[str]) -> dict:
    left_name, right_name = CONSENSUS_PAIR

    def combine(clip_id: str) -> dict:
        left = prediction_for(clip_id, prediction_by_model[left_name])
        right = prediction_for(clip_id, prediction_by_model[right_name])
        if left["top_species"] and left["top_species"] == right["top_species"]:
            return {"species": left["top_species"], "score": min(left["top_score"], right["top_score"])}
        return {"species": None, "score": 0.0}

    birds = [row for row in dataset if row["kind"] == "bird"]
    result = {"pair": [left_name, right_name], "top1_by_snr": {}, "thresholds": {}, "faint_call_detection": {}, "background_false_positive_rate": {}}
    for snr_name in ("loud", "medium", "faint"):
        group = [row for row in birds if row["snr_name"] == snr_name]
        correct = sum(combine(row["clip_id"])["species"] == norm(row["scientific_name"]) for row in group)
        emitted = sum(combine(row["clip_id"])["species"] is not None for row in group)
        result["top1_by_snr"][snr_name] = {"correct": correct, "total": len(group), "accuracy_all": ratio(correct, len(group)), "emitted": emitted, "precision_when_emitted": ratio(correct, emitted)}
    for threshold in THRESHOLDS:
        key = f"{threshold:.2f}"
        selected = [combine(row["clip_id"]) for row in birds]
        emitted = [item for item in selected if item["score"] >= threshold]
        correct = sum(item["species"] == norm(row["scientific_name"]) for item, row in zip(selected, birds) if item["score"] >= threshold)
        result["thresholds"][key] = {"correct": correct, "all_call_clips": len(birds), "accuracy_all": ratio(correct, len(birds)), "emitted": len(emitted), "precision_when_emitted": ratio(correct, len(emitted))}
        detected_faint = sum(
            item["species"] == norm(row["scientific_name"]) and item["score"] >= threshold
            for item, row in zip(selected, birds)
            if row["snr_name"] == "faint"
        )
        faint_count = sum(row["snr_name"] == "faint" for row in birds)
        result["faint_call_detection"][key] = {
            "detected_target_species": detected_faint,
            "faint_clips": faint_count,
            "rate": ratio(detected_faint, faint_count),
        }
        fps = sum(combine(clip_id)["score"] >= threshold for clip_id in negative_ids)
        result["background_false_positive_rate"][key] = {"false_positive_clips": fps, "screened_negative_clips": len(negative_ids), "rate": ratio(fps, len(negative_ids))}
    return result


def main() -> int:
    dataset = read_dataset()
    clip_ids = [row["clip_id"] for row in dataset]
    if len(clip_ids) != len(set(clip_ids)):
        raise SystemExit("Dataset contains duplicate clip IDs; rebuild it before scoring.")
    audio_paths = [row["path"] for row in dataset]
    if len(audio_paths) != len(set(audio_paths)):
        raise SystemExit("Dataset reuses audio files across clips; rebuild it before scoring.")
    bird_names = bird_taxa()
    predictions = {model: csv_predictions(model, bird_names) for model in MODELS}
    expected_ids = set(clip_ids)
    for model, model_predictions in predictions.items():
        missing = expected_ids - model_predictions.keys()
        if missing:
            raise SystemExit(f"{model} is missing predictions for {len(missing)} dataset clip(s); check the result filenames.")
    background_rows = [row for row in dataset if row["kind"] == "background_candidate"]
    negative_ids = {row["clip_id"] for row in background_rows}
    excluded_as_probable_bird = []
    for row in background_rows:
        clip_id = row["clip_id"]
        votes: dict[str, int] = {}
        for model in MODELS:
            item = prediction_for(clip_id, predictions[model])
            if item["top_species"] and item["top_score"] >= SCREEN_CONFIDENCE:
                votes[item["top_species"]] = votes.get(item["top_species"], 0) + 1
        if any(count >= 2 for count in votes.values()):
            negative_ids.discard(clip_id)
            excluded_as_probable_bird.append(clip_id)
    per_model = {model: summarize(dataset, predictions[model], model, negative_ids) for model in MODELS}
    summary = {
        "models": per_model,
        "consensus": consensus_metrics(dataset, predictions, negative_ids),
        "background_screen": {
            "rule": f"exclude a background clip if any two models agree on a local bird at >= {SCREEN_CONFIDENCE:.2f}",
            "candidate_clips": len(background_rows),
            "excluded_as_probable_bird": len(excluded_as_probable_bird),
            "screened_negative_clips": len(negative_ids),
            "note": "Model-screened candidates are not human-verified ground truth.",
        },
        "dataset": {
            "bird_clips": sum(row["kind"] == "bird" for row in dataset),
            "bird_clips_by_snr": {name: sum(row["kind"] == "bird" and row["snr_name"] == name for row in dataset) for name in ("loud", "medium", "faint")},
            "background_candidates": len(background_rows),
            "distinct_target_species": len({row["scientific_name"] for row in dataset if row["kind"] == "bird"}),
        },
        "cpu": json.loads((RESULTS / "timings.json").read_text(encoding="utf-8")) if (RESULTS / "timings.json").exists() else {},
    }
    (RESULTS / "score-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Species recordings: {summary['dataset']['distinct_target_species']} species; {summary['dataset']['bird_clips']} AAC mixes.")
    print(f"Camera background candidates: {len(background_rows)}; {len(excluded_as_probable_bird)} screened as likely bird-positive; {len(negative_ids)} remain.")
    print("Model                 top1 loud / medium / faint    faint target detected @0.50    background FP @0.80")
    for model in MODELS:
        data = per_model[model]
        accuracies = [data['top1_by_snr'][x]['accuracy'] for x in ('loud', 'medium', 'faint')]
        rates = data['faint_call_detection']['0.50']['rate']
        fp = data['background_false_positive_rate']['0.80']['rate']
        fmt = lambda value: "n/a" if value is None else f"{value:.1%}"
        print(f"{model:20} {fmt(accuracies[0]):>7} / {fmt(accuracies[1]):>7} / {fmt(accuracies[2]):>7}              {fmt(rates):>7}                     {fmt(fp):>7}")
    consensus = summary["consensus"]
    consensus_accuracy = [consensus["top1_by_snr"][name]["accuracy_all"] for name in ("loud", "medium", "faint")]
    consensus_faint = consensus["faint_call_detection"]["0.50"]["rate"]
    consensus_fp = consensus["background_false_positive_rate"]["0.80"]["rate"]
    print(f"V2.4+Perch agree       {fmt(consensus_accuracy[0]):>7} / {fmt(consensus_accuracy[1]):>7} / {fmt(consensus_accuracy[2]):>7}              {fmt(consensus_faint):>7}                     {fmt(consensus_fp):>7}")
    cpu = summary['cpu']
    print("CPU seconds per minute of audio:")
    for model in MODELS:
        item = cpu.get('models', {}).get(model, {})
        print(f"  {model}: {item.get('cpu_seconds_per_minute', 'n/a')}")
    (RESULTS / "score-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
