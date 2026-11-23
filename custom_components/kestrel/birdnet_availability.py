"""BirdNET-Go per-item media availability cache.

BirdNET-Go's own species list and MQTT detections only say a name or
detection id is *known* to it -- not that the actual bytes (a reference
photo, a saved audio clip) exist. A species can have no photo from any
provider; a low-confidence detection's clip can simply never get written
(checked live: 28 of 664 heard visits). Signing a media URL from knowledge
alone means the browser 404s on a normal Wildlife page load.

This checks real availability once per recording and caches the verdict --
positive and negative, with independently tunable TTLs. (Species reference
photos are decided in reference_photos.py, which asks image_status() below
and falls back to other sources.)

Recordings are the opposite: a link is signed ONLY for a recording that is
known to exist, because a visit with a dead recording link shows a player
that fails. Three things decide it, in order:
  1. recording_of(): a detection BirdNET-Go announced with no clip name
     never had a clip saved (checked live: ids 13761, 13807, 13974 ... have
     clipName null and answer 404 for ever), so it gets no link and no check.
     Otherwise the recording is named by its detection id, or -- for a
     detection announced with id 0 (BirdNET-Go's de-duplication gave its
     database row to the same species heard on the other camera moments
     earlier, but the clip WAS saved) -- by its clip name;
  2. async_confirm_audio(): for the rest, the websocket layer waits a moment
     (_AUDIO_CHECK_WAIT_S) for the real check before signing, so
     audio_available_now() is usually a cache hit by then. A recording whose
     existence is still unknown (the check is slow, BirdNET-Go unreachable)
     gets no link this time. Its check is not dropped when the wait ends: it
     carries on in the background and fills the cache, so the next request
     finds the answer (a BirdNET-Go that could not be reached is asked again).
(The detection ids that cannot exist, see detection_id_of, never get a link
by id.)

A recording is identified by one string, its media id: the decimal detection
id, or the clip name ("2026/10/<file>.opus", which always contains "/", so the
two can never be confused). The verdict cache is keyed by it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable, Coroutine, Hashable
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .const import (
    BIRDNET_AUDIO_NEGATIVE_CACHE_MINUTES,
    BIRDNET_GO_INTERNAL_URL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)
_AUDIO_NEGATIVE_TTL = timedelta(minutes=BIRDNET_AUDIO_NEGATIVE_CACHE_MINUTES)
_AUDIO_CACHE = "birdnet_audio_availability"
_AUDIO_KIND = "birdnet_audio_check"  # names the checks running and the slots they share (see start_or_join)
# When (event-loop time) the check running for a recording began, so that no request waits for it for longer than _AUDIO_CHECK_WAIT_S in all.
_AUDIO_STARTED = "birdnet_audio_check_started"
# How long a request waits for the checks of the recordings it shows. A page of 50 recordings answers in well under a second (the cached ones
# not at all); this is only for a BirdNET-Go that is slow, and the checks it did not finish go on without the request (see async_confirm_audio).
_AUDIO_CHECK_WAIT_S = 1.5
_AUDIO_CHECK_PARALLEL = 8
# BirdNET-Go's clip names are "<year>/<month>/<species>_<score>p_<UTC time>.<extension>" (checked live: all 1025 heard
# visits). The name is put into a URL and sent to BirdNET-Go, so only that shape is accepted: ASCII letters, digits,
# "_", "-", "+" and "." in the file name, never starting with "." and never containing ".." (no way up a directory).
_CLIP_NAME = re.compile(
    r"[0-9]{4}/(?:0[1-9]|1[0-2])/[A-Za-z0-9][A-Za-z0-9_+.-]{0,200}\.(?:opus|ogg|wav|mp3|flac|m4a|aac)"
)


def detection_id_of(value: object) -> int | None:
    """BirdNET-Go's number for a detection, or None when `value` is not one.

    Its numbers start at 1. Some detections reach Kestrel announced with id 0 (and a real clip name), and 0 names
    nothing: BirdNET-Go answers 404 for its recording, always. So a 0 gets no link, no availability check and no
    preview job -- a link signed for it would be requested by the panel (and logged as a failed request) for nothing.
    """
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def clip_name_of(value: object) -> str | None:
    """BirdNET-Go's clip name when `value` is one (see _CLIP_NAME), else None. Nothing else may reach a URL."""
    if isinstance(value, str) and ".." not in value and _CLIP_NAME.fullmatch(value):
        return value
    return None


