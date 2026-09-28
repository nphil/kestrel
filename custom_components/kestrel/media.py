"""Authenticated streaming media proxy for Kestrel plugin files and BirdNET-Go audio."""

from __future__ import annotations

import logging

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import KestrelApiError
from .const import BIRDNET_GO_INTERNAL_URL, DOMAIN, MEDIA_KINDS
from .coordinator import KestrelCoordinator

_LOGGER = logging.getLogger(__name__)
_FORWARD_HEADERS = (
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
)


class KestrelMediaView(HomeAssistantView):
    """Stream media from the authenticated plugin through Home Assistant."""

    url = "/api/kestrel/media/{kind}/{media_id}"
    name = "api:kestrel:media"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, kind: str, media_id: str) -> web.StreamResponse:
        if kind not in MEDIA_KINDS or not media_id or "/" in media_id:
            return web.Response(status=404, text="Media not found")

        headers: dict[str, str] = {}
        if range_header := request.headers.get("Range"):
            headers["Range"] = range_header
        if if_range := request.headers.get("If-Range"):
            headers["If-Range"] = if_range

        if kind == "birdnet_audio":
            # BirdNET-Go's own add-on API, independent of the Kestrel plugin's connectivity.
            if not media_id.isdigit():
                return web.Response(status=404, text="Media not found")
            return await self._stream(
                request,
                async_get_clientsession(self._hass),
                f"{BIRDNET_GO_INTERNAL_URL}/api/v2/audio/{media_id}",
                headers,
                aiohttp.ClientTimeout(total=None, connect=10, sock_read=30),
            )

        coordinator: KestrelCoordinator | None = self._hass.data.get(DOMAIN, {}).get("coordinator")
        if coordinator is None:
            return web.Response(status=503, text="Kestrel is not connected")
        return await self._stream(
            request,
            coordinator.client.session,
            coordinator.client.media_url(kind, media_id),
            {**coordinator.client.headers, **headers},
            aiohttp.ClientTimeout(total=None, connect=15, sock_read=60),
        )

    @staticmethod
    async def _stream(
        request: web.Request,
        session: aiohttp.ClientSession,
        url: str,
        headers: dict[str, str],
        timeout: aiohttp.ClientTimeout,
    ) -> web.StreamResponse:
        try:
            async with session.get(
                url, headers=headers, timeout=timeout, allow_redirects=False
            ) as upstream:
                if upstream.status not in (200, 206, 416):
                    if upstream.status == 404:
                        return web.Response(status=404, text="Media not found")
                    _LOGGER.warning(
                        "Kestrel media request to %s returned HTTP %s", url, upstream.status
                    )
                    return web.Response(status=502, text="Kestrel media request failed")

                downstream_headers = {
                    name: upstream.headers[name]
                    for name in _FORWARD_HEADERS
                    if name in upstream.headers
                }
                downstream_headers["Cache-Control"] = "private, max-age=300"
                response = web.StreamResponse(status=upstream.status, headers=downstream_headers)
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response
        except (KestrelApiError, aiohttp.ClientError, TimeoutError, OSError) as err:
            _LOGGER.debug("Kestrel media proxy failed for %s: %s", url, err)
            return web.Response(status=502, text="Kestrel media request failed")


def async_register_media_view(hass: HomeAssistant) -> None:
    """Register the proxy exactly once per HA instance."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("media_view_registered"):
        return
    domain_data["media_view_registered"] = True
    hass.http.register_view(KestrelMediaView(hass))
