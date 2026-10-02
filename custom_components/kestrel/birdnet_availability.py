"""BirdNET-Go per-item media availability cache.

BirdNET-Go's own species list and MQTT detections only say a name or
detection id is *known* to it -- not that the actual bytes (a reference
photo, a saved audio clip) exist. A species can have no photo from any
provider; a low-confidence detection's clip can simply never get written
(checked live: 5 of 141 recent heard visits). Signing a media URL from
knowledge alone means the browser 404s on a normal Wildlife page load.

This checks real availability once per item, in the background, and caches
the verdict -- positive and negative, with independently tunable TTLs per
kind -- so a later request is a synchronous, no-network cache hit. The two
*_available_now() functions are the only entry points websocket_api.py
needs: neither ever blocks, and an item with no cached verdict yet (cold
start, an expired verdict, BirdNET-Go unreachable) is treated as available
-- websocket_api.py signs its link, so a transient failure cannot hide a
real photo or clip -- while a check is scheduled; only a confirmed 404
hides the link. (The detection ids that cannot exist, see detection_id_of,
are not "unknown": they never get a link.)
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from urllib.parse import quote

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .const import (
    BIRDNET_AUDIO_NEGATIVE_CACHE_MINUTES,
    BIRDNET_GO_INTERNAL_URL,
    BIRDNET_IMAGE_NEGATIVE_CACHE_DAYS,
    BIRDNET_IMAGE_POSITIVE_CACHE_DAYS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)
_IMAGE_POSITIVE_TTL = timedelta(days=BIRDNET_IMAGE_POSITIVE_CACHE_DAYS)
_IMAGE_NEGATIVE_TTL = timedelta(days=BIRDNET_IMAGE_NEGATIVE_CACHE_DAYS)
_AUDIO_NEGATIVE_TTL = timedelta(minutes=BIRDNET_AUDIO_NEGATIVE_CACHE_MINUTES)


def detection_id_of(value: object) -> int | None:
    """BirdNET-Go's number for a detection, or None when `value` is not one.

    Its numbers start at 1. Some detections reach Kestrel announced with id 0 (and a real clip name), and 0 names
    nothing: BirdNET-Go answers 404 for its recording, always. So a 0 gets no link, no availability check and no
    preview job -- a link signed for it would be requested by the panel (and logged as a failed request) for nothing.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def image_available_now(hass: HomeAssistant, scientific_name: str) -> bool | None:
    """Cached species reference-image verdict; schedules a check if unknown."""
    return _available_now(
        hass,
        cache_key="birdnet_image_availability",
        pending_key="birdnet_image_pending",
        item_key=scientific_name,
        positive_ttl=_IMAGE_POSITIVE_TTL,
        negative_ttl=_IMAGE_NEGATIVE_TTL,
        checker=lambda: _check_image(hass, scientific_name),
        task_name=f"kestrel birdnet image check {scientific_name}",
    )


def audio_available_now(hass: HomeAssistant, detection_id: str) -> bool | None:
    """Cached heard-visit audio-clip verdict; schedules a check if unknown.

    Positive never expires (a saved clip is not deleted); negative is
    short-lived, since a clip can land a few seconds after its MQTT message.
    """
    return _available_now(
        hass,
        cache_key="birdnet_audio_availability",
        pending_key="birdnet_audio_pending",
        item_key=detection_id,
        positive_ttl=None,
        negative_ttl=_AUDIO_NEGATIVE_TTL,
        checker=lambda: _check_audio(hass, detection_id),
        task_name=f"kestrel birdnet audio check {detection_id}",
    )


def _available_now(
    hass: HomeAssistant,
    *,
    cache_key: str,
    pending_key: str,
    item_key: str,
    positive_ttl: timedelta | None,
    negative_ttl: timedelta,
    checker: Callable[[], Awaitable[bool | None]],
    task_name: str,
) -> bool | None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    cache: dict[str, tuple[bool, datetime]] = domain_data.setdefault(cache_key, {})
    cached = cache.get(item_key)
    if cached is not None:
        available, checked_at = cached
        ttl = positive_ttl if available else negative_ttl
        if ttl is None or dt_util.utcnow() - checked_at < ttl:
            return available
        cache.pop(item_key, None)

    pending: set[str] = domain_data.setdefault(pending_key, set())
    if item_key not in pending:
        pending.add(item_key)
        hass.async_create_task(
            _async_run_check(hass, cache_key, pending_key, item_key, checker), task_name
        )
    return None


async def _async_run_check(
    hass: HomeAssistant,
    cache_key: str,
    pending_key: str,
    item_key: str,
    checker: Callable[[], Awaitable[bool | None]],
) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    pending: set[str] = domain_data.setdefault(pending_key, set())
    try:
        available = await checker()
        if available is None:
            return  # not a verdict (still resolving, or a transient failure): retry later
        cache: dict[str, tuple[bool, datetime]] = domain_data.setdefault(cache_key, {})
        cache[item_key] = (available, dt_util.utcnow())
    finally:
        pending.discard(item_key)


async def _probe(
    hass: HomeAssistant, url: str, *, params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
) -> int | None:
    """GET url and return its status code, or None on a network-level failure."""
    try:
        async with async_get_clientsession(hass).get(
            url, params=params, headers=headers, timeout=aiohttp.ClientTimeout(total=15)
        ) as response:
            return response.status
    except (aiohttp.ClientError, TimeoutError, OSError) as err:
        _LOGGER.debug("Kestrel BirdNET-Go availability probe failed for %s: %s", url, err)
        return None


async def _check_image(hass: HomeAssistant, scientific_name: str) -> bool | None:
    """200 = image resolved (also confirms attribution for referenceImageInfoUrl).
    404 = BirdNET-Go's own negative cache: genuinely no image found. Anything
    else (503 = still resolving; a network failure) is not a verdict yet.
    """
    status = await _probe(
        hass,
        f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/species-image/info",
        params={"name": scientific_name},
    )
    if status == 200:
        return True
    if status == 404:
        return False
    return None


async def _check_audio(hass: HomeAssistant, detection_id: str) -> bool | None:
    """200/206 = the clip exists (asks for one byte, to avoid pulling the file
    twice). 404 = genuinely absent (never saved, or purged). Anything else
    (a network failure) is not a verdict yet.
    """
    status = await _probe(
        hass,
        f"{BIRDNET_GO_INTERNAL_URL}/api/v2/audio/{quote(detection_id, safe='')}",
        headers={"Range": "bytes=0-0"},
    )
    if status in (200, 206):
        return True
    if status == 404:
        return False
    return None
