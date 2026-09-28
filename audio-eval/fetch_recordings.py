#!/usr/bin/env python3
"""Fetch one-per-recordist, research-grade iNaturalist bird sounds near Atlanta.

Raw recordings and manifests are written only under git-ignored audio-eval/data/.
Xeno-canto API v3 needs an API key; this script uses the requested iNaturalist fallback.
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SPECIES_PATH = ROOT / "classifier" / "species" / "atlanta.json"
DATA = HERE / "data"
API = "https://api.inaturalist.org/v1/observations"
USER_AGENT = "KestrelAudioEval/1.0 (local, non-commercial evaluation)"
LATITUDE = 33.72
LONGITUDE = -84.44
RADIUS_KM = 100
START_DATE = "2023-01-01"
MAX_RECORDING_SECONDS = 30
MIN_RECORDING_SECONDS = 3
MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024


def read_species(limit: int) -> list[dict]:
    rows = json.loads(SPECIES_PATH.read_text(encoding="utf-8"))
    birds = [row for row in rows if row.get("group") == "Birds"]
    birds.sort(key=lambda row: int(row.get("local_obs", 0)), reverse=True)
    return birds[:limit]


def fetch_json(params: dict[str, object]) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def fetch_audio(url: str, destination: pathlib.Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "audio/*,*/*;q=0.8"})
    with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_DOWNLOAD_BYTES:
            raise ValueError("recording is over the size limit")
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise ValueError("recording is over the size limit")
            output.write(chunk)


def convert_audio(source: pathlib.Path, destination: pathlib.Path) -> float:
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-vn", "-t", str(MAX_RECORDING_SECONDS),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination),
    ]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        raise ValueError("ffmpeg could not decode the recording")
    with wave.open(str(destination), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2 or handle.getframerate() != 16000:
            raise ValueError("decoded audio is not 16 kHz mono PCM")
        duration = handle.getnframes() / handle.getframerate()
    if duration < MIN_RECORDING_SECONDS:
        raise ValueError("recording is shorter than 3 seconds")
    return duration


def safe_suffix(url: str) -> str:
    suffix = pathlib.PurePosixPath(urllib.parse.urlsplit(url).path).suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,6}", suffix) else ".audio"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--species", type=int, default=40, help="number of top local bird species (default: 40)")
    parser.add_argument("--per-species", type=int, default=5, help="unique recordists per species (default: 5)")
    parser.add_argument("--delay", type=float, default=0.35, help="pause between API requests (default: 0.35s)")
    args = parser.parse_args()
    if args.species < 1 or args.per_species < 1 or args.delay < 0:
        parser.error("--species and --per-species must be positive; --delay cannot be negative")
    if shutil.which("ffmpeg") is None:
        parser.error("ffmpeg is required")

    source_dir = DATA / "sources"
    if source_dir.exists():
        shutil.rmtree(source_dir)
    source_dir.mkdir(parents=True)
    species_rows = read_species(args.species)
    samples: list[dict] = []
    summary: list[dict] = []
    api_errors = 0

    for rank, species in enumerate(species_rows, start=1):
        wanted = int(args.per_species)
        accepted_logins: set[str] = set()
        found = 0
        total_results = 0
        page = 1
        while found < wanted:
            params = {
                "taxon_name": species["scientific"],
                "quality_grade": "research",
                "sounds": "true",
                "photos": "false",
                "d1": START_DATE,
                "lat": LATITUDE,
                "lng": LONGITUDE,
                "radius": RADIUS_KM,
                "per_page": 200,
                "page": page,
                "order_by": "observed_on",
                "order": "desc",
            }
            try:
                response = fetch_json(params)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                api_errors += 1
                break
            total_results = int(response.get("total_results", 0))
            records = response.get("results", [])
            if not records:
                break
            for observation in records:
                user = observation.get("user") or {}
                login = user.get("login")
                if not login or login in accepted_logins:
                    continue
                sounds = [sound for sound in observation.get("sounds", []) if sound.get("file_url")]
                if not sounds:
                    continue
                sound = sounds[0]
                observation_id = int(observation["id"])
                base = f"{rank:02d}_{observation_id}"
                with tempfile.TemporaryDirectory(prefix="inat-", dir=DATA) as temp:
                    temp_dir = pathlib.Path(temp)
                    original = temp_dir / ("recording" + safe_suffix(sound["file_url"]))
                    normalized = source_dir / f"{base}.wav"
                    try:
                        fetch_audio(sound["file_url"], original)
                        duration = convert_audio(original, normalized)
                    except (urllib.error.URLError, TimeoutError, ValueError, OSError, subprocess.SubprocessError):
                        normalized.unlink(missing_ok=True)
                        continue
                accepted_logins.add(login)
                found += 1
                samples.append({
                    "rank": rank,
                    "label": species["label"],
                    "scientific_name": species["scientific"],
                    "local_observations": int(species.get("local_obs", 0)),
                    "observation_id": observation_id,
                    "observation_url": f"https://www.inaturalist.org/observations/{observation_id}",
                    "recordist": login,
                    "observed_on": observation.get("observed_on"),
                    "sound_id": sound.get("id"),
                    "license": sound.get("license_code"),
                    "duration_seconds": round(duration, 3),
                    "audio_wav": str(normalized.relative_to(DATA)),
                })
                if found >= wanted:
                    break
            if found >= wanted or page * 200 >= total_results:
                break
            page += 1
            time.sleep(args.delay)
        summary.append({
            "rank": rank,
            "label": species["label"],
            "scientific_name": species["scientific"],
            "local_observations": int(species.get("local_obs", 0)),
            "inat_matching_observations": total_results,
            "recordings": found,
            "requested": wanted,
        })
        print(f"{rank:02d}/{len(species_rows):02d} {species['label']}: {found}/{wanted} distinct recordists")
        time.sleep(args.delay)

    manifest = {
        "source": "iNaturalist research-grade sound observations",
        "query": {"lat": LATITUDE, "lng": LONGITUDE, "radius_km": RADIUS_KM, "observed_from": START_DATE},
        "requested_species": len(species_rows),
        "requested_recordings_per_species": args.per_species,
        "api_errors": api_errors,
        "samples": samples,
        "species": summary,
    }
    (source_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    with (source_dir / "species-counts.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(summary[0]) if summary else [])
        if summary:
            writer.writeheader()
            writer.writerows(summary)
    full = sum(row["recordings"] == args.per_species for row in summary)
    print(f"Downloaded {len(samples)} audio recording(s) from {len(summary)} species; {full} species have a full {args.per_species}-recordist sample.")
    if api_errors:
        print(f"iNaturalist API errors: {api_errors}; see manifest for completed coverage.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
