# Kestrel Scrypted plugin

Kestrel watches selected Scrypted cameras for wildlife visits, stores visits and review corrections in SQLite, links finalized Events Recorder clips, learns from corrections with CLIP, and ingests BirdNET-Go detections over MQTT. Home Assistant reads the authenticated JSON and media API; this plugin does not publish MQTT discovery or Home Assistant events.

The first run creates a private API key shown read-only in the plugin settings. Add the base URL `http://192.168.1.69:11080/endpoint/@nphil/kestrel/public/` and that key to the Home Assistant Kestrel integration. Every JSON and media request uses the `X-Kestrel-Key` header.

Choose the wildlife cameras in Settings. The initial set is Backyard (88), Back Door (103), Front Door (104) and Bird (106). BirdNET-Go subscribes to the configured MQTT topic (default `birdnet`) and its subtopics; the MQTT username and password are copied from Scrypted MQTT device 202 when those settings are empty.

Visits are created from Scrypted animal detections after a 30-second unidentified grace period, with a 10-minute per-camera/species cooldown. The cooldown counts earlier *seen* visits only: a bird that was merely heard (BirdNET-Go) never blocks a sighting of it, and the sighting is linked to the call when the call was heard within two minutes of it on the same camera. Snapshot and crop media are retained for 30 days unless a species best photo or correction uses them; visit rows are kept for three years. Nightly maintenance runs at 03:30 and keeps the plugin's media under a 300 MB budget.

Detections of one animal at one moment are one visit, whatever each detection is labelled: a detection on the same camera within 5 seconds of a visit's start (or of the last animal detection folded into it, for up to one cooldown) joins that visit instead of starting another. The higher-scoring label keeps the species (a tie goes to the earlier detection) and supplies the photo, the other label is kept as a `model` suggestion, and only one `visit_new` is published; later merges publish `visit_updated`. Visits a person has corrected or confirmed are never changed by a merge. A recorded clip that starts up to 5 seconds after the visit's start still counts as that visit's clip (Events Recorder begins recording a moment after the detection).

Corrections can be undone. Undo removes the matching learning example and recomputes the best photo for each affected species.

`GET events?after=<seq>&timeout=<seconds>` is a long poll: `timeout` is in seconds, clamped to 0-25 (missing or unparseable means 25), and the request returns as soon as an event is available. At most 100 requests can wait at once. Events are `visit_new`, `visit_updated`, `visit_deleted` and `camera`:

- `visit_deleted` (`{ "id": "<visit id>" }`) is sent for every visit row that is removed, so open dashboards can drop it: the split-visit repair, the duplicate and insect clean-ups, and the three-year retention prune. The row is already gone when the event is published.
- `camera` carries the same list as `GET cameras`. Cameras are re-checked every 30 seconds, but the event is published only when the list differs from the one last published: at start-up, and then when a camera goes offline or comes back, its health or dropped-connection count changes, its name or wildlife flag changes, or its latest visit changes (a new visit, a merge that changes its species, a removed visit). An idle plugin publishes nothing.

`GET media/camera/<cameraId>.jpg` is the camera's latest visit snapshot (404 if it has none); the Home Assistant "latest animal" images, and so the phone notifications, use it. `GET media/live/<cameraId>.jpg` is a current picture from the camera, for the Live tiles of cameras that have no NVR card; every camera in `GET cameras` carries its path as `picture`. It is taken with Scrypted's `takePicture` only when someone asks for it (a periodic request, at most 960 px wide, JPEG quality 75), kept in memory only, shared by requests that arrive together and reused for 15 seconds, so a camera is asked for a new picture at most once per 15 seconds; a camera that cannot answer is left alone for 15, then 30, then 60 seconds, and a capture that never answers is given up on after 23 seconds. The response is `Cache-Control: no-store` with an `ETag` and a `Last-Modified` (a matching `If-None-Match` gets a 304). If the camera cannot give a picture, its latest visit snapshot is sent instead, and 404 only if there is neither. Ids that are not cameras are never captured.

## Local checks

Run `npm run build`, `npm run test:store`, `npm run test:seen`, `npm run test:events`, `npm run test:live` and `npm run test:learning` from this directory.

Per-camera detector checks are stored in SQLite by America/New_York calendar day; visit totals are counted from persisted visits in that same day window. Daily check rows older than 30 days are pruned.
