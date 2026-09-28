#!/usr/bin/env python3
"""Run Birda's BirdNET/Perch models in a disposable Ubuntu container on Unraid.

Evaluation clips (re-encoded to WAV; Birda's bundled decoder cannot read our
AAC-in-MP4 mixes) and the Birda release archive are streamed to the
container. The container uses --rm; model weights and outputs disappear from it
when the run ends. CSV results are streamed back under ignored audio-eval/data/.
"""
from __future__ import annotations

import csv
import json
import pathlib
import shlex
import shutil
import subprocess
import tarfile
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
MIXES = DATA / "mixes"
RESULTS = DATA / "results"
BIRDA_ARCHIVE = DATA / "tools" / "birda-linux-x64-embed-v1.8.1.tar.gz"
MODELS = ("birdnet-v24", "perch-v2")
UBUNTU_IMAGE = "ubuntu:24.04"
LATITUDE = 33.72
LONGITUDE = -84.44
WEEK = 39

REMOTE_SCRIPT = r'''set -eu
trap 'status=$?; echo "Disposable Birda run failed (status $status); diagnostics follow:" >&2; for f in /work/apt.log /work/out/model-install.log /work/out/birdnet-v24.log /work/out/perch-v2.log; do if [ -f "$f" ]; then echo "--- $f ---" >&2; tail -n 5 "$f" >&2; fi; done; exit "$status"' ERR
mkdir -p /work/inputs /work/out /work/tools /work/home
 tar -xf - -C /work
apt-get update -qq >/work/apt.log 2>&1
apt-get install -y -qq ca-certificates time libgomp1 libstdc++6 >>/work/apt.log 2>&1
 tar -xzf /work/birda.tar.gz -C /work/tools
BIRDA="$(find /work/tools -type f -name birda | head -n 1)"
if [ -z "$BIRDA" ]; then echo "Birda binary missing from release archive" >&2; exit 2; fi
chmod +x "$BIRDA"
ORT_SO="$(find /work/tools -type f -name 'libonnxruntime.so*' | head -n 1)"
if [ -z "$ORT_SO" ]; then echo "Bundled ONNX Runtime missing from the embed release archive" >&2; exit 2; fi
export LD_LIBRARY_PATH="$(dirname "$ORT_SO"):${LD_LIBRARY_PATH:-}"
export HOME=/work/home
export XDG_CONFIG_HOME=/work/home/.config
"$BIRDA" --version > /work/out/birda-version.txt 2>&1
for MODEL in birdnet-v24 perch-v2; do
  "$BIRDA" models install "$MODEL" >>/work/out/model-install.log 2>&1
 done
for MODEL in birdnet-v24 perch-v2; do
  mkdir -p "/work/out/$MODEL"
  /usr/bin/time -f '%U %S' -o "/work/out/$MODEL.cpu" \
    "$BIRDA" --cpu --model "$MODEL" --format csv --min-confidence 0.0 \
      --lat 33.72 --lon -84.44 --week 39 --batch-size 8 --no-progress --force \
      --output-dir "/work/out/$MODEL" /work/inputs \
      >"/work/out/$MODEL.log" 2>&1
  printf 'Completed %s model run.\n' "$MODEL" >&2
done
tar -C /work/out -cf - .
'''


def to_wav(source: pathlib.Path, destination: pathlib.Path) -> None:
    command = ["ffmpeg", "-v", "error", "-y", "-i", str(source), "-ac", "1", str(destination)]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0 or not destination.is_file():
        raise RuntimeError(f"ffmpeg could not convert {source.name} to WAV: {result.stderr.decode('utf-8', errors='replace')[-500:]}")


def stage_inputs(stream, workdir: pathlib.Path) -> int:
    count = 0
    with tarfile.open(fileobj=stream, mode="w|") as archive:
        archive.add(BIRDA_ARCHIVE, arcname="birda.tar.gz")
        archive.add(DATA / "dataset.csv", arcname="dataset.csv")
        # Birda's bundled symphonia decoder fails ("invalid mpeg audio header")
        # on our ffmpeg-muxed AAC-in-MP4 clips; WAV decodes reliably (confirmed).
        for path in sorted(MIXES.rglob("*.m4a")):
            wav_path = workdir / f"{path.stem}.wav"
            to_wav(path, wav_path)
            archive.add(wav_path, arcname=f"inputs/{wav_path.name}")
            count += 1
    return count


