"""Shared constants for Kestrel."""

from __future__ import annotations

DOMAIN = "kestrel"
CONF_URL = "url"
CONF_API_KEY = "api_key"
CONF_POLL_TIMEOUT = "poll_timeout"

DEFAULT_URL = "http://192.168.1.69:11080/endpoint/@nphil/kestrel/public"
DEFAULT_POLL_TIMEOUT = 25
MIN_POLL_TIMEOUT = 1
MAX_POLL_TIMEOUT = 25

INTEGRATION_VERSION = "1.0.12"
STATIC_PATH = "/kestrel-static"
MEDIA_KINDS = frozenset({"snap", "crop", "clip", "audio", "species", "camera", "birdnet_audio", "species_ref", "species_ref_info"})
MEDIA_URL_TTL_HOURS = 12

# BirdNET-Go runs as its own Home Assistant add-on. HA core reaches its API on the
# internal add-on network directly (no auth needed there); the ingress path is HA's
# own stable reverse-proxied route to the add-on's web UI, for a human "open it" link.
BIRDNET_GO_INTERNAL_URL = "http://db21ed7f-birdnet-go:8080"
BIRDNET_GO_INGRESS_PATH = "/hassio/ingress/db21ed7f_birdnet-go"

# Per-item availability verdicts (see birdnet_availability.py) for media that
# BirdNET-Go may not actually have, even though it recognizes the name/id:
# referenceImage (species with no provider photo) and heard-visit audio (a
# low-confidence detection whose clip BirdNET-Go never saved). Image positive
# matches BirdNET-Go's own 30-day image cache; image negative is rechecked
# sooner in case a provider gets one later. Audio positive never expires (a
# saved clip is not deleted); audio negative is rechecked in minutes, since a
# clip can land a few seconds after its MQTT detection message.
BIRDNET_IMAGE_POSITIVE_CACHE_DAYS = 30
BIRDNET_IMAGE_NEGATIVE_CACHE_DAYS = 7
BIRDNET_AUDIO_NEGATIVE_CACHE_MINUTES = 10

# Sidebar panel (replaces the Lovelace dashboard to avoid its cold-load race).
PANEL_URL_PATH = "kestrel"
PANEL_COMPONENT_NAME = "kestrel-panel"
PANEL_SIDEBAR_TITLE = "Cameras"
PANEL_SIDEBAR_ICON = "mdi:cctv"

# Preserve stable, readable entity IDs for the original wildlife cameras. New
# wildlife cameras use a slug derived from the plugin's camera name.
KNOWN_CAMERA_SLUGS = {
    "88": "backyard_camera",
    "103": "back_door_camera",
    "104": "front_door_camera",
    "106": "bird_camera",
}
