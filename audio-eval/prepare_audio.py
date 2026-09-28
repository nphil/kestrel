#!/usr/bin/env python3
"""Turn downloaded calls and real camera ambience into 16 kHz mono AAC test clips."""
from __future__ import annotations

import argparse
import array
import csv
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import wave

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
RATE = 16000
SEGMENT_SECONDS = 10
BACKGROUND_SAMPLE_COUNT = 25
SAMPLES_PER_SEGMENT = RATE * SEGMENT_SECONDS
SNR_DB = {"loud": 10.0, "medium": 0.0, "faint": -10.0}


def read_pcm(path: pathlib.Path) -> array.array:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2 or handle.getframerate() != RATE:
            raise ValueError(f"{path.name} is not 16 kHz mono 16-bit PCM")
        data = array.array("h")
        data.frombytes(path.read_bytes()[44:])
    if sys.byteorder != "little":
        data.byteswap()
    return data


def write_pcm(path: pathlib.Path, samples: array.array) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = samples
    if sys.byteorder != "little":
        data = array.array("h", samples)
        data.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(data.tobytes())


def rms(samples: array.array) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(value * value for value in samples) / len(samples))


def has_speech(samples: array.array, vad) -> tuple[bool, int, int]:
    frame_samples = RATE * 30 // 1000
    total_speech = 0
    longest_run = run = 0
    for offset in range(0, len(samples) - frame_samples + 1, frame_samples):
        frame = array.array("h", samples[offset:offset + frame_samples])
        if sys.byteorder != "little":
            frame.byteswap()
        speech = vad.is_speech(frame.tobytes(), RATE)
        if speech:
            total_speech += 1
            run += 1
            longest_run = max(longest_run, run)
        else:
            run = 0
    # Drop any 10-second piece with at least 60 ms of consecutive VAD speech.
    return longest_run >= 2 or total_speech >= 4, total_speech, longest_run