def recording_of(part: object) -> tuple[str, str] | None:
    """(media kind, media id) of the recording a plugin `audio` / `heard` part can link to, or None.

    By detection id when it has a real one (`birdnet_audio`, and the only kind a bird-call preview can be made for);
    otherwise by clip name (`birdnet_clip`): BirdNET-Go announces some detections with id 0 -- and then, with a real clip
    name, it still saved the clip. Whether it exists is for the availability check to say.
    """
    if not isinstance(part, dict):
        return None
    identifier = recording_id_of(part)
    if identifier is not None:
        return "birdnet_audio", str(identifier)
    if (clip := clip_name_of(part.get("birdnetClip"))) is not None:
        return "birdnet_clip", clip
    return None


def recording_id_of(part: object) -> int | None:
    """The detection id whose saved recording a plugin `audio` / `heard` part can link to, or None.

    The plugin passes BirdNET-Go's clip name along (`birdnetClip`). BirdNET-Go announces a detection WITHOUT one when
    it saved no clip for it -- and then never does, so the recording URL answers 404 for ever. A part that carries the
    key with no name therefore has no recording; a part that does not carry the key at all (an older plugin) is left
    to the availability check. (Only a real id can be linked by id; see recording_of for the rest.)
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
            if (recording := recording_of(value.get(key))) is not None:
                found[recording[1]] = None
        for item in value.values():
            if isinstance(item, (list, dict)):
                _recording_ids(item, found)


def start_or_join(
    hass: HomeAssistant,
    kind: str,
    key: Hashable,
    job: Callable[[], Coroutine[Any, Any, None]],
    *,
    parallel: int,
) -> asyncio.Future[None]:
    """The BirdNET-Go lookup of `key` (one of the lookups of `kind`) that is already running, or a new one started now.

    A lookup is a background task, so a caller that stops waiting for it (its answer has gone out, the browser left) cannot cut it short: it
    runs to its end and leaves what it learned in a cache for the next request. Asking for a lookup that is running joins it instead of asking
    BirdNET-Go again, and at most `parallel` lookups of one kind run at the same moment.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    running: dict[Hashable, asyncio.Future[None]] = domain_data.setdefault(f"{kind}_running", {})
    if (lookup := running.get(key)) is not None:
        return lookup
    if (slots := domain_data.get(f"{kind}_slots")) is None:
        slots = domain_data[f"{kind}_slots"] = asyncio.Semaphore(parallel)

    async def run() -> None:
        async with slots:
            await job()

    lookup = hass.async_create_background_task(run(), f"kestrel {kind} {key}")
    running[key] = lookup
    lookup.add_done_callback(lambda _: running.pop(key, None))
    return lookup


def _start_audio_check(hass: HomeAssistant, media_id: str) -> asyncio.Future[None]:
    return start_or_join(hass, _AUDIO_KIND, media_id, lambda: _async_run_check(hass, media_id), parallel=_AUDIO_CHECK_PARALLEL)


