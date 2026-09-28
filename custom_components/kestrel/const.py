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

INTEGRATION_VERSION = "1.0.2"
STATIC_PATH = "/kestrel-static"
MEDIA_KINDS = frozenset({"snap", "crop", "clip", "audio", "species", "camera"})
MEDIA_URL_TTL_HOURS = 12

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
