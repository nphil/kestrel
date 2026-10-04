"""Redacted diagnostics for Kestrel."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.redact import async_redact_data

from .const import CONF_API_KEY, CONF_AUDIO_KEY, CONF_XENO_CANTO_KEY, DOMAIN
from .coordinator import KestrelCoordinator

TO_REDACT = {CONF_API_KEY, CONF_AUDIO_KEY, CONF_XENO_CANTO_KEY, "X-Kestrel-Key", "X-Kestrel-Audio-Key", "authorization", "token"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry[KestrelCoordinator]
) -> dict[str, Any]:
    """Return connection state and a redacted entry snapshot."""
    coordinator = entry.runtime_data
    audio = hass.data.get(DOMAIN, {}).get("audio")
    reference = hass.data.get(DOMAIN, {}).get("reference_sounds")
    photos = hass.data.get(DOMAIN, {}).get("reference_photos")
    return {
        "audio_service": await audio.async_diagnostics() if audio is not None else {"configured": False},
        "reference_sounds": reference.diagnostics() if reference is not None else {"configured": False},
        "reference_photos": photos.diagnostics() if photos is not None else {"configured": False},
        "entry": async_redact_data(entry.as_dict(), TO_REDACT),
        "connection": {
            "connected": coordinator.connected,
            "camera_count": len((coordinator.data or {}).get("cameras", [])),
            "event_sequence": coordinator._seq,
            "event_generation": coordinator._generation,
            "announced_visits": len(coordinator.announced),
        },
    }