def extract_results(stream) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise RuntimeError("Temporary runtime returned an unsafe output path")
            destination = RESULTS.joinpath(*name.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                continue
            with source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def main() -> int:
    if not BIRDA_ARCHIVE.is_file():
        raise SystemExit("Run /tmp/kestrel-audio-eval-venv/bin/python audio-eval/get_birda.py first.")
    if not (DATA / "dataset.csv").is_file() or not MIXES.is_dir():
        raise SystemExit("Run audio-eval/prepare_audio.py before the model bake-off.")
    for model in MODELS:
        shutil.rmtree(RESULTS / model, ignore_errors=True)
        for suffix in (".cpu", ".log"):
            (RESULTS / f"{model}{suffix}").unlink(missing_ok=True)
    for name in ("birda-version.txt", "model-install.log"):
        (RESULTS / name).unlink(missing_ok=True)
    RESULTS.mkdir(parents=True, exist_ok=True)
    remote_command = "docker run --rm -i --network bridge " + UBUNTU_IMAGE + " bash -ec " + shlex.quote(REMOTE_SCRIPT)
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "unraid", remote_command]
    with tempfile.TemporaryFile() as error_log, tempfile.TemporaryDirectory() as workdir_name:
        workdir = pathlib.Path(workdir_name)
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_log)
        assert process.stdin is not None and process.stdout is not None
        try:
            clip_count = stage_inputs(process.stdin, workdir)
            process.stdin.close()
            try:
                extract_results(process.stdout)
            except (tarfile.ReadError, EOFError) as error:
                return_code = process.wait()
                error_log.seek(0)
                stderr = error_log.read().decode("utf-8", errors="replace")
                raise SystemExit(f"Disposable model runtime exited with {return_code} before returning results ({error}):\n{stderr[-4000:]}")
            return_code = process.wait()
        except Exception:
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
        error_log.seek(0)
        stderr = error_log.read().decode("utf-8", errors="replace")
    if return_code != 0:
        raise SystemExit(f"Disposable model runtime exited with {return_code}:\n{stderr[-4000:]}")

    with (DATA / "dataset.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    input_seconds = sum(float(row["duration_seconds"]) for row in rows if row.get("duration_seconds"))
    timings = {"runtime": "Birda v1.8.1 CPU in disposable Ubuntu 24.04 container", "container_image": UBUNTU_IMAGE, "input_clips": clip_count, "input_audio_seconds": round(input_seconds, 3), "location": {"latitude": LATITUDE, "longitude": LONGITUDE, "week": WEEK}, "models": {}}
    for model in MODELS:
        time_path = RESULTS / f"{model}.cpu"
        if not time_path.exists():
            raise SystemExit(f"Missing CPU timing file for {model}.")
        pieces = time_path.read_text(encoding="utf-8").strip().split()
        if len(pieces) != 2:
            raise SystemExit(f"Could not parse CPU time for {model}.")
        user_seconds, system_seconds = map(float, pieces)
        cpu_seconds = user_seconds + system_seconds
        timings["models"][model] = {
            "user_seconds": round(user_seconds, 3),
            "system_seconds": round(system_seconds, 3),
            "cpu_seconds": round(cpu_seconds, 3),
            "cpu_seconds_per_minute": round(cpu_seconds / (input_seconds / 60), 3) if input_seconds else None,
        }
    (RESULTS / "timings.json").write_text(json.dumps(timings, indent=2) + "\n", encoding="utf-8")
    print(f"Birda processed {clip_count} clips using {len(MODELS)} supported models in a disposable --rm Ubuntu container.")
    for model, item in timings["models"].items():
        print(f"{model}: {item['cpu_seconds_per_minute']} CPU seconds per minute of audio")
    print(f"CSV output saved under audio-eval/data/results/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
