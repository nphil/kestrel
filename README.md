<p align="center"><img src="assets/banner.png" alt="Kestrel: cameras and wildlife AI for Home Assistant" width="100%"></p>

# Kestrel

A calm, fast **Cameras** panel for Home Assistant, built on
[Scrypted](https://scrypted.app), with wildlife AI on top: it names the birds
and animals your cameras **see** and **hear**, keeps a life list, sends a
notification that opens straight to the clip, and learns from your corrections.

Kestrel deliberately does **not** copy what Scrypted already does well (recording
timelines, scrubbing, search, face training) — every view links out to Scrypted
for those.

| Live | Wildlife | AI check-up (phone, glass theme) |
|---|---|---|
| ![Live](docs/screenshots/live-wide-neumorphism-light.png) | ![Wildlife](docs/screenshots/wildlife-wide-neumorphism-light.png) | ![AI check-up](docs/screenshots/insights-phone-glass-dark.png) |

## What you get

- **Live** — every Scrypted camera in one grid with honest status chips
  (Online / Unstable / Offline, "Snapshot only" where there is no stream). Tap for
  the focused player; "Open in Scrypted" for history.
- **Visit** — where a notification lands: the snapshot immediately, a
  "Saving clip…" progress bar while the recorder finishes, then the clip plays.
  Tap an old notification later and it just plays.
  A round **Show detection boxes** button on the clip (top right) draws what the camera's
  detector saw over the playback: a box around each animal with the name the wildlife
  classifier gave it at that moment ("Coyote", or "Animal 82%" before it had decided), so
  you can see exactly what the model made of the animal before you correct it. Tap a box to
  open "What was it?". Your choice is remembered; visits recorded before this feature, and
  clips with no boxes, simply have no button.
  An administrator can delete a visit's clip from its page ("Delete clip"), or prune many
  at once under the gear button (Settings, **Saved clips**): all clips older than 1 month,
  3 months, 6 months or a year, or those from visits marked *Not an animal* / *Can't tell*.
  Every delete first says how many clips go and how much space that frees, and that photos
  and visits are kept; only the video is removed.
- **Wildlife** — your life list: every species seen or heard, best photo (or a
  labelled reference photo with its photographer and licence), first/last seen,
  which cameras, what time of day, new-this-year badges, and the recorded call for
  heard species.
- **Play reference** — on any species (its sheet, and a heard visit) *Play reference*
  plays what it actually sounds like, labelled *Reference · Xeno-canto* or
  *Reference · iNaturalist* so it is never mistaken for one of your own recordings,
  with who recorded it and under which licence. Birds get a *Song* and a *Call* when
  the source has them.
- **Corrections** — "Wrong?" on any visit: pick the right species (suggestions
  first), *Not an animal* or *Can't tell*. The visit is fixed everywhere at once,
  similar-looking animals at that camera are relabelled after a few corrections of
  the same mix-up, and the retrain tool can teach the model itself.
- **AI check-up** — a review queue for unsure calls, cameras that trigger AI checks
  with nothing found, detector / GPU / storage health, and BirdNET status.
- **Notifications** — one per visit, with the snapshot, deep-linked to the visit.

Built in the **Lucent** design language on the shared
[lucent-ha](https://github.com/nphil/lucent-ha) toolkit: it takes its colours
from your Home Assistant theme (flat or glass), keeps the menu button one tap
away, closes a sheet with Back before leaving a page, remembers each tab's
scroll, works from 320 px phones to wide screens, and stays light — one ~75 KB
(gzipped) bundle, bounded storage, no polling. After Home Assistant restarts,
open pictures and recordings come back by themselves, with no reload.

## How it fits together

```
cameras ─▶ Scrypted NVR ─▶ Wildlife Classifier (ONNX, GPU) ─┐
                         └▶ Events Recorder (clips) ─────────┤
camera mics ─▶ BirdNET-Go (HA app, Perch v2) ─▶ MQTT ────────┤
                                                             ▼
                              Kestrel Scrypted plugin (visits, corrections, media, API)
                                                             │  key-authenticated LAN API
                                                             ▼
                              Kestrel HA integration ─▶ entities, WebSocket API, signed media
                                                             ▼
                                                  Cameras panel (sidebar)
```

| Folder | What it is |
|---|---|
| [`scrypted-plugin/`](scrypted-plugin) | `@nphil/kestrel` — the Scrypted plugin: turns detections and BirdNET calls into visits, links clips, stores corrections and learning data in SQLite with strict retention, serves the API and media. |
| [`custom_components/kestrel/`](custom_components/kestrel) | The Home Assistant integration (HACS): config flow, entities, WebSocket API for the panel, authenticated media proxy, brand icons. |
| [`dashboard/`](dashboard) | The panel (Lit + TypeScript on lucent-ha), built into the integration. |
| [`classifier/`](classifier) | The Wildlife Classifier: EVA-02 (iNaturalist 2021) trimmed to your local species, exported to ONNX for Scrypted; evaluation and the retrain tool. |
| [`audio-eval/`](audio-eval) | The bird-sound model bake-off behind the BirdNET-Go settings ([results](audio-eval/results.md)). |
| [`tools/`](tools) | Reproducible brand and banner renderers. |

## The models, and how well they do

**Seeing — Wildlife Classifier.** [EVA-02 Large fine-tuned on iNaturalist 2021](https://huggingface.co/timm/eva02_large_patch14_clip_336.merged2b_ft_inat21),
cut down to the birds and mammals recorded near home (268 classes for the Atlanta
area). On 390 photos taken 2023 or later (so neither model trained on them),
against Scrypted's stock bird classifier:

| Birds | Kestrel | Stock |
|---|---|---|
| Clear photo, first guess right | **86%** | 40% |
| Camera-quality crop | **64%** | 17% |
| Night (IR) | **42%** | 4% |

Mammals, which the stock model can't name at all: 87% / 62% / 44%. About 100 ms per
animal on a Tesla P40. Details: [`classifier/README.md`](classifier/README.md).

**Hearing — BirdNET-Go with Google Perch v2.** Tested on 483 local bird calls mixed
into real audio from the cameras: Perch v2 beat BirdNET v2.4 at every loudness
level (59/50/32% vs 53/37/11% loud/medium/faint) with **zero** false alarms on bird-free
audio. Audio "clean-up" filters didn't reliably help, so none run live.
Details: [`audio-eval/results.md`](audio-eval/results.md).

## Install

1. **Classifier** — build and install into Scrypted's ONNX plugin
   ([`classifier/README.md`](classifier/README.md)), attach it as the *Animal Classifier*
   on your exterior cameras.
2. **Scrypted plugin** — `cd scrypted-plugin && npm install && npm run build &&
   npm run scrypted-deploy <scrypted-host>:10443`. In its settings pick the cameras
   to watch; copy the API key it shows.
3. **Home Assistant integration** — HACS → Custom repositories → add
   `https://github.com/nphil/kestrel` (Integration) → install → restart → add
   *Kestrel* with the plugin URL (`http://<scrypted-host>:11080/endpoint/@nphil/kestrel/public/`)
   and the key. A **Cameras** item appears in the sidebar.
4. **Optional: hearing** — install the BirdNET-Go app, enable the Perch v2 model,
   add the camera streams by name, and point its MQTT at your broker (topic
   `birdnet`, HA discovery off); map stream names to cameras in the plugin settings.
   Set the app's `BIRDSONGS_FOLDER` option to `/media/birdnet-go/clips` (create the
   folder first): Home Assistant's backups include app folders but not `/media`, so
   30 days of recordings would otherwise grow every nightly backup by several GB.
   Perch hears more than birds: mammals and frogs are kept (event types `mammal` /
   `other`), insects are ignored.
   **Bird-call previews** (optional): run the `kestrel-audio` service on a machine
   with a GPU (or a few CPU cores), then enter its address and key under Settings →
   Devices & Services → Kestrel → Configure. Each heard call is then played as the
   moment the model matched, made loud and, only where a re-check proves it helps,
   cleaned up, with an *Original* toggle to hear BirdNET-Go's full recording. Home
   Assistant sends the service every new call and, gradually, past calls too (the
   *Backfill past calls (days)* setting: 30 by default, 0 sends only new calls;
   raising it later only sends what is missing). If the service is off or
   unreachable, calls simply play the original recording.
   BirdNET-Go sometimes announces a call with detection number 0 but a real clip
   (the same species was heard on the other camera moments earlier). Those calls
   are played from the clip by its name, always as the original recording, because
   the preview service is keyed by detection number.
   **Local species filter**: the panel's gear button (Settings) shows how many species
   BirdNET-Go currently allows near you and lets a Home Assistant administrator choose
   how strict that is (Loose 1%, Balanced 3%, Strict 5%, Very strict 10%). Kestrel
   changes only BirdNET-Go's range-filter threshold and keeps its other settings;
   BirdNET-Go then rebuilds its species list, which takes a few seconds.
   **Keep this recording**: BirdNET-Go deletes recordings older than its retention age
   (30 days by default). A heard visit's page has a *Keep recording* button (a Home
   Assistant administrator can press it; everyone else sees whether it is on). It
   locks that detection in BirdNET-Go, and BirdNET-Go's clean-up skips locked
   detections, so the sound stays for good; pressing it again lets the normal
   clean-up apply. Calls announced with detection number 0 (see above) have no
   BirdNET-Go detection of their own to lock, so they show no button.
   **Both models agreed**: BirdNET-Go runs BirdNET v3.0 and Perch together and keeps which of them heard
   each call. The Home Assistant integration reads that list for every new heard visit and tells the plugin
   (it never changes BirdNET-Go). When two different models named the visit's species, the visit page and
   the review list show a small *Both models agreed* chip and the plugin counts it as evidence toward
   *Likely* (the 60 % floor and the rare-bird rule still apply, and two models naming different animals is
   still a *Check*). BirdNET-Go's own *unlikely* tag is trusted too: such a call is never *Likely* and goes
   to *Check* with the reason "BirdNET-Go thinks this may not be a real call." Agreement is a hint, not proof
   (`audio-eval/results.md` measured it as no better than one model alone).
   **Corrections reach BirdNET-Go**: when a Home Assistant administrator confirms a heard visit, picks another
   species or marks it *Not an animal*, Kestrel also tells BirdNET-Go (reviewed *correct*, species changed,
   or *false positive*). It waits 11 seconds so the 10-second *Undo* can still take it back. This is best
   effort: if BirdNET-Go is slow or down, the correction in Kestrel stands, one warning is logged and the
   attempt shows in the integration's diagnostics (`birdnet_reviews`; the models lookup above is
   `birdnet_models`). Locked detections are never touched, and "also heard" is not sent. BirdNET-Go has no
   way to clear a review, so an *Undo* after the change was sent puts the earlier answer back where there
   was one and otherwise leaves BirdNET-Go's verdict as it is (the diagnostics say so).
