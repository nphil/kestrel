"""Shared entity helpers for Kestrel."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

from .const import DOMAIN, KNOWN_CAMERA_SLUGS
from .coordinator import KestrelCoordinator


def camera_slug(camera: dict[str, Any]) -> str:
    """Return a stable, readable object slug for a wildlife camera."""
    camera_id = str(camera.get("id", "camera"))
    if camera_id in KNOWN_CAMERA_SLUGS:
        return KNOWN_CAMERA_SLUGS[camera_id]
    name = unicodedata.normalize("NFKD", str(camera.get("name", "camera")))
    ascii_name = name.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_name).strip("_") or "camera"
    return slug


def device_info(coordinator: KestrelCoordinator) -> DeviceInfo:
    """The single Kestrel service device shared by every entity."""
    return DeviceInfo(
        identifiers={(DOMAIN, coordinator.entry.unique_id or coordinator.entry.entry_id)},
        name="Kestrel",
        manufacturer="Kestrel",
        model="Wildlife camera service",
        entry_type=DeviceEntryType.SERVICE,
    )
