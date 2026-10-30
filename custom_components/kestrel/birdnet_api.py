"""BirdNET-Go's own HTTP API (v2), as far as Kestrel changes anything in it.

Reading is open on the add-on's internal address. A write also wants a CSRF token sent twice -- as a header and as
a cookie -- which BirdNET-Go hands out from `/app/config`. Everything that writes (the species filter in
range_filter.py, keeping a recording in recording_keep.py) goes through here so the token is fetched one way.
"""

from __future__ import annotations

import re
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import KestrelApiError
from .const import BIRDNET_GO_INTERNAL_URL

API = f"{BIRDNET_GO_INTERNAL_URL}/api/v2"
TIMEOUT = aiohttp.ClientTimeout(total=15)
_CSRF_TOKEN = re.compile(r"[A-Za-z0-9+/=_.\-]{8,512}")


async def async_request(
    hass: HomeAssistant,
    method: str,
    path: str,
    *,
    body: Any | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    """One request to BirdNET-Go; its JSON answer (None for 204 No Content), or KestrelApiError saying what went wrong."""
    try:
        async with async_get_clientsession(hass).request(
            method, f"{API}{path}", json=body, headers=headers, timeout=TIMEOUT
        ) as response:
            if response.status == 204:
                return None
            if response.status != 200:
                raise KestrelApiError(
                    f"BirdNET-Go refused the request (HTTP {response.status})", status=response.status
                )
            return await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
        raise KestrelApiError("Could not reach BirdNET-Go") from err


async def async_write_headers(hass: HomeAssistant) -> dict[str, str]:
    """The headers a BirdNET-Go write needs: its CSRF token as a header and as the cookie."""
    config = await async_request(hass, "GET", "/app/config")
    token = config.get("csrfToken") if isinstance(config, dict) else None
    if not isinstance(token, str) or not _CSRF_TOKEN.fullmatch(token):
        raise KestrelApiError("BirdNET-Go did not give a usable security token")
    return {"X-CSRF-Token": token, "Cookie": f"csrf={token}"}
