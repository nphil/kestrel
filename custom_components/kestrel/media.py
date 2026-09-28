"""Authenticated streaming media proxy for Kestrel plugin files."""

from __future__ import annotations

import logging

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .client import KestrelApiError
from .const import DOMAIN, MEDIA_KINDS
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
        coordinator: KestrelCoordinator | None = self._hass.data.get(DOMAIN, {}).get("coordinator")
        if coordinator is None:
            return web.Response(status=503, text="Kestrel is not connected")

        headers = {}
        if range_header := request.headers.get("Range"):
            headers["Range"] = range_header
        if if_range := request.headers.get("If-Range"):
            headers["If-Range"] = if_range

        try:
            async with coordinator.client.session.get(
                coordinator.client.media_url(kind, media_id),
                headers={**coordinator.client.headers, **headers},
                timeout=aiohttp.ClientTimeout(total=None, connect=15, sock_read=60),
                allow_redirects=False,
            ) as upstream:
                if upstream.status not in (200, 206, 416):
                    if upstream.status == 404:
                        return web.Response(status=404, text="Media not found")
                    _LOGGER.warning("Kestrel media request returned HTTP %s", upstream.status)
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
            _LOGGER.debug("Kestrel media proxy failed: %s", err)
            return web.Response(status=502, text="Kestrel media request failed")


def async_register_media_view(hass: HomeAssistant) -> None:
    """Register the proxy exactly once per HA instance."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("media_view_registered"):
        return
    domain_data["media_view_registered"] = True
    hass.http.register_view(KestrelMediaView(hass))
