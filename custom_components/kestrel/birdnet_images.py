"""BirdNET-Go species reference-image availability cache.

BirdNET-Go's species list (birdnet_species_map, fetched once by the
coordinator) only says a common name resolves to a known scientific name --
not that an image was actually found for it from wikimedia/avicommons. Some
species BirdNET-Go otherwise knows genuinely have none (checked live:
Coyote, Spring Peeper). Signing a referenceImage URL from name-knowledge
alone means the browser's <img> 404s on a normal Wildlife page load.

This checks real availability once per species, in the background, and
caches the verdict -- positive and negative -- so a later request is a
synchronous, no-network cache hit. available_now() is the only entry point
websocket_api.py needs: it never blocks, and a species with no cached
verdict yet is simply left out of the response (no 404 risk) while a check
is scheduled for next time.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .const import (
    BIRDNET_GO_INTERNAL_URL,
    BIRDNET_IMAGE_NEGATIVE_CACHE_DAYS,
    BIRDNET_IMAGE_POSITIVE_CACHE_DAYS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)
_POSITIVE_TTL = timedelta(days=BIRDNET_IMAGE_POSITIVE_CACHE_DAYS)
_NEGATIVE_TTL = timedelta(days=BIRDNET_IMAGE_NEGATIVE_CACHE_DAYS)


def available_now(hass: HomeAssistant, scientific_name: str) -> bool | None:
    """Return a cached verdict for scientific_name, scheduling a check if unknown.

    True/False are fresh, safe to act on immediately. None means no verdict
    is cached yet (or it expired): a background check is now in flight (or
    already was), and the caller should treat this species as unavailable
    for this response -- it will have a verdict, one way or another, the
    next time this is called.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    cache: dict[str, tuple[bool, datetime]] = domain_data.setdefault(
        "birdnet_image_availability", {}
    )
    cached = cache.get(scientific_name)
    if cached is not None:
        available, checked_at = cached
        ttl = _POSITIVE_TTL if available else _NEGATIVE_TTL
        if dt_util.utcnow() - checked_at < ttl:
            return available
        cache.pop(scientific_name, None)

    pending: set[str] = domain_data.setdefault("birdnet_image_pending", set())
    if scientific_name not in pending:
        pending.add(scientific_name)
        hass.async_create_task(
            _async_check(hass, scientific_name),
            f"kestrel birdnet image check {scientific_name}",
        )
    return None


async def _async_check(hass: HomeAssistant, scientific_name: str) -> None:
    """Ask BirdNET-Go's own cached-only attribution endpoint for a verdict.

    200 = an image was already resolved (and this call is free extra
    confirmation the attribution info exists too, for referenceImageInfoUrl).
    404 = BirdNET-Go's own negative cache: genuinely no image found.
    Anything else (503 = BirdNET-Go hasn't resolved it yet and just scheduled
    its own background fetch; a network failure) is not a verdict -- leave
    the cache untouched so the next request retries.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    pending: set[str] = domain_data.setdefault("birdnet_image_pending", set())
    try:
        session = async_get_clientsession(hass)
        url = f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/species-image/info"
        try:
            async with session.get(
                url,
                params={"name": scientific_name},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as response:
                status = response.status
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            _LOGGER.debug(
                "Kestrel BirdNET-Go image availability check failed for %s: %s",
                scientific_name,
                err,
            )
            return
        if status == 200:
            available = True
        elif status == 404:
            available = False
        else:
            return
        cache: dict[str, tuple[bool, datetime]] = domain_data.setdefault(
            "birdnet_image_availability", {}
        )
        cache[scientific_name] = (available, dt_util.utcnow())
    finally:
        pending.discard(scientific_name)