async def async_confirm_audio(hass: HomeAssistant, payload: object) -> None:
    """Look up, once and in parallel, every recording in `payload` whose existence is not cached yet.

    No request waits for a recording's check for longer than _AUDIO_CHECK_WAIT_S after that check BEGAN: the request that starts it waits that long at
    most, and a request that comes while it is still running waits for what is left of it (nothing, once it has run that long), so one slow recording
    does not hold up every request. A recording that has not answered stays unknown (and so gets no link this time), but its check is NOT dropped: it
    carries on in the background and writes its verdict into the cache, so the next request finds it there.
    """
    ids: dict[str, None] = {}  # media ids
    _recording_ids(payload, ids)
    cache: dict[str, tuple[bool, datetime]] = hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_CACHE, {})
    now = dt_util.utcnow()
    unknown = [
        media_id
        for media_id in ids
        if (cached := cache.get(media_id)) is None
        or (not cached[0] and now - cached[1] >= _AUDIO_NEGATIVE_TTL)
    ]
    if not unknown:
        return
    started: dict[str, float] = hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_STARTED, {})
    now_loop = asyncio.get_running_loop().time()
    checks = []
    for media_id in unknown:
        started.setdefault(media_id, now_loop)  # a check that is already running keeps the moment it began
        checks.append(_start_audio_check(hass, media_id))
    wait = max(started[media_id] + _AUDIO_CHECK_WAIT_S - now_loop for media_id in unknown)
    if wait <= 0:
        return
    _, slow = await asyncio.wait(checks, timeout=wait)
    if slow:
        _LOGGER.debug("Kestrel BirdNET-Go: %d recording checks still running after %ss, left to finish in the background", len(slow), _AUDIO_CHECK_WAIT_S)


def audio_available_now(hass: HomeAssistant, media_id: str) -> bool | None:
    """Cached heard-visit audio-clip verdict (`media_id`: see the module docstring); starts a check if unknown.

    Positive never expires (a saved clip is not deleted); negative is
    short-lived, since a clip can land a few seconds after its MQTT message.
    Returns True only for a recording known to exist.
    """
    cache: dict[str, tuple[bool, datetime]] = hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_CACHE, {})
    cached = cache.get(media_id)
    if cached is not None:
        available, checked_at = cached
        if available or dt_util.utcnow() - checked_at < _AUDIO_NEGATIVE_TTL:
            return available
        cache.pop(media_id, None)
    _start_audio_check(hass, media_id)
    return None


async def _async_run_check(hass: HomeAssistant, media_id: str) -> None:
    """Find out whether a recording exists and remember the verdict. No verdict (BirdNET-Go did not answer) leaves the cache as it is."""
    try:
        available = await _check_audio(hass, media_id)
    except Exception:  # a check that breaks is "no verdict yet", like a network failure; it must not take anything else down
        _LOGGER.warning("Kestrel BirdNET-Go check of recording %s failed", media_id, exc_info=True)
        return
    finally:
        hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_STARTED, {}).pop(media_id, None)
    if available is not None:
        hass.data.setdefault(DOMAIN, {}).setdefault(_AUDIO_CACHE, {})[media_id] = (available, dt_util.utcnow())


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


async def image_status(hass: HomeAssistant, scientific_name: str) -> int | None:
    """BirdNET-Go's HTTP status for a species' reference image, asked about without fetching it: 200 = it has one,
    404 = its own negative cache says no provider has one, 202/503 = still resolving, None = it could not be asked.
    Deciding what that means (and what to do instead) is reference_photos.py's business."""
    return await _probe(
        hass,
        f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/species-image/info",
        params={"name": scientific_name},
    )


def recording_url(media_id: str) -> str | None:
    """BirdNET-Go's URL for a recording's bytes, or None when `media_id` is neither a detection id nor a clip name."""
    if (clip := clip_name_of(media_id)) is not None:
        return f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/audio/{quote(clip, safe='/')}"
    if media_id.isascii() and media_id.isdigit() and detection_id_of(int(media_id)) is not None:
        return f"{BIRDNET_GO_INTERNAL_URL}/api/v2/audio/{int(media_id)}"
    return None


async def _check_audio(hass: HomeAssistant, media_id: str) -> bool | None:
    """200/206 = the clip exists (asks for one byte, to avoid pulling the file
    twice). 404 = genuinely absent (never saved, or purged). Anything else
    (a network failure) is not a verdict yet.
    """
    url = recording_url(media_id)
    if url is None:
        return False  # not a recording BirdNET-Go can have
    status = await _probe(hass, url, headers={"Range": "bytes=0-0"})
    if status in (200, 206):
        return True
    if status == 404:
        return False
    return None
