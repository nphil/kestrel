# Kestrel "spotter" study: why so few animals, and what we changed

Written 2026-10-01 by DetectorAgent. Plain language first; numbers and revert steps further down.

## Bottom line

1. **A better animal detector exists, and it is now live.** Scrypted's own detector (the "spotter") is weak at wildlife: on 390 clean iNaturalist photos it finds only 12 % of birds and 29 % of mammals. The wildlife detector MegaDetector (build "cedar") finds about 70 % of both. But on its own it is *worse* at people and at tiny/blurry/night animals, so I did **not** swap models. I fused both into one file: Scrypted's model still handles people, vehicles and anything it already saw; MegaDetector-cedar adds animals. On 726 test composites plus 24 real frames, at today's threshold (0.7) it finds **25 % instead of 18 %** of animals (birds 19 % vs 9 %, night 19 % vs 11 %, mammals 30 % vs 25 %) with **zero** false alarms on 1,675 empty frames, same as today. People and cars: identical to today (99 % / 100 % on 89 hand-checked boxes).
2. **"Resolution" is not the main problem, the camera pipeline is.** Scrypted NVR only shows the detector small patches around *motion*, and it throws away motion that is small. With today's rules only **7 % of animals under 32 px, 8 % of 32-64 px, 36 % of 64-128 px** ever reach the detector (70 % at 128-256 px, 84 % above). No model can fix that. Two real chipmunk visits on the Front Door on 30 Sep / 1 Oct were never looked at: one sat in the bottom 10 % of the picture (the NVR ignores the top and bottom 10 % unless a motion zone exists), the other was a 72x40 px blob below the NVR's size floor. This cannot be fixed with a setting on cameras that have no motion zone; it needs either your decision on zones (below) or a separate Kestrel-side spotter.
3. **The Backyard camera (88) is effectively blind to animals**: its only motion zone ("Path") is a thin triangle and "Contain" means the whole animal must sit inside it. Test animals on the lawn: 0 of 116 reached the detector.
4. **Nothing needed from you for the new detector.** It is installed and reversible (see "What I changed"). Decisions that would help more are listed at the end.

## What the pipeline really does (so the numbers make sense)

Camera -> NVR motion finder -> keeps only motion blobs bigger than about 45x45 px (1080p) or 80x80 px (doorbells), ignores the top/bottom 10 % -> takes the 3 biggest, cuts a square around each (x1.5) and squashes it to the detector's input (320x320 today) -> detector -> animal must score 0.7 and sit inside the camera's zone -> Wildlife Classifier names it -> Kestrel makes a visit. Source: the installed NVR and ONNX plugin code (notes in `research/pipeline-notes.md`).

## Test material (all under `detector-eval/data`, not in git)

* **Real empty footage:** 1,675 frames from the 4 cameras (Front Door 555, Back Door 570, Backyard 290 usable of 82 scenes, Bird Camera 260 live), day, dusk, night/IR, wind, shadows, glare, moths, fog. Checked by eye and by two detectors.
* **Real animals:** Front Door raccoon (13 frames) and two chipmunk visits the NVR missed (11 frames).
* **726 composites:** 470 real iNaturalist animal/bird cut-outs (82 species, CC licences, local use only) pasted at 5 realistic size classes into empty frames of each camera, day and night/IR. They look camera-made but are not real animals: lighting never quite matches. Treat them as a ranking tool, not as exact percentages.
* **Person/vehicle regression:** 50 NVR-event frames (67 people, 22 vehicles).

## Results

**What reaches the detector today (NVR gate, 750 animals)**

| animal size | share the NVR even shows to the detector |
|---|---|
| under 32 px | 7 % |
| 32-64 px | 8 % |
| 64-128 px | 36 % |
| 128-256 px | 70 % |
| 256 px and up | 84 % |
| all | 40 % |

**Detector comparison, animals found through the NVR's own cropping (1,675 empty frames for false alarms)**

| detector | threshold | all | <32 | 32-64 | 64-128 | 128-256 | >=256 | day | night/IR | birds | mammals | false-alarm frames /1000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **today: Scrypted yolov9c 320** | 0.7 (live) | 18 % | 0 | 1 | 8 | 36 | 49 | 22 | 11 | 9 | 25 | 0 |
| today, looser | 0.5 | 22 % | 0 | 1 | 12 | 45 | 58 | 27 | 15 | 14 | 29 | 3.6 |
| MegaDetector v6 yolov9c @448 alone | 0.7 | 15 % | 0 | 1 | 2 | 29 | 54 | 16 | 15 | 12 | 19 | 3.0 |
| MegaDetector cedar @448 alone | 0.7 | 21 % | 0 | 1 | 10 | 40 | 66 | 24 | 18 | 16 | 26 | 0 |
| **fused: today + cedar@448 (installed)** | **0.7** | **25 %** | 0 | 1 | 13 | 48 | 72 | 29 | 19 | **19** | **30** | **0** |
| fused | 0.5 | 27 % | 0 | 1 | 16 | 54 | 75 | 32 | 21 | 22 | 33 | 3.6 |

With a *perfect* crop around every animal (detector only, no NVR gating) the fused model finds 36 % vs 26 % at 0.7 (64-128 px: 26 % vs 14 %, 128-256 px: 72 % vs 56 %, 256 px+: 91 % vs 67 %) and 42 % vs 33 % at 0.5. Both models fail below about 50 px.

Per camera, NVR path at 0.7 (today -> fused): Back Door 17 -> 25 %, Front Door 26 -> 35 %, Bird Camera 19 -> 26 %, Backyard 0 -> 0 %.

