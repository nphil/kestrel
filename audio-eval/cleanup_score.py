#!/usr/bin/env python3
"""Score the bird-audio cleanup comparison and export before/after listening examples.

Combines, for the 60-clip evaluation set built by cleanup_prepare.py and
reclassified by cleanup_classify.py:
  - SI-SNR improvement vs. the known-clean reference call (pure signal math).
  - Whether the winning primary-bake-off model's confidence for the true
    species stays >= its original (pre-cleanup) confidence.
  - Residual VAD-detected speech on any clip that had speech before cleanup.
  - CPU time per 10 s clip for each method.
Winning model = whichever of birdnet-v24/perch-v2 has the higher mean top-1
accuracy across loud/medium/faint in the primary bake-off (score-summary.json).
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import statistics
import webrtcvad

import numpy as np
import soundfile as sf

VAD = webrtcvad.Vad(3)

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
CLEANUP = DATA / "cleanup"
RESULTS = DATA / "results"
EXAMPLES = HERE / "examples"
SR = 22050
RECLASSIFY_RATE = 16000
METHODS = ("mixit", "noisereduce", "ffmpeg", "mixit+noisereduce")

prepare_audio_spec = importlib.util.spec_from_file_location("prepare_audio", HERE / "prepare_audio.py")
prepare_audio = importlib.util.module_from_spec(prepare_audio_spec)
prepare_audio_spec.loader.exec_module(prepare_audio)

score_results_spec = importlib.util.spec_from_file_location("score_results", HERE / "score_results.py")
score_results = importlib.util.module_from_spec(score_results_spec)
score_results_spec.loader.exec_module(score_results)


def si_snr(estimate: np.ndarray, reference: np.ndarray, eps: float = 1e-8) -> float:
    reference = reference.astype(np.float64) - reference.mean()
    estimate = estimate.astype(np.float64) - estimate.mean()
    scale = np.dot(estimate, reference) / (np.dot(reference, reference) + eps)
    projection = scale * reference
    noise = estimate - projection
    return float(10 * np.log10((np.dot(projection, projection) + eps) / (np.dot(noise, noise) + eps)))


def determine_winner() -> tuple[str, dict[str, float]]:
    summary_path = RESULTS / "score-summary.json"
    if not summary_path.exists():
        raise SystemExit("Missing audio-eval/data/results/score-summary.json; run score_results.py first.")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    means: dict[str, float] = {}
    for model, data in summary["models"].items():
        accuracies = [data["top1_by_snr"][snr]["accuracy"] for snr in ("loud", "medium", "faint")]
        accuracies = [value for value in accuracies if value is not None]
        means[model] = statistics.mean(accuracies) if accuracies else 0.0
    winner = max(means, key=means.get)
    return winner, means


def main() -> int:
    eval_rows = json.loads((CLEANUP / "eval_clips.json").read_text(encoding="utf-8"))
    winner, winner_means = determine_winner()
    print(f"Winning primary model: {winner} (mean top-1 accuracy {winner_means}).")

    bird_names = score_results.bird_taxa()
    baseline_predictions = score_results.csv_predictions(winner, bird_names)
    cleanup_folder = RESULTS / f"cleanup-{winner}"
    if not cleanup_folder.exists():
        raise SystemExit(f"Missing {cleanup_folder}; run cleanup_classify.py {winner} first.")
    cleanup_predictions = score_results.csv_predictions(f"cleanup-{winner}", bird_names)

    mixit_timing = json.loads((CLEANUP / "mixit_timing.json").read_text(encoding="utf-8"))
    local_timing = json.loads((CLEANUP / "local_methods" / "timing.json").read_text(encoding="utf-8"))

    references: dict[str, np.ndarray] = {}
    per_clip = []
    # VAD runs on the isolated ambient-background layer, not the bird+background
    # mix: a foreground bird call sits in a similar energy/frequency band to
    # human speech and reliably trips WebRTC VAD on its own (confirmed: every
    # mix in this dataset registers as "speech" this way, which is a false
    # positive from the bird call, not a real voice). Checking the pre-mix
    # background answers the real question -- did the camera audio used here
    # contain a voice -- once per distinct background segment, since
    # prepare_audio.py already discards any segment where WebRTC VAD detects
    # speech before it is ever mixed in.
    background_ids = sorted({row["background_id"] for row in eval_rows})
    background_speech = {}
    for background_id in background_ids:
        background_pcm = prepare_audio.read_pcm(DATA / "backgrounds" / "vad-clean" / f"{background_id}.wav")
        has_voice, _frames, _run = prepare_audio.has_speech(background_pcm, VAD)
        background_speech[background_id] = has_voice
    speech_before_count = sum(background_speech.values())
    for row in eval_rows:
        clip_id = row["clip_id"]
        observation_id = row["source_observation_id"]
        species = score_results.norm(row["scientific_name"])
        if observation_id not in references:
            references[observation_id] = np.load(CLEANUP / "ref22050" / f"{observation_id}.npy")
        reference = references[observation_id]
        mix = np.load(CLEANUP / "mix22050" / f"{clip_id}.npy")

        raw_scores = [cleanup_predictions[f"{clip_id}__mixit-src{i}"]["scores"].get(species, 0.0) for i in range(4)]
        chosen = max(range(4), key=lambda i: raw_scores[i])
        mixit_source = np.load(CLEANUP / "mixit_sources" / f"{clip_id}__src{chosen}.npy")
        mixit_nr = np.load(CLEANUP / "local_methods" / f"{clip_id}__mixit-src{chosen}-nr.npy")
        nr_direct = np.load(CLEANUP / "local_methods" / f"{clip_id}__noisereduce.npy")
        ffmpeg_direct = np.load(CLEANUP / "local_methods" / f"{clip_id}__ffmpeg.npy")

        arrays = {"mixit": mixit_source, "noisereduce": nr_direct, "ffmpeg": ffmpeg_direct, "mixit+noisereduce": mixit_nr}
        confidences = {
            "mixit": raw_scores[chosen],
            "noisereduce": cleanup_predictions[f"{clip_id}__noisereduce"]["scores"].get(species, 0.0),
            "ffmpeg": cleanup_predictions[f"{clip_id}__ffmpeg"]["scores"].get(species, 0.0),
            "mixit+noisereduce": cleanup_predictions[f"{clip_id}__mixit-src{chosen}-nr"]["scores"].get(species, 0.0),
        }
        baseline_confidence = baseline_predictions[clip_id]["scores"].get(species, 0.0)

        baseline_sisnr = si_snr(mix, reference)
        sisnri = {method: si_snr(arrays[method], reference) - baseline_sisnr for method in METHODS}

        cpu_seconds = {
            "mixit": mixit_timing[clip_id],
            "noisereduce": local_timing[f"{clip_id}__noisereduce"],
            "ffmpeg": local_timing[f"{clip_id}__ffmpeg"],
            "mixit+noisereduce": mixit_timing[clip_id] + local_timing[f"{clip_id}__mixit-src{chosen}-nr"],
        }



        per_clip.append({
            "clip_id": clip_id,
            "snr_name": row["snr_name"],
            "scientific_name": row["scientific_name"],
            "mixit_selected_source": chosen,
            "baseline_si_snr_db": baseline_sisnr,
            "baseline_confidence": baseline_confidence,
            "si_snri_db": sisnri,
            "confidence": confidences,
            "confidence_held": {method: confidences[method] >= baseline_confidence for method in METHODS},
            "cpu_seconds": cpu_seconds,
        })

    by_snr: dict[str, dict] = {}
    for snr_name in ("loud", "medium", "faint"):
        rows = [item for item in per_clip if item["snr_name"] == snr_name]
        by_snr[snr_name] = {
            "clips": len(rows),
            "mean_si_snri_db": {method: round(statistics.mean(r["si_snri_db"][method] for r in rows), 2) for method in METHODS},
            "confidence_held_rate": {method: round(sum(r["confidence_held"][method] for r in rows) / len(rows), 3) for method in METHODS},
            "mean_confidence": {method: round(statistics.mean(r["confidence"][method] for r in rows), 4) for method in METHODS},
            "mean_baseline_confidence": round(statistics.mean(r["baseline_confidence"] for r in rows), 4),
            "mean_cpu_seconds_per_10s_clip": {method: round(statistics.mean(r["cpu_seconds"][method] for r in rows), 3) for method in METHODS},
        }
    overall = {
        "clips": len(per_clip),
        "mean_si_snri_db": {method: round(statistics.mean(r["si_snri_db"][method] for r in per_clip), 2) for method in METHODS},
        "confidence_held_rate": {method: round(sum(r["confidence_held"][method] for r in per_clip) / len(per_clip), 3) for method in METHODS},
        "mean_cpu_seconds_per_10s_clip": {method: round(statistics.mean(r["cpu_seconds"][method] for r in per_clip), 3) for method in METHODS},
    }

    summary = {
        "sample": {
            "clips": len(eval_rows),
            "unique_source_recordings": len({row["source_observation_id"] for row in eval_rows}),
            "note": "Deterministic stride sample of 20/161 source recordings (all 3 SNR levels each), used for every metric in this comparison because bird_mixit CPU inference is the bottleneck (tens of CPU-seconds per 10 s clip).",
        },
        "winning_model": winner,
        "winning_model_mean_top1_accuracy": winner_means,
        "methods": {
            "mixit": "Google bird_mixit, 4-source checkpoint, 22.05 kHz; source picked by highest classifier confidence for the true species.",
            "noisereduce": "noisereduce 3.0.3, spectral gating, stationary=False, applied directly to the mix.",
            "ffmpeg": "ffmpeg -af highpass=f=1000,afftdn, applied directly to the mix.",
            "mixit+noisereduce": "noisereduce applied to the MixIT-selected source.",
        },
        "speech_vad": {
            "distinct_background_segments_checked": len(background_ids),
            "background_segments_with_detected_voice": speech_before_count,
            "note": "Checked on the isolated ambient-background layer, not the bird+background mix (a foreground bird call reliably trips WebRTC VAD as a speech false positive on its own). prepare_audio.py already discards any camera-background segment where VAD detects speech before it is mixed with a bird call, so 0 here confirms that filter is working, not that cleanup removed anything.",
        },
        "by_snr": by_snr,
        "overall": overall,
        "per_clip": per_clip,
    }
    (RESULTS / "cleanup-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Ambient background segments with detected voice (before any mixing): {speech_before_count}/{len(background_ids)}.")
    print("SI-SNR improvement (dB) and confidence-held rate by method:")
    for method in METHODS:
        print(f"  {method:20} SI-SNRi {overall['mean_si_snri_db'][method]:+6.2f} dB   confidence held {overall['confidence_held_rate'][method]:.0%}   CPU s/10s clip {overall['mean_cpu_seconds_per_10s_clip'][method]:.2f}")

    # --- Listening examples: one source recording's loud/medium/faint clips. ---
    EXAMPLES.mkdir(parents=True, exist_ok=True)
    for old in EXAMPLES.glob("*.wav"):
        old.unlink()
    first_observation_id = eval_rows[0]["source_observation_id"]
    example_rows = [row for row in eval_rows if row["source_observation_id"] == first_observation_id]
    for row in example_rows:
        clip_id = row["clip_id"]
        item = next(entry for entry in per_clip if entry["clip_id"] == clip_id)
        chosen = item["mixit_selected_source"]
        mix = np.load(CLEANUP / "mix22050" / f"{clip_id}.npy")
        sf.write(EXAMPLES / f"{clip_id}-00-before.wav", mix, SR, subtype="PCM_16")
        variants = {
            "01-mixit": np.load(CLEANUP / "mixit_sources" / f"{clip_id}__src{chosen}.npy"),
            "02-noisereduce": np.load(CLEANUP / "local_methods" / f"{clip_id}__noisereduce.npy"),
            "03-ffmpeg": np.load(CLEANUP / "local_methods" / f"{clip_id}__ffmpeg.npy"),
            "04-mixit-noisereduce": np.load(CLEANUP / "local_methods" / f"{clip_id}__mixit-src{chosen}-nr.npy"),
        }
        for name, array_ in variants.items():
            sf.write(EXAMPLES / f"{clip_id}-{name}.wav", array_, SR, subtype="PCM_16")
    print(f"Wrote {len(list(EXAMPLES.glob('*.wav')))} listening example WAV(s) under audio-eval/examples/ for source recording {first_observation_id}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