5. **Optional: reference sounds and photos** — nothing to set up: *Play reference* uses
   recordings from [iNaturalist](https://www.inaturalist.org). For clearer, quality-rated
   songs and calls, add a free [Xeno-canto](https://xeno-canto.org) API key (shown on
   your account page there) under Settings → Devices & Services → Kestrel → Configure;
   it is tried first and iNaturalist fills in what it lacks. A species is looked up
   the first time you press the button and the answer is kept 45 days (7 days when
   nothing was found). A recording is downloaded the first time it is played and kept
   on the Home Assistant host (at most 64 MB in `.storage/kestrel_reference`, least
   recently played removed first). (Cornell's Macaulay Library, which Merlin uses, is
   not an option: its search is behind a bot check.)
   **Reference photos** work the same way and need nothing either: a species without a
   photo of your own gets BirdNET-Go's picture if it has one (birds), else iNaturalist's
   default photo (mammals, frogs, insects), else the picture of its Wikipedia article.
   The panel names the photographer and licence under the picture. Looked-up pictures
   are kept 30 days (a week when no source has one) and downloaded on first view into
   `.storage/kestrel_reference_photos` (at most 48 MB, least recently shown removed first).
   **Species descriptions** are the same kind of lookup: a species' sheet shows the first few
   sentences of its Wikipedia article (the article of its scientific name, which BirdNET-Go or
   iNaturalist tells Kestrel), credited and linked, under the article's CC BY-SA 4.0 licence. They
   are kept 30 days (a week when there is no article) in `.storage/kestrel.species_descriptions`
   and asked for when a sheet opens: the sheet opens at once and its *About* text fills in when Wikipedia
   answers; a slow or missing article just leaves it out.
   **Weather and spectrogram** on a recording need nothing to set up either, but need BirdNET-Go:
   a heard visit (or a sighting with its call linked) shows the weather when the bird called, in
   your Home Assistant's temperature unit, if BirdNET-Go has a weather source set up, and a
   spectrogram (a picture of the sound, drawn by BirdNET-Go from the saved recording). Kestrel
   keeps neither; it asks BirdNET-Go when a sheet opens and remembers the weather in memory.
   When BirdNET-Go is slow, or has not drawn a picture yet, the recording shows a quiet
   *Picture not ready* instead of a broken image and the panel asks again by itself while the
   picture is on screen (after 2 seconds, then 15, 45, 120 and 300 seconds, about 8 minutes in all, then it
   stops); Kestrel's own answer to a picture never takes longer than 10 seconds, and opening a
   sighting's recordings asks the Scrypted plugin once, however many recordings it has.
6. **Optional: notifications** — an automation on the `event.kestrel_*` entities;
   each event carries `species`, `visit_id`, `notify` and `first_ever`, and the visit
   page is `/kestrel/visit?v=<visit_id>`. An event fires once, when a visit is first
   created; later changes to that visit (its clip finishing, a correction, a merge)
   never fire it again, not even after Home Assistant restarts.

**Camera clips stopped (visits say "No clip was saved").** Kestrel looks for a visit's clip at the
Events Recorder plugin first; if that has none 90 seconds after the visit started, Kestrel cuts the
clip itself from Scrypted NVR's continuous recording (5 s before the visit to 10 s after it, at most
60 s, H.264). Visits that already ended with no clip are given the same second chance at start-up and
once a day, as long as the NVR still has the footage (its "Video Retention (Days)", 3 by default), so
an outage of the Events Recorder is recovered rather than lost. Every clip is also copied into
Kestrel's own store on the NVR disk (`/NVR/kestrel/clips/<camera>/<visit>.mp4`), which neither the
Events Recorder's pruning nor the NVR's retention touches. The Events Recorder's published 0.0.52
(2026-10-05) does not load in Scrypted, and when it does run it saves a snapshot for every detection
update. `python3 tools/patch_events_recorder.py` downloads that release, fixes both and redeploys it;
re-run it if Scrypted reinstalls 0.0.52, and retire it once upstream ships a release that loads.

