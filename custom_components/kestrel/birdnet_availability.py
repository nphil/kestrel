"""BirdNET-Go per-item media availability cache.

BirdNET-Go's own species list and MQTT detections only say a name or
detection id is *known* to it -- not that the actual bytes (a reference
photo, a saved audio clip) exist. A species can have no photo from any
provider; a low-confidence detection's clip can simply never get written
(checked live: 28 of 664 heard visits). Signing a media URL from knowledge
alone means the browser 404s on a normal Wildlife page load.

This checks real availability once per item and caches the verdict --
positive and negative, with independently tunable TTLs per kind.

Images stay optimistic: image_available_now() never blocks, and an image
with no cached verdict yet (cold start, an expired verdict, BirdNET-Go
unreachable) is treated as available while a check runs in the background;
only a confirmed 404 hides the link.

Recordings are the opposite: a link is signed ONLY for a recording that is
known to exist, because a visit with a dead recording link shows a player
that fails. Two things decide it, in order:
  1. recording_id_of(): a detection BirdNET-Go announced with no clip name
     never had a clip saved (checked live: ids 13761, 13807, 13974 ... have
     clipName null and answer 404 for ever), so it gets no link and no check;
  2. async_confirm_audio(): for the rest, the websocket layer awaits the
     real check (bounded) before signing, so audio_available_now() is a
     cache hit by then. A recording whose existence is still unknown (the
     check timed out, BirdNET-Go unreachable) gets no link this time and is
     checked again on the next request.
(The detection ids that cannot exist, see detection_id_of, never get a link.)
"""

from __future__ import annotations

import asyncio
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
_AUDIO_CACHE = "birdnet_audio_availability"
_AUDIO_PENDING = "birdnet_audio_pending"
_AUDIO_CHECK_WAIT_S = 6.0  # a page of 50 recordings answers in well under a second; this is for a BirdNET-Go that is slow
_AUDIO_CHECK_PARALLEL = 8


def detection_id_of(value: object) -> int | None:
    """BirdNET-Go's number for a detection, or None when `value` is not one.

    Its numbers start at 1. Some detections reach Kestrel announced with id 0 (and a real clip name), and 0 names
    nothing: BirdNET-Go answers 404 for its recording, always. So a 0 gets no link, no availability check and no
    preview job -- a link signed for it would be requested by the panel (and logged as a failed request) for nothing.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def recording_id_of(part: object) -> int | None:
    """The detection whose saved recording a plugin `audio` / `heard` part can link to, or None.

    The plugin passes BirdNET-Go's clip name along (`birdnetClip`). BirdNET-Go announces a detection WITHOUT one when
    it saved no clip for it -- and then never does, so the recording URL answers 404 for ever. A part that carries the
    key with no name therefore has no recording; a part that does not carry the key at all (an older plugin) is left
    to the availability check.
    """
    if not isinstance(part, dict):
        return None
    if "birdnetClip" in part:
        clip = part["birdnetClip"]
        if not isinstance(clip, str) or not clip.strip():
            return None
    return detection_id_of(part.get("birdnetDetectionId"))


def _recording_ids(value: object, found: dict[str, None]) -> None:
    if isinstance(value, list):
        for item in value:
            _recording_ids(item, found)
    elif isinstance(value, dict):
        for key in ("audio", "heard"):
            if (identifier := recording_id_of(value.get(key))) is not None:
                found[str(identifier)] = None
        for item in value.values():
            if isinstance(item, (list, dict)):
                _recording_ids(item, found)


async def async_confirm_audio(hass: HomeAssistant, payload: object) -> None:
    """Look up, once and in parallel, every recording in `payload` whose existence is not cached yet.

    Waits at most _AUDIO_CHECK_WAIT_S. What did not answer in time stays unknown (and so gets no link) while its
    check is dropped; the next request asks again.
    """
    ids: dict[str, None] = {}
    _recording_ids(payload, ids)
    cache: dict[str, tuple[bool, datetime]] = hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_CACHE, {})
    now = dt_util.utcnow()
    unknown = [
        detection_id
        for detection_id in ids
        if (cached := cache.get(detection_id)) is None
        or (not cached[0] and now - cached[1] >= _AUDIO_NEGATIVE_TTL)
    ]
    if not unknown:
        return
    limit = asyncio.Semaphore(_AUDIO_CHECK_PARALLEL)

    async def check(detection_id: str) -> None:
        async with limit:
            await _async_run_check(
                hass, _AUDIO_CACHE, _AUDIO_PENDING, detection_id, lambda: _check_audio(hass, detection_id)
            )

    try:
        await asyncio.wait_for(
            asyncio.gather(*(check(detection_id) for detection_id in unknown), return_exceptions=True),
            _AUDIO_CHECK_WAIT_S,
        )
    except TimeoutError:
        _LOGGER.debug("Kestrel BirdNET-Go recording checks still running after %ss", _AUDIO_CHECK_WAIT_S)


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
    Returns True only for a recording known to exist.
    """
    return _available_now(
        hass,
        cache_key=_AUDIO_CACHE,
        pending_key=_AUDIO_PENDING,
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
