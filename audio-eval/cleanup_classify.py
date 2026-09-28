#!/usr/bin/env python3
"""Reclassify every cleanup-comparison audio variant with one Birda model.

Runs the same disposable, --rm Ubuntu container recipe as run_bakeoff.py
(same pinned Birda "embed" release, which bundles its own matched ONNX
Runtime -- the plain "-bin-" release hangs indefinitely on this host; see
run_bakeoff.py's REMOTE_SCRIPT comment), pointed at
audio-eval/data/cleanup/classify_inputs/ instead of the primary dataset.
Clips are re-encoded to WAV while staging (Birda's bundled decoder cannot
read our AAC-in-MP4 mixes). Takes the winning model's name (birdnet-v24 or
perch-v2) as its one argument.
"""
from __future__ import annotations

import argparse
import pathlib
import shlex
import shutil
import subprocess
import tarfile
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
CLEANUP = DATA / "cleanup"
INPUTS = CLEANUP / "classify_inputs"
RESULTS = DATA / "results"
BIRDA_ARCHIVE = DATA / "tools" / "birda-linux-x64-embed-v1.8.1.tar.gz"
UBUNTU_IMAGE = "ubuntu:24.04"
LATITUDE = 33.72
LONGITUDE = -84.44
WEEK = 39

REMOTE_SCRIPT = r'''set -eu
trap 'status=$?; echo "Disposable cleanup-reclassify run failed (status $status); diagnostics follow:" >&2; for f in /work/apt.log /work/out/model-install.log /work/out/__MODEL__.log; do if [ -f "$f" ]; then echo "--- $f ---" >&2; tail -n 5 "$f" >&2; fi; done; exit "$status"' ERR
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
"$BIRDA" models install "__MODEL__" >>/work/out/model-install.log 2>&1
mkdir -p "/work/out/__MODEL__"
/usr/bin/time -f '%U %S' -o "/work/out/__MODEL__.cpu" \
  timeout --kill-after=30s 40m \
  "$BIRDA" --cpu --model "__MODEL__" --format csv --min-confidence 0.0 \
    --lat __LAT__ --lon __LON__ --week __WEEK__ --batch-size 8 --no-progress --force \
    --output-dir "/work/out/__MODEL__" /work/inputs \
    >"/work/out/__MODEL__.log" 2>&1
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
        for path in sorted(INPUTS.glob("*.m4a")):
            wav_path = workdir / f"{path.stem}.wav"
            to_wav(path, wav_path)
            archive.add(wav_path, arcname=f"inputs/{wav_path.name}")
            count += 1
    return count


def extract_results(stream, model: str) -> None:
    destination_root = RESULTS / f"cleanup-{model}"
    destination_root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise RuntimeError("Temporary runtime returned an unsafe output path")
            if not member.isfile():
                continue
            destination = destination_root.joinpath(*name.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                continue
            with source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=("birdnet-v24", "perch-v2"), help="Winning model from the primary bake-off")
    args = parser.parse_args()
    if not INPUTS.is_dir() or not list(INPUTS.glob("*.m4a")):
        raise SystemExit("No classify inputs found; run audio-eval/cleanup_prepare.py first.")
    if not BIRDA_ARCHIVE.is_file():
        raise SystemExit("Missing Birda release archive; run audio-eval/get_birda.py first.")

    remote_script = REMOTE_SCRIPT.replace("__MODEL__", args.model).replace("__LAT__", str(LATITUDE)).replace("__LON__", str(LONGITUDE)).replace("__WEEK__", str(WEEK))
    remote_command = "docker run --rm -i --network bridge " + UBUNTU_IMAGE + " bash -ec " + shlex.quote(remote_script)
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "unraid", remote_command]
    with tempfile.TemporaryFile() as error_log, tempfile.TemporaryDirectory() as workdir_name:
        workdir = pathlib.Path(workdir_name)
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_log)
        assert process.stdin is not None and process.stdout is not None
        try:
            clip_count = stage_inputs(process.stdin, workdir)
            process.stdin.close()
            try:
                extract_results(process.stdout, args.model)
            except (tarfile.ReadError, EOFError) as error:
                return_code = process.wait()
                error_log.seek(0)
                stderr = error_log.read().decode("utf-8", errors="replace")
                raise SystemExit(f"Disposable reclassify run exited with {return_code} before returning results ({error}):\n{stderr[-4000:]}")
            return_code = process.wait()
        except Exception:
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
        error_log.seek(0)
        stderr = error_log.read().decode("utf-8", errors="replace")
    if return_code != 0:
        raise SystemExit(f"Disposable reclassify run exited with {return_code}:\n{stderr[-4000:]}")

    time_path = RESULTS / f"cleanup-{args.model}" / f"{args.model}.cpu"
    cpu_seconds = None
    if time_path.exists():
        pieces = time_path.read_text(encoding="utf-8").strip().split()
        if len(pieces) == 2:
            cpu_seconds = round(sum(map(float, pieces)), 3)
    print(f"Reclassified {clip_count} cleanup-comparison audio file(s) with {args.model} in a disposable --rm container.")
    if cpu_seconds is not None:
        print(f"CPU seconds: {cpu_seconds}")
    print(f"CSV output saved under audio-eval/data/results/cleanup-{args.model}/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