Real animals: raccoon seen through the NVR 3/13 -> 5/13 frames; chipmunk 0/11 -> 0/11 (blocked by the NVR rules, not the model). With a perfect crop and threshold 0.5: raccoon 4/13 -> 9/13, chipmunk 3/11 -> 6/11.

Other models tried (iNaturalist photo test, share of clean bird / mammal photos found at 0.7): today 12 % / 29 %; MegaDetector cedar 320-512 about 70 % / 65 %; MDv6 yolov9c@640 42 % / 45 %; COCO yolo11m 81 % / 39 % (but it can only name bird/cat/dog-type animals, so raccoon, squirrel, fox and deer would be dropped by the NVR). On small blurry/night crops every model is weak; smaller input sizes do better there (hence 448, not 640). Full tables: `research/models-report.md`, `research/options.md`.

**People and vehicles (regression, 67 people / 22 cars, perfect crop)**: today 99 % / 100 %; fused 99 % / 100 % (identical by construction: people and cars still come from today's model); MegaDetector alone: cedar 90 % / 100 %, MDv6@640 only 79 % / 86 %, so a plain model swap would have hurt people detection.

**Speed and memory on the Tesla P40** (PROVISIONAL: the host was under heavy load; clean re-measurement pending): today's model 12.8 ms and 518 MB (clean run); cedar@448 about 17 ms; the fused file measured 28 ms (median, loaded host) per crop. After loading, the ONNX plugin process went from 4,492 MiB to 4,692 MiB of GPU memory (+0.2 GB, to be re-checked after hours of traffic; limit +1 GB). TensorRT/INT8 is not possible inside Scrypted (no TensorRT library, and current TensorRT dropped this GPU generation), so everything runs in FP32.

## What I changed (revert steps)

Full old -> new log: `/data/home/Kestrel/docs/detector-changes.md`.

1. **ONNX plugin source patched** (3 small edits in `.../plugins/@scrypted/onnx/zip/unzipped/ort/__init__.py`; original kept next to it as `__init__.py.orig`): lets the plugin load models from `.../files/local-models/<name>/model.onnx`. Script: `deploy/patch_onnx_local_models.py`.
2. **New file** `.../plugins/@scrypted/onnx/files/local-models/kestrel_ens_c448/model.onnx` (202 MB, built by `scripts/build_ensemble.py` from today's model + MegaDetector cedar @448).
3. **ONNX Object Detection (device 152), setting "Model": `Default` -> `kestrel_ens_c448`.** The plugin restarted itself (~1 min of no detections, seen once as a "RpcPeer killed" line).
4. Nothing else: no thresholds, zones, classifier, Kestrel or Home Assistant settings were touched.

**Revert:** `detector-eval/deploy/rollback_detector.sh` (sets Model back to Default; add `--unpatch` to restore the plugin file). If the model ever fails to load, the plugin falls back to the stock model by itself. A Scrypted plugin update would remove the patch; the plugin then also falls back to the stock model; re-run `deploy/install_detector.sh kestrel_ens_c448` to put it back.

**Live check after the change:** the plugin reports model `kestrel_ens_c448`, input 448, classes person/vehicle/animal; test frames came back as person 0.94 / 0.86, vehicle 0.92, raccoon frame animal 0.60, a mammal composite animal 0.82; camera sessions kept running. Before/after snapshots are in `data/live-stats/`. Real animals are rare, so the true effect needs days of visits to show; the Bird Camera ran 102 detection sessions and 66,876 crops in 12 h before the change with zero animals saved.

## Decisions for you (and one physical thing)

1. **Backyard camera motion zone ("Path")**: widen it to the lawn or the camera cannot see animals. This also affects person alerts on the lawn, so it is your call.
2. **Doorbell cameras (Front/Back Door) ignore the bottom 10 % of the picture**, which is exactly where animals first arrive on the steps. Adding a full-frame *motion zone* removes that, but requires switching on Scrypted's "Accelerated Motion Detection" extension on those cameras, which can change when person alerts fire. I did not do it. I can try it on the Bird Camera first if you agree.
3. **Small animals (chipmunk/bird size, under about 100 px)** are blocked by a size rule inside the NVR that has no setting. Options: patch the NVR (closed source, not recommended) or build a small **Kestrel-side spotter** that watches the camera streams with its own motion finder and this fused detector. Cost estimate from the tests: about 3 crops per frame instead of 0.7 (roughly 4x the detector work) unless it also requires the animal to persist over a few frames.
4. **Bird Camera**: it looks through a window at a feeder that sits almost on the lens, so feeder birds are out of focus and cut off, and its zone is "Contain" (the whole bird must be inside the lower 40 % of the picture). Moving the feeder 40-60 cm away in front of the glass, or aiming the camera at it, would help more than any model. The Tapo C120 tops out at 1080p, so there is no higher-resolution setting to switch on.
5. Optional: lowering the animal threshold from 0.7 to 0.5 adds only about +2 points of recall for about 4 false-alarm frames per 1,000; not applied. Each false animal becomes an "Unidentified animal" visit in Kestrel.

## Caveats

* Composites are synthetic; real animals behave differently (recall of real frames is similar but the sample is tiny: 24 frames).
* Speed figures are provisional (host load 20-90 at the time). Accuracy and memory results are not affected.
* MegaDetector weights licence is not stated explicitly (repo MIT, YOLOv9 code GPL-3.0): fine for this home install.
* The classifier step (Wildlife Classifier on the better crops) was not re-measured in this pass.
