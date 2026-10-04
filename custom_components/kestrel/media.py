"""Authenticated streaming media proxy for Kestrel plugin files, BirdNET-Go audio, bird-call previews and reference sounds and photos."""

from __future__ import annotations

import json
import logging

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .birdnet_availability import clip_name_of, detection_id_of, recording_url
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
# Live camera pictures are only current for moments: the browser may ask "has it changed?" and the
# plugin answers 304, but nothing may be cached on our side.
_LIVE_CONDITIONAL_HEADERS = ("If-None-Match", "If-Modified-Since")


def _detection_number(media_id: str) -> int | None:
    """The BirdNET-Go detection a recording link names, or None (its numbers start at 1, so "0" names nothing)."""
    return detection_id_of(int(media_id)) if media_id.isascii() and media_id.isdigit() else None


class KestrelMediaView(HomeAssistantView):
    """Stream media from the authenticated plugin through Home Assistant."""

    # `.+`: a BirdNET-Go clip name ("2026/10/<file>.opus") has slashes in it; every other kind still refuses them below.
    url = "/api/kestrel/media/{kind}/{media_id:.+}"
    name = "api:kestrel:media"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, kind: str, media_id: str) -> web.StreamResponse:
        if kind not in MEDIA_KINDS or not media_id or ("/" in media_id and kind != "birdnet_clip"):
            return web.Response(status=404, text="Media not found")

        headers: dict[str, str] = {}
        if range_header := request.headers.get("Range"):
            headers["Range"] = range_header
        if if_range := request.headers.get("If-Range"):
            headers["If-Range"] = if_range

        if kind == "birdnet_audio":
            # BirdNET-Go's own add-on API, independent of the Kestrel plugin's connectivity.
            if _detection_number(media_id) is None:
                return web.Response(status=404, text="Media not found")
            return await self._stream(
                request,
                async_get_clientsession(self._hass),
                f"{BIRDNET_GO_INTERNAL_URL}/api/v2/audio/{media_id}",
                headers,
                aiohttp.ClientTimeout(total=None, connect=10, sock_read=30),
            )

        if kind == "birdnet_clip":
            # A recording BirdNET-Go saved but announced with detection id 0: only reachable by its clip name.
            clip = clip_name_of(media_id)
            url = recording_url(clip) if clip is not None else None
            if url is None:
                return web.Response(status=404, text="Media not found")
            return await self._stream(
                request,
                async_get_clientsession(self._hass),
                url,
                headers,
                aiohttp.ClientTimeout(total=None, connect=10, sock_read=30),
            )

        if kind == "birdnet_preview":
            # The kestrel-audio service's loudness-matched (and where it helps, cleaned) preview.
            previews = self._hass.data.get(DOMAIN, {}).get("audio")
            if previews is None or not previews.enabled or _detection_number(media_id) is None:
                return web.Response(status=404, text="Media not found")
            return await self._stream(
                request,
                async_get_clientsession(self._hass),
                previews.preview_url(media_id),
                {**previews.headers, **headers},
                aiohttp.ClientTimeout(total=None, connect=10, sock_read=30),
            )

        if kind in ("species_ref", "species_ref_info"):
            # A species' picture when Kestrel has none of its own, or who took it (reference_photos.py): BirdNET-Go's image cache,
            # else iNaturalist's default photo, else the Wikipedia page image. The link names the species. A picture the sources
            # simply do not have is decoration that is not there, "no content" rather than an error: a browser's image element
            # treats a 204 as "no picture" without logging a failed request.
            nothing = web.Response(status=204, headers={"Cache-Control": "private, max-age=300"})
            photos = self._hass.data.get(DOMAIN, {}).get("reference_photos")
            if photos is None:
                return nothing
            if kind == "species_ref_info":
                info = await photos.async_info(media_id)
                if info is None:
                    return nothing
                return web.Response(text=json.dumps(info), headers={"Content-Type": "application/json", "Cache-Control": "private, max-age=3600"})
            picture = await photos.async_image(media_id)
            if picture is None:
                return nothing
            if picture.path is not None:  # a photo kept here: Range, ETag and 304 are the file response's
                return web.FileResponse(picture.path, headers={"Content-Type": picture.content_type, "Cache-Control": "public, max-age=2592000"})
            return await self._stream(
                request,
                async_get_clientsession(self._hass),
                picture.stream,
                headers,
                aiohttp.ClientTimeout(total=None, connect=10, sock_read=30),
                cache_control="public, max-age=2592000",
                optional=True,
            )

        if kind == "species_sound":
            # A reference recording of a species (Xeno-canto / iNaturalist), kept on disk by reference_sounds.py and served from there
            # (Range, ETag and 304 included). Only a clip id the service issued names a file; anything else is not found.
            sounds = self._hass.data.get(DOMAIN, {}).get("reference_sounds")
            found = await sounds.async_audio(media_id) if sounds is not None else None
            if found is None:
                return web.Response(status=404, text="Media not found")
            path, content_type = found
            return web.FileResponse(path, headers={"Content-Type": content_type, "Cache-Control": "private, max-age=2592000"})

        coordinator: KestrelCoordinator | None = self._hass.data.get(DOMAIN, {}).get("coordinator")
        if coordinator is None:
            return web.Response(status=503, text="Kestrel is not connected")
        live = kind == "live"
        if live:
            headers.update(
                {name: request.headers[name] for name in _LIVE_CONDITIONAL_HEADERS if name in request.headers}
            )
        return await self._stream(
            request,
            coordinator.client.session,
            coordinator.client.media_url(kind, media_id),
            {**coordinator.client.headers, **headers},
            aiohttp.ClientTimeout(total=None, connect=15, sock_read=60),
            live=live,
        )

    @staticmethod
    async def _stream(
        request: web.Request,
        session: aiohttp.ClientSession,
        url: str,
        headers: dict[str, str],
        timeout: aiohttp.ClientTimeout,
        *,
        cache_control: str = "private, max-age=300",
        live: bool = False,
        optional: bool = False,
    ) -> web.StreamResponse:
        """Stream `url`. `optional` is for decoration the source may simply not have (a reference photo): the
        source saying "not found" or "still working on it" (404, 202, 503) is an ordinary answer, so it is
        passed on as 204 No Content, which a browser's image element treats as "no picture" without logging
        a failed request, instead of as an error."""
        try:
            async with session.get(
                url, headers=headers, timeout=timeout, allow_redirects=False
            ) as upstream:
                if live and upstream.status == 304:
                    # "Unchanged": answer with the validators only, never a body.
                    return web.Response(
                        status=304,
                        headers={
                            "Cache-Control": upstream.headers.get("Cache-Control", "no-store"),
                            **{n: upstream.headers[n] for n in ("ETag", "Last-Modified") if n in upstream.headers},
                        },
                    )
                if upstream.status not in (200, 206, 416):
                    if optional and upstream.status in (202, 404, 503):
                        _LOGGER.debug("Kestrel optional media %s: upstream answered HTTP %s", url, upstream.status)
                        return web.Response(status=204, headers={"Cache-Control": "private, max-age=300"})
                    if upstream.status in (202, 404):  # 202: the preview is still being made
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
                downstream_headers["Cache-Control"] = (
                    upstream.headers.get("Cache-Control", "no-store") if live else cache_control
                )
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