## Privacy and footprint

- Everything runs locally, with one exception: *Play reference*, the reference photos and the
  species descriptions ask iNaturalist, Wikipedia (and Xeno-canto, if you added a key) for a
  recording, a picture or a few sentences about a species **by name**, from the Home Assistant
  host. No picture, recording
  or camera data is sent, the browser never contacts those sites, and your Xeno-canto
  key goes only to Xeno-canto and is never written to a log or to diagnostics.
- The plugin API requires a key; media reaches the browser only through Home
  Assistant with signed, expiring links.
- Snapshots and crops are kept 30 days (except the best photo per species and
  corrected examples), visit history 3 years, learning data capped; Kestrel stays
  within a 300 MB budget and reports its size on the AI check-up page.
- Microphones near doors hear people: choose which cameras BirdNET-Go listens to,
  and keep its web UI behind Home Assistant.

## Development

- Home Assistant integration tests need no Home Assistant install:
  `python3 -m unittest discover -s tests -v`.
- Tests that load the real integration into Home Assistant (`tests/ha`) use Home Assistant's own
  test harness: `pip install "pytest-homeassistant[bluetooth]"`, then `pytest`. A weekly GitHub
  run repeats them against the current Home Assistant beta.
- Plugin tests: see [scrypted-plugin/README.md](scrypted-plugin/README.md).