def encode_aac(samples: array.array, destination: pathlib.Path) -> None:
    raw = samples
    if sys.byteorder != "little":
        raw = array.array("h", samples)
        raw.byteswap()
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", "pipe:0",
        "-c:a", "aac", "-b:a", "64k", "-ar", str(RATE), "-ac", "1", "-f", "ipod", str(destination),
    ]
    result = subprocess.run(command, input=raw.tobytes(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0 or not destination.exists() or destination.stat().st_size < 512:
        destination.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg could not encode a 16 kHz AAC test clip")


def audio_metadata(path: pathlib.Path) -> dict:
    name = path.stem
    camera = re.search(r"camera-(\d+)-round-(\d+)", name)
    return {
        "camera_id": camera.group(1) if camera else "unknown",
        "capture_round": int(camera.group(2)) if camera else None,
        "background_id": name,
    }


def clean_backgrounds(vad_mode: int) -> list[dict]:
    try:
        import webrtcvad
    except ImportError as error:
        raise SystemExit("Install audio-eval/requirements.txt before preparing clips (WebRTC VAD is required).") from error
    vad = webrtcvad.Vad(vad_mode)
    raw_files = sorted((DATA / "backgrounds" / "raw").rglob("*.wav"))
    if not raw_files:
        raise SystemExit("No camera captures found under audio-eval/data/backgrounds/raw.")
    output_dir = DATA / "backgrounds" / "vad-clean"
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    kept: list[dict] = []
    rejected = 0
    for path in raw_files:
        try:
            samples = read_pcm(path)
        except (OSError, wave.Error, ValueError):
            rejected += 1
            continue
        for index, start in enumerate(range(0, len(samples) - SAMPLES_PER_SEGMENT + 1, SAMPLES_PER_SEGMENT)):
            piece = array.array("h", samples[start:start + SAMPLES_PER_SEGMENT])
            speech, speech_frames, longest_run = has_speech(piece, vad)
            if speech or rms(piece) < 8:
                rejected += 1
                continue
            destination = output_dir / f"{path.stem}-part-{index + 1:03d}.wav"
            write_pcm(destination, piece)
            kept.append({
                **audio_metadata(path),
                # Different windows from one capture need distinct output files.
                "background_id": destination.stem,
                "path": str(destination.relative_to(DATA)),
                "start_seconds": start / RATE,
                "speech_frames": speech_frames,
                "longest_speech_run_frames": longest_run,
                "duration_seconds": SEGMENT_SECONDS,
            })
    manifest = {"vad": "WebRTC VAD, aggressive mode", "vad_mode": vad_mode, "segment_seconds": SEGMENT_SECONDS, "speech_free_candidates": kept, "rejected_segments": rejected}
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Speech filter: kept {len(kept)} camera-background segment(s); rejected {rejected} segment(s).")
    if not kept:
        raise SystemExit("No speech-free background segments remain; collect more ambient audio.")
    return kept


def crop_source(samples: array.array, observation_id: int) -> array.array:
    if not samples:
        return array.array("h", [0]) * SAMPLES_PER_SEGMENT
    length = min(len(samples), SAMPLES_PER_SEGMENT)
    if len(samples) > length:
        max_start = len(samples) - length
        start = max(range(0, max_start + 1, RATE // 2), key=lambda offset: rms(samples[offset:offset + length]))
        piece = array.array("h", samples[start:start + length])
    else:
        piece = array.array("h", samples)
    if len(piece) < SAMPLES_PER_SEGMENT:
        piece.extend(array.array("h", [0]) * (SAMPLES_PER_SEGMENT - len(piece)))
    return piece


def mix_at_snr(signal: array.array, noise: array.array, snr_db: float) -> array.array:
    signal_rms = rms(signal)
    noise_rms = rms(noise)
    if signal_rms < 1 or noise_rms < 1:
        raise ValueError("source call or background is effectively silent")
    scale = (noise_rms / signal_rms) * (10 ** (snr_db / 20.0))
    values = [signal[i] * scale + noise[i] for i in range(SAMPLES_PER_SEGMENT)]
    peak = max(abs(value) for value in values)
    attenuation = min(1.0, 30000.0 / peak) if peak else 1.0
    return array.array("h", (max(-32768, min(32767, round(value * attenuation))) for value in values))


def build_dataset(backgrounds: list[dict]) -> int:
    source_manifest_path = DATA / "sources" / "manifest.json"
    if not source_manifest_path.exists():
        raise SystemExit("Fetch the iNaturalist recordings first: python3 audio-eval/fetch_recordings.py")
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    if len(backgrounds) < BACKGROUND_SAMPLE_COUNT:
        raise SystemExit(f"Need at least {BACKGROUND_SAMPLE_COUNT} VAD-clean background segments; found {len(backgrounds)}.")
    if any(item["camera_id"] not in {"103", "104"} for item in backgrounds):
        raise SystemExit("Background evaluation may use only cameras 103 and 104.")
    groups: dict[tuple[str, int], list[dict]] = {}
    for item in backgrounds:
        key = (str(item["camera_id"]), int(item["capture_round"] or 0))
        groups.setdefault(key, []).append(item)
    for items in groups.values():
        items.sort(key=lambda item: (item["start_seconds"], item["background_id"]))
    selected_backgrounds = []
    while len(selected_backgrounds) < BACKGROUND_SAMPLE_COUNT:
        progressed = False
        for key in sorted(groups):
            if groups[key]:
                selected_backgrounds.append(groups[key].pop(0))
                progressed = True
                if len(selected_backgrounds) == BACKGROUND_SAMPLE_COUNT:
                    break
        if not progressed:
            raise SystemExit("Could not balance the required background sample across captures.")
    backgrounds = selected_backgrounds
    print(f"Selected {len(backgrounds)} background clips, balanced across {len(groups)} camera-round captures.")
    mix_dir = DATA / "mixes"
    if mix_dir.exists():
        shutil.rmtree(mix_dir)
    mix_dir.mkdir(parents=True)
    background_samples = []
    for item in backgrounds:
        path = DATA / item["path"]
        background_samples.append((item, read_pcm(path)))
    samples: list[dict] = []
    sources_dir = DATA / "sources"
    for source in source_manifest["samples"]:
        path = DATA / source["audio_wav"]
        try:
            call = crop_source(read_pcm(path), int(source["observation_id"]))
        except (OSError, wave.Error, ValueError):
            continue
        if rms(call) < 1:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", source["scientific_name"].lower()).strip("-")
        background_index = int(source["observation_id"]) % len(background_samples)
        background_info, background = background_samples[background_index]
        for snr_name, snr_db in SNR_DB.items():
            clip_id = f"bird-{slug}-{source['observation_id']}-{snr_name}"
            destination = mix_dir / f"{clip_id}.m4a"
            try:
                mixed = mix_at_snr(call, background, snr_db)
                encode_aac(mixed, destination)
            except (ValueError, RuntimeError):
                continue
            samples.append({
                "clip_id": clip_id,
                "kind": "bird",
                "label": source["label"],
                "scientific_name": source["scientific_name"],
                "snr_name": snr_name,
                "snr_db": snr_db,
                "source_observation_id": source["observation_id"],
                "source_recordist": source["recordist"],
                "background_id": background_info["background_id"],
                "background_camera_id": background_info["camera_id"],
                "path": str(destination.relative_to(DATA)),
                "duration_seconds": SEGMENT_SECONDS,
            })
    negative_dir = mix_dir / "background"
    negative_count = 0
    for index, (background_info, background) in enumerate(background_samples, start=1):
        clip_id = f"background-{background_info['background_id']}"
        destination = negative_dir / f"{clip_id}.m4a"
        try:
            encode_aac(background, destination)
        except RuntimeError:
            continue
        samples.append({
            "clip_id": clip_id,
            "kind": "background_candidate",
            "label": "",
            "scientific_name": "",
            "snr_name": "",
            "snr_db": "",
            "source_observation_id": "",
            "source_recordist": "",
            "background_id": background_info["background_id"],
            "background_camera_id": background_info["camera_id"],
            "path": str(destination.relative_to(DATA)),
            "duration_seconds": SEGMENT_SECONDS,
        })
        negative_count += 1
    clip_ids = [row["clip_id"] for row in samples]
    audio_paths = [row["path"] for row in samples]
    if len(clip_ids) != len(set(clip_ids)) or len(audio_paths) != len(set(audio_paths)):
        raise RuntimeError("Every evaluation clip must have a unique ID and audio file.")
    csv_path = DATA / "dataset.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        fields = ["clip_id", "kind", "label", "scientific_name", "snr_name", "snr_db", "source_observation_id", "source_recordist", "background_id", "background_camera_id", "path", "duration_seconds"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(samples)
    bird_count = sum(row["kind"] == "bird" for row in samples)
    print(f"AAC set: {bird_count} bird mixes across loud/medium/faint SNR; {negative_count} VAD-clean background candidates.")
    print(f"Dataset manifest: {csv_path.relative_to(HERE.parent)}")
    return bird_count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vad-mode", type=int, choices=range(4), default=3, help="WebRTC VAD aggressiveness (default: 3)")
    args = parser.parse_args()
    if shutil.which("ffmpeg") is None:
        parser.error("ffmpeg is required")
    backgrounds = clean_backgrounds(args.vad_mode)
    build_dataset(backgrounds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
