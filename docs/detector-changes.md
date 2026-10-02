# Detector changes (revert log)

Every Scrypted setting or file changed for the "spotter" (first-stage animal detector) work is listed here with old and new value.
Revert a setting by putting the old value back (Scrypted UI, or `node detector-eval/deploy/scrypted_set.mjs <device id> <key> <old value>`).
Whole detector: `detector-eval/deploy/rollback_detector.sh [--unpatch]`.

| time (UTC) | device | setting | old | new | note |
|---|---|---|---|---|---|
| 2026-10-02T01:09:51.363Z | ONNX Object Detection (152) | `model` | `"Default"` | `"kestrel_ens_c448"` | ONNX plugin detector model (revert: set back to Default) |

## Files and source edits (not Scrypted settings)

| time (UTC) | what | where | revert |
|---|---|---|---|
| 2026-10-01 ~21:05 | ONNX plugin source patched (3 edits: accept local detector models in `files/local-models/`); original saved | `/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/zip/unzipped/ort/__init__.py` (+ `.orig`) | `detector-eval/deploy/rollback_detector.sh --unpatch` |
| 2026-10-01 ~21:05 | New model file `kestrel_ens_c448` (today's yolov9c@320 for person/vehicle/animal + MegaDetector cedar@448 for animals, fused into one ONNX, 202 MB) | `/mnt/nvme/appdata/scrypted/plugins/@scrypted/onnx/files/local-models/kestrel_ens_c448/model.onnx` | delete the folder after rollback |

The first row of the table above (ONNX Object Detection device 152, setting `model`: `Default` -> `kestrel_ens_c448`) is the only Scrypted setting changed. No camera, zone, threshold, classifier, Kestrel or Home Assistant setting was touched.
A Scrypted plugin update replaces `zip/unzipped/` (patch lost); the plugin then resets unknown model names to Default by itself. Re-apply with `detector-eval/deploy/install_detector.sh kestrel_ens_c448`.

**Backup (2026-10-02T01:18:28.832Z):** all object-detection (134) and motion (135) settings of Backyard Camera (88) saved to `/data/home/Kestrel/detector-eval/data/backup/camera88_zones_1790903908837.json` before the Backyard zone change.
| 2026-10-02T01:19:05.393Z | Backyard Camera (88) | `objectdetectionplugin:135:zones` | `["Path"]` | `["Path","Yard"]` | Backyard: add motion zone Yard (Path untouched). Revert: zones back to ["Path"] |
| 2026-10-02T01:19:06.907Z | Backyard Camera (88) | `objectdetectionplugin:135:zone-Yard` | `"[]"` | `"[[0.098,0.238],[0.215,0.148],[0.745,0.248],[0.745,0.995],[0.351,0.999],[0.115,0.688]]"` | Yard polygon (normalised) = lawn without the brush right of the tree |
| 2026-10-02T01:19:08.420Z | Backyard Camera (88) | `objectdetectionplugin:135:zoneinfo-type-Yard` | `"Intersect"` | `"Intersect"` | Yard motion zone type |
| 2026-10-02T01:19:09.931Z | Backyard Camera (88) | `objectdetectionplugin:135:zoneinfo-filterMode-Yard` | `"Default"` | `"include"` | Yard motion zone filter mode |
| 2026-10-02T01:19:11.444Z | Backyard Camera (88) | `objectdetectionplugin:134:zoneinfo-classes-Grass` | `["person","animal"]` | `["animal"]` | Backyard: Grass object zone animal only. Revert: ["person","animal"] |