### Kestrel bench: fake wildlife on demand

`tools/kestrel_bench` makes any animal show up in a test copy of Kestrel, so a screen can be checked without waiting
for a real bird. The idea comes from the bench in [Birdsong](https://github.com/dopeytree/birdsong). Nothing in it
touches your real cameras, Scrypted, MQTT or Home Assistant, and it needs no network.

```
node --experimental-strip-types tools/kestrel_bench/bench.mjs serve      # then open http://127.0.0.1:8770/bench
```

- **What it runs.** A small Kestrel plugin of its own, built from the plugin's real parts (the store on a temp
  database, the heard-call ingest, the sighting-and-call linker, the detection-box recorder), next to the dashboard's
  test page. It rebuilds the test page first, so it shows your current dashboard code. Ctrl-C stops it and deletes its
  temp folder (under `$CODY_DATA_SCRATCH`, else the system temp folder).
- **Heard.** Type a few letters of an animal and pick it. The bench sends a message shaped like BirdNET-Go's MQTT
  message (BirdNET v3.0, Perch, old 2.4 or none; "the two disagree"; tagged "unlikely"; common, rare or unknown occurrence; a clip name)
  through the plugin's own reader. You see the tier Kestrel gives it (Likely, Possible, Check), repeats and first-ever
  flags. An insect call is dropped, as the real plugin does.
