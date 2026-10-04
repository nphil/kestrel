"""BirdNET-Go's local species filter ("range filter") strictness, read and changed from Kestrel.

BirdNET-Go only reports a species when its location model says that species is likely near the
configured spot at this time of year. The threshold decides how likely "likely" has to be: a low one
lets many species through, a high one only the most expected ones.

Reading is BirdNET-Go's public count endpoint. Changing goes through its settings API, which wants a
CSRF token sent twice (header and cookie); the rest of the range-filter settings are written back
exactly as they were. BirdNET-Go then rebuilds its species list in the background, so after a change
we wait briefly for the rebuild to land so the count we report is the new one.
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import KestrelApiError
from .const import BIRDNET_GO_INTERNAL_URL

MIN_THRESHOLD = 0.005
MAX_THRESHOLD = 0.5

_API = f"{BIRDNET_GO_INTERNAL_URL}/api/v2"
_TIMEOUT = aiohttp.ClientTimeout(total=15)
_REBUILD_POLL_S = 0.5
_REBUILD_POLLS = 20  # up to ~10 s for BirdNET-Go to finish rebuilding its species list
_CSRF_TOKEN = re.compile(r"[A-Za-z0-9+/=_.\-]{8,512}")


def checked_threshold(value: object) -> float:
    """The threshold as a float, or ValueError saying what is wrong with it."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("The species filter must be a number")
    if not MIN_THRESHOLD <= value <= MAX_THRESHOLD:
        raise ValueError(
            f"The species filter must be between {MIN_THRESHOLD:.1%} and {MAX_THRESHOLD:.0%}"
        )
    return round(float(value), 4)


async def _request(
    hass: HomeAssistant,
    method: str,
    path: str,
    *,
    body: Any | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    try:
        async with async_get_clientsession(hass).request(
            method, f"{_API}{path}", json=body, headers=headers, timeout=_TIMEOUT
        ) as response:
            if response.status != 200:
                raise KestrelApiError(
                    f"BirdNET-Go refused the request (HTTP {response.status})", status=response.status
                )
            return await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
        raise KestrelApiError("Could not reach BirdNET-Go") from err


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


async def async_read(hass: HomeAssistant) -> dict[str, Any]:
    """Current strictness, how many species it allows, and where BirdNET-Go thinks it is."""
    payload = await _request(hass, "GET", "/range/species/count")
    location = payload.get("location") if isinstance(payload, dict) else None
    threshold = _number(payload.get("threshold")) if isinstance(payload, dict) else None
    count = payload.get("count") if isinstance(payload, dict) else None
    if (
        threshold is None
        or not isinstance(count, int)
        or isinstance(count, bool)
        or not isinstance(location, dict)
    ):
        raise KestrelApiError("BirdNET-Go sent an answer Kestrel does not understand")
    updated = payload.get("lastUpdated")
    return {
        "threshold": round(threshold, 4),
        "speciesCount": count,
        "latitude": _number(location.get("latitude")),
        "longitude": _number(location.get("longitude")),
        "updatedAt": updated if isinstance(updated, str) else None,
        "rebuilding": False,
    }


async def async_set_threshold(hass: HomeAssistant, threshold: object) -> dict[str, Any]:
    """Change the strictness, keeping every other range-filter setting as it is, and return the new state."""
    value = checked_threshold(threshold)
    before = await async_read(hass)
    if abs(before["threshold"] - value) < 1e-9:
        return before  # BirdNET-Go only rebuilds on a real change

    config = await _request(hass, "GET", "/app/config")
    token = config.get("csrfToken") if isinstance(config, dict) else None
    if not isinstance(token, str) or not _CSRF_TOKEN.fullmatch(token):
        raise KestrelApiError("BirdNET-Go did not give a usable security token")
    section = await _request(hass, "GET", "/settings/birdnet")
    current = section.get("rangeFilter") if isinstance(section, dict) else None
    if not isinstance(current, dict):
        raise KestrelApiError("BirdNET-Go sent an answer Kestrel does not understand")
    # The species list is BirdNET-Go's own output; it refuses to take it back.
    keep = {key: item for key, item in current.items() if key != "species"}
    await _request(
        hass,
        "PATCH",
        "/settings/birdnet",
        body={"rangeFilter": {**keep, "threshold": value}},
        headers={"X-CSRF-Token": token, "Cookie": f"csrf={token}"},
    )

    for _ in range(_REBUILD_POLLS):
        await asyncio.sleep(_REBUILD_POLL_S)
        after = await async_read(hass)
        if after["updatedAt"] != before["updatedAt"]:
            return after
    # Not finished yet: report the value we set, so the panel can look again shortly.
    return {**before, "threshold": value, "rebuilding": True}
