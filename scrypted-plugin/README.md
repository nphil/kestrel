# Kestrel Scrypted plugin

Kestrel watches selected Scrypted cameras for wildlife visits, stores visits and review corrections in SQLite, links finalized Events Recorder clips, learns from corrections with CLIP, and ingests BirdNET-Go detections over MQTT. Home Assistant reads the authenticated JSON and media API; this plugin does not publish MQTT discovery or Home Assistant events.

The first run creates a private API key shown read-only in the plugin settings. Add the base URL `http://192.168.1.69:11080/endpoint/@nphil/kestrel/public/` and that key to the Home Assistant Kestrel integration. Every JSON and media request uses the `X-Kestrel-Key` header.

Choose the wildlife cameras in Settings. The initial set is Backyard (88), Back Door (103), Front Door (104) and Bird (106). BirdNET-Go subscribes to the configured MQTT topic (default `birdnet`) and its subtopics; the MQTT username and password are copied from Scrypted MQTT device 202 when those settings are empty.

Visits are created from Scrypted animal detections after a 30-second unidentified grace period, with a 10-minute per-camera/species cooldown. Snapshot and crop media are retained for 30 days unless a species best photo or correction uses them; visit rows are kept for three years. Nightly maintenance runs at 03:30 and keeps the plugin's media under a 300 MB budget.

Corrections can be undone. Undo removes the matching learning example and recomputes the best photo for each affected species.

## Local checks

Run `npm run build`, `npm run test:store`, and `npm run test:learning` from this directory.

Per-camera detector checks are stored in SQLite by America/New_York calendar day; visit totals are counted from persisted visits in that same day window. Daily check rows older than 30 days are pruned.
