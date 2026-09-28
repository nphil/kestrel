#!/usr/bin/env python3
"""Run the official BirdNET+ V3.0 developer preview once in a disposable container."""
from __future__ import annotations

import csv
import io
import json
import pathlib
import shlex
import shutil
import subprocess
import tarfile
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = HERE / "data"
RESULTS = DATA / "results"
MODEL_ID = "birdnet-v30-dev"
UBUNTU_IMAGE = "ubuntu:24.04"
REPO_COMMIT = "623dec2605c0b9dcde36b9ae320f4fbda22c57ea"
CHUNK_SECONDS = 10
MIN_CONFIDENCE = 0.001

REMOTE_SCRIPT = r'''set -eu
trap 'status=$?; echo "BirdNET+ preview failed (status $status); diagnostics follow:" >&2; for f in /work/apt.log /work/pip-python.log /work/out/birdnet-v30-dev.log /work/out/prepare.log /work/out/normalize.log; do if [ -f "$f" ]; then echo "--- $f ---" >&2; tail -n 5 "$f" >&2; fi; done; exit "$status"' ERR
mkdir -p /work/inputs /work/out /work/home /work/v3repo
 tar -xf - -C /work
apt-get update -qq >/work/apt.log 2>&1
apt-get install -y -qq ca-certificates curl ffmpeg python3-pip libgomp1 libstdc++6 time >>/work/apt.log 2>&1
curl --fail --location --silent --show-error "https://github.com/birdnet-team/birdnet-V3.0-dev/archive/__REPO_COMMIT__.tar.gz" -o /work/v3repo.tar.gz
tar -xzf /work/v3repo.tar.gz -C /work/v3repo --strip-components=1
python3 -m pip install --break-system-packages --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu 'torch==2.8.0+cpu' 'numpy<2' 'librosa>=0.10' >/work/pip-python.log 2>&1
python3 - <<'PY' >/work/out/prepare.log 2>&1
import json, pathlib, subprocess, wave
clips=json.loads(pathlib.Path('/work/clip-order.json').read_text())
out=pathlib.Path('/work/combined.wav')
expected=32000*10*2
with wave.open(str(out),'wb') as wav:
    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(32000)
    for item in clips:
        source=pathlib.Path('/work/inputs')/(item['clip_id']+'.m4a')
        command=['ffmpeg','-v','error','-i',str(source),'-vn','-af','apad=whole_dur=10,atrim=duration=10','-ac','1','-ar','32000','-f','s16le','pipe:1']
        result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
        if result.returncode:
            raise SystemExit('ffmpeg could not decode a test clip')
        pcm=result.stdout[:expected].ljust(expected,bytes([0]))
        wav.writeframes(pcm)
if out.stat().st_size != 44+len(clips)*expected:
    raise SystemExit('combined audio length did not match the clip manifest')
print(f'Prepared {len(clips)} exact {10}-second clips at 32 kHz mono.')
PY
cd /work/v3repo
/usr/bin/time -f '%U %S' -o /work/out/birdnet-v30-dev.cpu python3 analyze.py /work/combined.wav --chunk_length 10 --overlap 0 --device cpu --min-conf 0.001 --out-csv /work/out/birdnet-v30-dev.all.csv >/work/out/birdnet-v30-dev.log 2>&1
python3 - <<'PY' >/work/out/normalize.log 2>&1
import csv, json, pathlib, re
clips=json.loads(pathlib.Path('/work/clip-order.json').read_text())
taxa=json.loads(pathlib.Path('/work/atlanta.json').read_text())
normalize=lambda value: ' '.join(value.strip().casefold().split())
birds={normalize(row['scientific']) for row in taxa if row.get('group')=='Birds'}
scores=[{} for _ in clips]
with pathlib.Path('/work/out/birdnet-v30-dev.all.csv').open(encoding='utf-8-sig',newline='') as handle:
    for row in csv.DictReader(handle):
        start=float(row['start_sec'])
        index=round(start/10)
        if index < 0 or index >= len(clips) or abs(start-index*10)>0.01:
            raise SystemExit('preview output chunks did not align to the 10-second input clips')
        scientific=row['label'].split('_',1)[0].strip()
        key=normalize(scientific)
        if key not in birds:
            continue
        score=float(row['confidence'])
        scores[index][scientific]=max(score,scores[index].get(scientific,0.0))
outdir=pathlib.Path('/work/out/birdnet-v30-dev')
outdir.mkdir(parents=True,exist_ok=True)
for item, predicted in zip(clips,scores):
    clip_id=item['clip_id']
    if not re.fullmatch(r'[A-Za-z0-9_-]+',clip_id):
        raise SystemExit('unsafe clip identifier in input manifest')
    with (outdir/(clip_id+'.results.csv')).open('w',encoding='utf-8',newline='') as handle:
        writer=csv.writer(handle); writer.writerow(['Scientific name','Confidence'])
        for scientific,score in sorted(predicted.items(),key=lambda entry:entry[1],reverse=True):
            writer.writerow([scientific,score])
pathlib.Path('/work/out/birdnet-v30-dev.all.csv').unlink()
print(f'Normalized local-bird predictions for {len(clips)} clips; export floor was 0.001.')
PY
tar -C /work/out -cf - birdnet-v30-dev birdnet-v30-dev.cpu birdnet-v30-dev.log prepare.log normalize.log
'''


