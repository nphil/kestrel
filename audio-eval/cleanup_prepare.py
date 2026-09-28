#!/usr/bin/env python3
"""Build the bird-audio cleanup comparison: MixIT, noisereduce, ffmpeg filters.

Runs entirely locally (no network audio upload). Needs the venv built with
audio-eval/requirements-cleanup.txt (tensorflow-cpu, noisereduce, soundfile).

Evaluation set: a deterministic, stride-sampled subset of the bird mixes so the
MixIT model (tens of CPU-seconds per 10 s clip) finishes in bounded time. 20 of
the 161 distinct source recordings are chosen, spread evenly across the sorted
observation IDs, and all 3 SNR variants (loud/medium/faint) of each are kept:
60 clips total. This is the sample used for every metric in the cleanup
section of results.md, not just the MixIT ones, so every number in that
section is comparable.

Phases (each idempotent/resumable by skipping files that already exist):
  1. Pick the 60-clip evaluation set; rebuild the known-clean reference call
     (pre-mix, deterministic) for each of the 20 source recordings.
  2. Resample every reference and mix to 22.05 kHz float32 (MixIT's native rate).
  3. Run the official bird_mixit 4-source checkpoint once per clip.
  4. Run noisereduce (spectral gating, non-stationary) and the ffmpeg
     highpass+afftdn filter directly on each mix, and noisereduce again on
     each of the 4 MixIT sources (cheap; avoids a second remote classify round
     trip once the winning source is picked from confidences).
  5. Export every variant that needs reclassifying as 16 kHz mono AAC, the
     same format already proven against Birda in run_bakeoff.py.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import pathlib
import resource
import subprocess
import sys
import time

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
CLEANUP = DATA / "cleanup"
MIXES = DATA / "mixes"
MIXIT_DIR = DATA / "tools" / "bird_mixit"
SR = 22050
CLIP_SECONDS = 10
SAMPLES = SR * CLIP_SECONDS
SOURCE_RECORDINGS = 20
RECLASSIFY_RATE = 16000

spec = importlib.util.spec_from_file_location("prepare_audio", HERE / "prepare_audio.py")
prepare_audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_audio)


def cpu_time_now() -> float:
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return time.process_time() + children.ru_utime + children.ru_stime


def decode_to_f32(path: pathlib.Path) -> np.ndarray:
    command = ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg decode of {path.name} failed: {result.stderr.decode('utf-8', errors='replace')[-800:]}")
    array = np.frombuffer(result.stdout, dtype=np.float32).copy()
    if len(array) < SAMPLES:
        array = np.pad(array, (0, SAMPLES - len(array)))
    return array[:SAMPLES]


def ffmpeg_denoise(x: np.ndarray) -> tuple[np.ndarray, float]:
    raw = x.astype(np.float32).tobytes()
    command = [
        "ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
        "-af", "highpass=f=1000,afftdn", "-f", "f32le", "-ar", str(SR), "-ac", "1", "pipe:1",
    ]
    start = cpu_time_now()
    result = subprocess.run(command, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    elapsed = cpu_time_now() - start
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg denoise failed: {result.stderr.decode('utf-8', errors='replace')[-800:]}")
    out = np.frombuffer(result.stdout, dtype=np.float32).copy()
    if len(out) < SAMPLES:
        out = np.pad(out, (0, SAMPLES - len(out)))
    return out[:SAMPLES], elapsed


def write_f32_as_aac(x: np.ndarray, destination: pathlib.Path) -> None:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    scale = min(1.0, 0.99 / peak) if peak > 0.99 else 1.0
    clipped = np.clip(x * scale, -1.0, 1.0)
    pcm16 = np.round(clipped * 32767.0).astype("<i2")
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
        "-c:a", "aac", "-b:a", "64k", "-ar", str(RECLASSIFY_RATE), "-ac", "1", "-f", "ipod", str(destination),
    ]
    result = subprocess.run(command, input=pcm16.tobytes(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0 or not destination.exists() or destination.stat().st_size < 512:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg could not encode {destination.name}")


def pick_eval_clips() -> list[dict]:
    with (DATA / "dataset.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    bird_rows = [row for row in rows if row["kind"] == "bird"]
    source_ids = sorted({row["source_observation_id"] for row in bird_rows}, key=int)
    n = len(source_ids)
    picked_indices = sorted({round(i * (n - 1) / (SOURCE_RECORDINGS - 1)) for i in range(SOURCE_RECORDINGS)})
    picked_sources = [source_ids[i] for i in picked_indices]
    picked_set = set(picked_sources)
    eval_rows = [row for row in bird_rows if row["source_observation_id"] in picked_set]
    eval_rows.sort(key=lambda row: (int(row["source_observation_id"]), row["snr_name"]))
    return eval_rows


def build_reference(observation_id: str, source_manifest: dict) -> np.ndarray:
    ref16_path = CLEANUP / "clean16k" / f"{observation_id}.wav"
    if not ref16_path.exists():
        source = next(item for item in source_manifest["samples"] if str(item["observation_id"]) == observation_id)
        samples = prepare_audio.read_pcm(DATA / source["audio_wav"])
        call = prepare_audio.crop_source(samples, int(observation_id))
        prepare_audio.write_pcm(ref16_path, call)
    return decode_to_f32(ref16_path)


def main() -> int:
    if not (MIXIT_DIR / "inference.meta").is_file():
        raise SystemExit("Missing audio-eval/data/tools/bird_mixit/inference.meta; download the checkpoint first.")
    for sub in ("clean16k", "ref22050", "mix22050", "mixit_sources", "local_methods", "classify_inputs"):
        (CLEANUP / sub).mkdir(parents=True, exist_ok=True)

    eval_rows = pick_eval_clips()
    (CLEANUP / "eval_clips.json").write_text(json.dumps(eval_rows, indent=2) + "\n", encoding="utf-8")
    unique_sources = sorted({row["source_observation_id"] for row in eval_rows}, key=int)
    print(f"Evaluation set: {len(eval_rows)} clips from {len(unique_sources)} source recordings.")

    source_manifest = json.loads((DATA / "sources" / "manifest.json").read_text(encoding="utf-8"))
    references: dict[str, np.ndarray] = {}
    for observation_id in unique_sources:
        ref_path = CLEANUP / "ref22050" / f"{observation_id}.npy"
        if ref_path.exists():
            references[observation_id] = np.load(ref_path)
            continue
        ref = build_reference(observation_id, source_manifest)
        np.save(ref_path, ref)
        references[observation_id] = ref
    print(f"Reference calls ready: {len(references)}.")

    mixes: dict[str, np.ndarray] = {}
    for row in eval_rows:
        clip_id = row["clip_id"]
        mix_path = CLEANUP / "mix22050" / f"{clip_id}.npy"
        if mix_path.exists():
            mixes[clip_id] = np.load(mix_path)
            continue
        mix = decode_to_f32(MIXES / f"{clip_id}.m4a")
        np.save(mix_path, mix)
        mixes[clip_id] = mix
    print(f"Mixes resampled to {SR} Hz: {len(mixes)}.")

    # --- Phase 3: MixIT 4-source separation, one persistent TF session. ---
    import tensorflow.compat.v1 as tf
    tf.disable_v2_behavior()
    tf.logging.set_verbosity(tf.logging.ERROR)
    mixit_timing = {}
    timing_path = CLEANUP / "mixit_timing.json"
    if timing_path.exists():
        mixit_timing = json.loads(timing_path.read_text(encoding="utf-8"))
    pending = [row for row in eval_rows if not all((CLEANUP / "mixit_sources" / f"{row['clip_id']}__src{i}.npy").exists() for i in range(4))]
    if pending:
        graph = tf.Graph()
        with graph.as_default():
            saver = tf.train.import_meta_graph(str(MIXIT_DIR / "inference.meta"))
        session = tf.Session(graph=graph)
        with graph.as_default():
            saver.restore(session, str(MIXIT_DIR / "model.ckpt-3223090"))
        input_tensor = graph.get_tensor_by_name("input_audio/receiver_audio:0")
        output_tensor = graph.get_tensor_by_name("denoised_waveforms:0")
        for index, row in enumerate(pending, start=1):
            clip_id = row["clip_id"]
            mix = mixes[clip_id][np.newaxis, np.newaxis, :].astype(np.float32)
            start = cpu_time_now()
            sources = session.run(output_tensor, feed_dict={input_tensor: mix})[0]
            elapsed = cpu_time_now() - start
            for i in range(4):
                np.save(CLEANUP / "mixit_sources" / f"{clip_id}__src{i}.npy", sources[i])
            mixit_timing[clip_id] = elapsed
            timing_path.write_text(json.dumps(mixit_timing, indent=2) + "\n", encoding="utf-8")
            print(f"MixIT {index}/{len(pending)}: {clip_id} ({elapsed:.1f} CPU s)")
        session.close()
    else:
        print("MixIT sources already computed for every evaluation clip.")

    # --- Phase 4: noisereduce + ffmpeg, direct and on each MixIT source. ---
    import noisereduce as nr
    local_timing = {}
    local_timing_path = CLEANUP / "local_methods" / "timing.json"
    if local_timing_path.exists():
        local_timing = json.loads(local_timing_path.read_text(encoding="utf-8"))
    for row in eval_rows:
        clip_id = row["clip_id"]
        mix = mixes[clip_id]
        nr_direct_path = CLEANUP / "local_methods" / f"{clip_id}__noisereduce.npy"
        if not nr_direct_path.exists():
            start = cpu_time_now()
            cleaned = nr.reduce_noise(y=mix, sr=SR, stationary=False)
            local_timing[f"{clip_id}__noisereduce"] = cpu_time_now() - start
            np.save(nr_direct_path, cleaned.astype(np.float32))
        ffmpeg_path = CLEANUP / "local_methods" / f"{clip_id}__ffmpeg.npy"
        if not ffmpeg_path.exists():
            cleaned, elapsed = ffmpeg_denoise(mix)
            local_timing[f"{clip_id}__ffmpeg"] = elapsed
            np.save(ffmpeg_path, cleaned)
        for i in range(4):
            src_nr_path = CLEANUP / "local_methods" / f"{clip_id}__mixit-src{i}-nr.npy"
            if src_nr_path.exists():
                continue
            source = np.load(CLEANUP / "mixit_sources" / f"{clip_id}__src{i}.npy")
            start = cpu_time_now()
            cleaned = nr.reduce_noise(y=source, sr=SR, stationary=False)
            local_timing[f"{clip_id}__mixit-src{i}-nr"] = cpu_time_now() - start
            np.save(src_nr_path, cleaned.astype(np.float32))
        local_timing_path.write_text(json.dumps(local_timing, indent=2) + "\n", encoding="utf-8")
    print(f"Local cleanup methods ready for {len(eval_rows)} clips.")

    # --- Phase 5: export every variant that needs reclassifying. ---
    exported = 0
    for row in eval_rows:
        clip_id = row["clip_id"]
        variants = {
            "noisereduce": CLEANUP / "local_methods" / f"{clip_id}__noisereduce.npy",
            "ffmpeg": CLEANUP / "local_methods" / f"{clip_id}__ffmpeg.npy",
        }
        for i in range(4):
            variants[f"mixit-src{i}"] = CLEANUP / "mixit_sources" / f"{clip_id}__src{i}.npy"
            variants[f"mixit-src{i}-nr"] = CLEANUP / "local_methods" / f"{clip_id}__mixit-src{i}-nr.npy"
        for name, npy_path in variants.items():
            destination = CLEANUP / "classify_inputs" / f"{clip_id}__{name}.m4a"
            if destination.exists():
                continue
            write_f32_as_aac(np.load(npy_path), destination)
            exported += 1
    total_inputs = len(list((CLEANUP / "classify_inputs").glob("*.m4a")))
    print(f"Exported {exported} new classify input(s); {total_inputs} total under audio-eval/data/cleanup/classify_inputs/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
