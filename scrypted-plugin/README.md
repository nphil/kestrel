# Kestrel Scrypted plugin

Kestrel watches selected Scrypted cameras for wildlife visits, stores visits and review corrections in SQLite, links finalized Events Recorder clips, learns from corrections with CLIP, and ingests BirdNET-Go detections over MQTT. Home Assistant reads the authenticated JSON and media API; this plugin does not publish MQTT discovery or Home Assistant events.

The first run creates a private API key shown read-only in the plugin settings. Add the base URL `http://192.168.1.69:11080/endpoint/@nphil/kestrel/public/` and that key to the Home Assistant Kestrel integration. Every JSON and media request uses the `X-Kestrel-Key` header.

Choose the wildlife cameras in Settings. The initial set is Backyard (88), Back Door (103), Front Door (104) and Bird (106). BirdNET-Go subscribes to the configured MQTT topic (default `birdnet`) and its subtopics; the MQTT username and password are copied from Scrypted MQTT device 202 when those settings are empty.

Visits are created from Scrypted animal detections after a 30-second unidentified grace period, with a 10-minute per-camera/species cooldown. The cooldown counts earlier *seen* visits only: a bird that was merely heard (BirdNET-Go) never blocks a sighting of it, and the sighting is linked to the call when the call was heard within two minutes of it on the same camera. Snapshot and crop media are retained for 30 days unless a species best photo or correction uses them; visit rows are kept for three years. Nightly maintenance runs at 03:30 and keeps the plugin's media under a 300 MB budget.

Detections of one animal at one moment are one visit, whatever each detection is labelled: a detection on the same camera within 5 seconds of a visit's start (or of the last animal detection folded into it, for up to one cooldown) joins that visit instead of starting another. The higher-scoring label keeps the species (a tie goes to the earlier detection) and supplies the photo, the other label is kept as a `model` suggestion, and only one `visit_new` is published; later merges publish `visit_updated`. Visits a person has corrected or confirmed are never changed by a merge. A recorded clip that starts up to 5 seconds after the visit's start still counts as that visit's clip (Events Recorder begins recording a moment after the detection).

Corrections can be undone. Undo removes the matching learning example and recomputes the best photo for each affected species.

`GET events?after=<seq>&timeout=<seconds>` is a long poll: `timeout` is in seconds, clamped to 0-25 (missing or unparseable means 25), and the request returns as soon as an event is available. At most 100 requests can wait at once.

## Local checks

Run `npm run build`, `npm run test:store`, `npm run test:seen` and `npm run test:learning` from this directory.

Per-camera detector checks are stored in SQLite by America/New_York calendar day; visit totals are counted from persisted visits in that same day window. Daily check rows older than 30 days are pruned.