def stage_inputs(stream) -> tuple[int, float]:
    with (DATA / "dataset.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    clip_ids = [row["clip_id"] for row in rows]
    paths = [row["path"] for row in rows]
    if len(clip_ids) != len(set(clip_ids)) or len(paths) != len(set(paths)):
        raise SystemExit("Rebuild audio-eval data before the v3 run; clip IDs and paths must be unique.")
    order = json.dumps([{"clip_id": value} for value in clip_ids], separators=(",", ":")).encode()
    with tarfile.open(fileobj=stream, mode="w|") as archive:
        info = tarfile.TarInfo("clip-order.json")
        info.size = len(order)
        archive.addfile(info, io.BytesIO(order))
        archive.add(ROOT / "classifier" / "species" / "atlanta.json", arcname="atlanta.json")
        for row in rows:
            path = DATA / row["path"]
            if not path.is_file():
                raise SystemExit(f"Missing evaluation clip: {row['clip_id']}")
            archive.add(path, arcname=f"inputs/{row['clip_id']}.m4a")
    seconds = sum(float(row["duration_seconds"]) for row in rows if row.get("duration_seconds"))
    return len(rows), seconds


def extract_results(stream) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise RuntimeError("Preview returned an unsafe output path")
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


def discard_preview_outputs() -> None:
    shutil.rmtree(RESULTS / MODEL_ID, ignore_errors=True)
    for suffix in (".cpu", ".log"):
        (RESULTS / f"{MODEL_ID}{suffix}").unlink(missing_ok=True)
    for name in ("prepare.log", "normalize.log"):
        (RESULTS / name).unlink(missing_ok=True)

def main() -> int:
    if not (DATA / "dataset.csv").is_file():
        raise SystemExit("Prepare audio-eval data before running the preview.")
    discard_preview_outputs()
    remote_script = REMOTE_SCRIPT.replace("__REPO_COMMIT__", REPO_COMMIT)
    remote_command = (
        "docker run --rm -i --network bridge " + UBUNTU_IMAGE
        + " timeout --kill-after=30s 26m bash -ec " + shlex.quote(remote_script)
    )
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "unraid", remote_command]
    with tempfile.TemporaryFile() as input_archive:
        clip_count, input_seconds = stage_inputs(input_archive)
        input_archive.seek(0)
        with tempfile.TemporaryFile() as error_log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_log)
            assert process.stdin is not None and process.stdout is not None
            try:
                shutil.copyfileobj(input_archive, process.stdin)
                process.stdin.close()
                try:
                    extract_results(process.stdout)
                except (tarfile.ReadError, EOFError) as error:
                    return_code = process.wait()
                    error_log.seek(0)
                    stderr = error_log.read().decode("utf-8", errors="replace")
                    discard_preview_outputs()
                    raise SystemExit(f"BirdNET+ preview exited with {return_code} before returning results ({error}):\n{stderr[-4000:]}")
                return_code = process.wait()
            except Exception:
                discard_preview_outputs()
                if process.poll() is None:
                    process.kill()
                process.wait()
                raise
            error_log.seek(0)
            stderr = error_log.read().decode("utf-8", errors="replace")
    if return_code != 0:
        discard_preview_outputs()
        raise SystemExit(f"BirdNET+ preview exited with {return_code}:\n{stderr[-4000:]}")

    time_path = RESULTS / f"{MODEL_ID}.cpu"
    pieces = time_path.read_text(encoding="utf-8").strip().split()
    if len(pieces) != 2:
        raise SystemExit("Could not parse v3 CPU timing.")
    user_seconds, system_seconds = map(float, pieces)
    cpu_seconds = user_seconds + system_seconds
    timings_path = RESULTS / "timings.json"
    timings = json.loads(timings_path.read_text(encoding="utf-8")) if timings_path.exists() else {"models": {}}
    timings.setdefault("models", {})[MODEL_ID] = {
        "user_seconds": round(user_seconds, 3),
        "system_seconds": round(system_seconds, 3),
        "cpu_seconds": round(cpu_seconds, 3),
        "cpu_seconds_per_minute": round(cpu_seconds / (input_seconds / 60), 3) if input_seconds else None,
    }
    timings["v3_preview"] = {
        "repository": "https://github.com/birdnet-team/birdnet-V3.0-dev",
        "commit": REPO_COMMIT,
        "model": "Developer Preview 3.1, Global 11K, PyTorch FP32",
        "chunk_seconds": CHUNK_SECONDS,
        "export_min_confidence": MIN_CONFIDENCE,
        "input_clips": clip_count,
        "input_audio_seconds": round(input_seconds, 3),
        "runtime_limit_minutes": 26,
    }
    timings_path.write_text(json.dumps(timings, indent=2) + "\n", encoding="utf-8")
    print(f"BirdNET+ V3.0 developer preview processed {clip_count} clips in the disposable, time-limited container.")
    print(f"CPU seconds per minute of audio: {timings['models'][MODEL_ID]['cpu_seconds_per_minute']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
