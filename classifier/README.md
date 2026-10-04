# Wildlife Classifier

The model behind Kestrel's "what animal is that": when Scrypted's NVR spots an
**animal**, this looks at the crop and names it — "Northern Cardinal", "Common
Raccoon", "Eastern Gray Squirrel" — or says nothing when it isn't sure. It
replaces Scrypted's stock **Bird Classifier**, and also knows mammals.

## How it works

1. **The model:** [EVA-02 Large, fine-tuned on iNaturalist 2021](https://huggingface.co/timm/eva02_large_patch14_clip_336.merged2b_ft_inat21)
   (92.1% top-1 across 10,000 species).
2. **Trimmed to your area:** only the birds and mammals with research-grade
   iNaturalist sightings within 50 km of home are kept (plus domestic cats and
   dogs, which iNaturalist does not count as wild). Fewer choices means it can't
   guess a bird from another continent. For home (Atlanta area) that is
   **268 classes: 233 birds, 35 mammals** — see [`species/atlanta.json`](species/atlanta.json).
3. **Exported to ONNX** in the exact shape Scrypted's ONNX plugin loads as a
   custom model, checked against PyTorch on export.
4. **Installed into Scrypted** as the *Animal Classifier* on the cameras you pick.
   Scrypted loads it once and keeps it on the GPU.

## Results

390 photos of the 60 most-seen local birds and 20 most-seen local mammals, all
taken **2023 or later**, so neither model can have trained on them. Each photo
is scored three ways: as taken, degraded like a crop out of a compressed
security-camera stream, and the same in grayscale like IR night vision.
"Shown and right" is what you actually experience: of the labels Scrypted
would display (score above 50%), how many are correct.

| Birds (290 photos both models know) | Wildlife Classifier | Stock Bird Classifier |
|---|---|---|
| Clear photo: right first guess | **86%** | 40% |
| Clear photo: shown and right | **94%** | 59% |
| Camera quality: right first guess | **64%** | 17% |
| Camera quality: shown and right | **86%** | 33% |
| Night (IR): right first guess | **42%** | 4% |
| Night (IR): shown and right | **74%** | 6% |

| Mammals (100 photos) | Wildlife Classifier | Stock Bird Classifier |
|---|---|---|
| Clear / camera / night: right first guess | **87% / 62% / 44%** | cannot (birds only) |

Full numbers: [`eval/results.json`](eval/results.json). Two honest caveats:
test photos are whole iNaturalist shots rather than detector crops (both models
got identical inputs), and nothing beats checking real visits from your own
cameras once birds are around.

**On the Tesla P40:** about **100 ms per animal** and about **2 GB of GPU
memory**. The file is ~1.2 GB. A newer GPU runs the same file faster; from
roughly RTX 20-series on, it can be rebuilt in half precision for half the memory.

## Build it

Requires Python 3.10+ (CPU is fine; the export takes a few minutes and ~6 GB RAM).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt

# 1. iNat21 class list (10 MB)
mkdir -p data && curl -s https://ml-inat-competition-datasets.s3.amazonaws.com/2021/val.json.tar.gz | tar xz -C data
.venv/bin/python -c "import json; d=json.load(open('data/val.json')); json.dump(sorted(d['categories'], key=lambda c: c['id']), open('data/inat21_categories.json','w'))"

# 2. Local species -> species/<place>.json
.venv/bin/python build/species.py --lat 33.75 --lng -84.39 --out species/atlanta.json

# 3. Trim + export -> dist/wildlife-atlanta/{model.onnx,config.json}
.venv/bin/python build/export.py --species species/atlanta.json --out dist/wildlife-atlanta
```

### Seasonal prior (not part of the model)

`species/atlanta-weekly.json` says how common each species is around Atlanta in each of
the year's 48 quarter-months, for the plugin to judge whether a detection is plausible
this week. Stdlib only, no login; reruns from a local cache:

```bash
python3 build/seasonal.py                          # iNaturalist, Fulton + DeKalb GA, 2016-2025
python3 build/seasonal.py --ebird-tsv fulton.tsv dekalb.tsv   # eBird bar-chart TSVs for birds
```

eBird's login and bar-chart pages sit behind a bot check, so the TSVs have to be downloaded
by hand from ebird.org/barchart (US-GA-121, US-GA-089). The TSV reader has only been run
on a synthetic file, not a real eBird download.

## Test it

```bash
.venv/bin/python eval/make_testset.py --species species/atlanta.json       # downloads ~400 photos to data/
.venv/bin/python eval/evaluate.py --wildlife dist/wildlife-atlanta \
    --baseline path/to/bird-classifier   # optional: a dir with the stock model.onnx + config.json
```

## Install into Scrypted

```bash
cd deploy && npm install
./stage.sh ../dist/wildlife-atlanta            # copies the files into Scrypted's volume on the host
SCRYPTED_USER=... SCRYPTED_PASS=... ./install.sh wildlife-atlanta \
  "Front Door Camera,Back Door Camera,Bird Camera,Backyard Camera" "Bird Classifier"
```

`install.sh` creates the **Wildlife Classifier** device in the ONNX plugin,
sets it as the animal classifier on exactly the cameras listed (and removes it
from any others), and deletes the classifier named in the last argument.
Scrypted only downloads custom models over http(s), so for those few seconds the
files are served from inside the Scrypted container on `127.0.0.1` — never on
the network. Re-running is safe.

## Teach it from your corrections

Every "Wrong?" correction in Kestrel is saved with its crop. `build/retrain.py`
retrains only the final layer (one row of weights per species) from those crops,
held close to the current weights so a handful of corrections nudges the model
rather than overwriting it. It installs the result **only if both gates pass**:

1. On corrections it did not train on (k-fold), it beats the current model by `--min-gain`.
2. On the evaluation photos (camera-quality variant), first-guess accuracy drops by no more than `--max-drop`.

```bash
.venv/bin/python build/retrain.py \
    --plugin http://<scrypted-host>:11080/endpoint/@nphil/kestrel/public/ --key-file <key file> \
    --install      # omit to only report whether it would win
```

`--install` swaps the model behind the existing Scrypted device (keeping
`model.onnx.prev`) and reloads the ONNX plugin. Roll back with
`deploy/swap-model.sh --rollback <device id>`.

## Licences

- Model weights: EVA-02 iNat21 fine-tune by timm, **CC BY-NC 4.0** — personal,
  non-commercial use. The exported model inherits this.
- iNaturalist data: the class list comes from the iNat 2021 competition; test
  photos are downloaded at evaluation time, stay local and are not redistributed.