- **Seen.** An animal walks across a camera, 12 detection events with a moving box (named after the first second,
  with a second unnamed animal passing), plus a 3 second clip. Open the visit and switch the box button on to check the
  overlay on a 16:9, 4:3 and portrait picture (cameras 88, 103, 104).
- **Again, Drop, Reset.** Again sends the same thing as a new moment (a bird heard again soon folds into its visit as a
  repeat). Drop takes back the newest visit. Reset wipes the sandbox.
- **From a terminal** (a running bench is needed for everything but `search`):
  `bench.mjs search card`, `bench.mjs hear "great horned owl" --model disagree`, `bench.mjs hear "winter wren" --unlikely`, `bench.mjs see coyote --camera 103`,
  `bench.mjs again | drop | reset | state`; `--json` gives the raw answer.
- **Species** come from `classifier/species/atlanta.json` (what a camera can name) merged with
  `tools/kestrel_bench/data/birdnet-go-labels.txt`, a snapshot of the BirdNET-Go add-on's range-filter list (refresh it
  by saving that list's `label` fields over the file).
- **The test page can show it without the bench page:** `/kestrel/wildlife?bench=1` reads the bench's data.
  Visits made in the bench can be opened and corrected there like the fixtures; the correction stays in the page.
- **Tests:** `node --experimental-strip-types --test tools/kestrel_bench/test/*.test.mjs` checks every message and
  event shape against the plugin's real readers and runs the sandbox end to end.
- **Not covered:** it does not publish to a real MQTT broker, and BirdNET-Go's live message shape could not be captured
  (the broker wants a login), so the message follows what the plugin reads (`scrypted-plugin/src/heard.ts`).

## Licences

- Kestrel code: MIT ([LICENSE](LICENSE)).
- EVA-02 iNat21 weights (timm): CC BY-NC 4.0 — personal, non-commercial use; the
  exported classifier inherits this.
- Inter typeface (`tools/fonts`): SIL Open Font License.
- BirdNET-Go and its models keep their own licences.
- Reference recordings belong to their recordists (Xeno-canto: Creative Commons,
  mostly BY-NC-SA; iNaturalist: the observer's licence, sometimes all rights
  reserved). Kestrel names the recordist and links to the recording's page; it is for
  personal, non-commercial listening.
- Reference photos belong to their photographers (iNaturalist: the photographer's
  licence, often all rights reserved; Wikipedia: the Wikimedia Commons licence, shown
  with the picture). Kestrel names the photographer and links to the source; it is for
  personal, non-commercial viewing.
- Species descriptions are the opening sentences of the species' Wikipedia article, shared under
  CC BY-SA 4.0 ([creativecommons.org](https://creativecommons.org/licenses/by-sa/4.0/)). Kestrel
  credits Wikipedia and links to the article.
