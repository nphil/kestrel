"""Authenticated streaming media proxy for Kestrel plugin files, BirdNET-Go audio and spectrograms, bird-call previews and reference sounds and photos."""

from __future__ import annotations

import json
import logging

import aiohttp
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import birdnet_api
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

# How long BirdNET-Go may keep a browser waiting. A browser's picture or audio element has no time limit of its own, so a recording that
# BirdNET-Go was slow to draw used to leave an empty frame on screen for half a minute and then a failure. Measured on the real BirdNET-Go:
# a picture that is already drawn comes back in 0.07 to 0.15 s, a recording it has no clip for answers "not found" in about 60 ms, but the FIRST
# picture of a recording took 7 to 28 s while the storage under BirdNET-Go was stalled. It carries on drawing after we stop waiting, so the next
# ask finds the picture ready. Its `/spectrogram/<id>/status` call is never used: it hangs for 30 seconds or more.
SPECTROGRAM_WAIT_S = 10.0  # the whole picture, from asking to the last byte: enough for an ordinary draw, short enough to say "not ready yet"
RECORDING_STALL_S = 12.0  # a recording is a stream (a long one takes longer in total), so only silence counts: no byte at all for this long
_CONNECT_S = 4.0  # BirdNET-Go runs next to Home Assistant, so a connection that takes longer than this is not going to be made
# What BirdNET-Go and the preview service answer for a recording that is not ready or that they are too busy for. It means "try again in a
# moment", unlike 404, which means "there is no such recording" and stays a 404.
_BUSY_STATUSES = (202, 408, 425, 429, 499, 502, 503, 504)


def _detection_number(media_id: str) -> int | None:
    """The BirdNET-Go detection a recording link names, or None (its numbers start at 1, so "0" names nothing)."""
    return detection_id_of(int(media_id)) if media_id.isascii() and media_id.isdigit() else None


def _recording_timeout() -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=None, connect=_CONNECT_S, sock_read=RECORDING_STALL_S)


def _try_again_later() -> web.Response:
    """A recording that is not ready yet: 503 with a hint to ask again in a few seconds. The audio players treat every failure alike (they fall back to the
    original file, then offer "Try again"), so this changes how soon they hear about it, not what they do."""
    return web.Response(status=503, headers={"Retry-After": "5"}, text="Recording not ready yet")


def _no_picture() -> web.Response:
    """No picture right now: 204 No Content, which a browser's image element treats as "nothing to show" without logging a failed request. Never kept by
    the browser or Home Assistant: the picture may be there a moment later."""
    return web.Response(status=204, headers={"Cache-Control": "no-store"})


async def _draws_only_when_asked(upstream: aiohttp.ClientResponse) -> bool:
    """True when BirdNET-Go's "not found" explains that it draws pictures only on request (its `user-requested` mode), which is not the same as "this
    recording has no picture". Its answer is JSON with the mode under `data`; anything else (not JSON, another shape) means no."""
    try:
        body = await upstream.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return False
    data = body.get("data") if isinstance(body, dict) else None
    return isinstance(data, dict) and data.get("mode") == "user-requested"


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
                _recording_timeout(),
                retry_later=True,
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
                _recording_timeout(),
                retry_later=True,
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
                _recording_timeout(),
                retry_later=True,
            )

        if kind == "birdnet_spectrogram":
            # The picture of a recording's sound, drawn by BirdNET-Go from the saved clip (514 x 257 pixels, no axes, so its full width is
            # the whole recording). A picture it cannot give right now (no clip, not drawn yet, busy, too slow) is decoration that is not
            # there, "no content" rather than an error, as for a reference photo. The picture of a recording never changes.
            if _detection_number(media_id) is None:
                return web.Response(status=404, text="Media not found")
            return await self._spectrogram(media_id, headers)

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

    async def _spectrogram(self, media_id: str, headers: dict[str, str]) -> web.Response:
        """The picture of a recording, or "no picture right now" (204): never an error and never a wait without end (`SPECTROGRAM_WAIT_S`).
        The picture is small, so it is read completely before anything goes to the browser: a stall can then only happen while nothing has
        been sent, when "not ready" is still a possible answer, instead of after half a picture."""
        url = f"{BIRDNET_GO_INTERNAL_URL}/api/v2/spectrogram/{media_id}?size=md&raw=true"
        timeout = aiohttp.ClientTimeout(total=SPECTROGRAM_WAIT_S, connect=_CONNECT_S)
        try:
            async with async_get_clientsession(self._hass).get(url, headers=headers, timeout=timeout, allow_redirects=False) as upstream:
                if upstream.status not in (200, 206, 416):
                    # Not found, "accepted", busy, broken: whatever the reason, the picture is not there yet and the panel asks again later.
                    # One case is worth acting on: BirdNET-Go set to draw only on request says so in its "not found".
                    if upstream.status == 404 and await _draws_only_when_asked(upstream):
                        self._ask_for_drawing(media_id)
                    _LOGGER.debug("Kestrel spectrogram %s: BirdNET-Go answered HTTP %s", media_id, upstream.status)
                    return _no_picture()
                status = upstream.status
                # No Content-Length: the HTTP client may have unpacked a compressed answer, so the length it announced need not be the body's.
                forwarded = {name: upstream.headers[name] for name in _FORWARD_HEADERS if name != "Content-Length" and name in upstream.headers}
                body = b"".join([chunk async for chunk in upstream.content.iter_chunked(64 * 1024)])
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            _LOGGER.debug("Kestrel spectrogram %s: BirdNET-Go did not deliver it: %s", media_id, err)
            return _no_picture()
        forwarded["Cache-Control"] = "private, max-age=2592000"
        return web.Response(status=status, body=body, headers=forwarded)

    def _ask_for_drawing(self, media_id: str) -> None:
        """BirdNET-Go set to draw pictures only on request draws nothing until it is told to. Tell it once, in the background so the browser is not kept
        waiting for it; the picture is there on the browser's next try. Browsers asking at the same time cause one request, not several."""
        asking: set[str] = self._hass.data.setdefault(DOMAIN, {}).setdefault("spectrograms_requested", set())
        if media_id in asking:
            return
        asking.add(media_id)
        self._hass.async_create_background_task(self._draw(media_id, asking), f"kestrel spectrogram {media_id}")

    async def _draw(self, media_id: str, asking: set[str]) -> None:
        try:
            headers = await birdnet_api.async_write_headers(self._hass)
            await birdnet_api.async_request(self._hass, "POST", f"/spectrogram/{media_id}/generate?size=md&raw=true", headers=headers)
        except KestrelApiError as err:
            # Nothing to tell the browser: it asks again later anyway. (BirdNET-Go answering "accepted" (202) ends up here too.)
            _LOGGER.debug("Kestrel spectrogram %s: asking BirdNET-Go to draw it did not work: %s", media_id, err)
        finally:
            asking.discard(media_id)

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
        retry_later: bool = False,
    ) -> web.StreamResponse:
        """Stream `url`. `optional` is for decoration the source may simply not have (a reference photo): the
        source saying "not found" or "still working on it" (404, 202, 503) is an ordinary answer, so it is
        passed on as 204 No Content, which a browser's image element treats as "no picture" without logging
        a failed request, instead of as an error. `retry_later` is for a recording the source may not have ready
        yet or be too slow to send: its busy answers (`_BUSY_STATUSES`), a stall and a failed connection become
        503 with `Retry-After` ("try again in a moment") rather than 502; a 404 stays a 404."""
        started = False
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
                    if retry_later and upstream.status in _BUSY_STATUSES:
                        _LOGGER.debug("Kestrel media %s: upstream answered HTTP %s, so try again later", url, upstream.status)
                        return _try_again_later()
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
                started = True
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response
        except (KestrelApiError, aiohttp.ClientError, TimeoutError, OSError) as err:
            if started:
                # Part of the file is already with the browser, so no other answer can follow it, and ending the answer quietly would leave the
                # browser waiting for bytes that never come. Cutting the connection is how a browser learns that the file is short.
                _LOGGER.debug("Kestrel media proxy broke off %s: %s", url, err)
                if request.transport is not None:
                    request.transport.close()
                return response
            _LOGGER.debug("Kestrel media proxy failed for %s: %s", url, err)
            return _try_again_later() if retry_later else web.Response(status=502, text="Kestrel media request failed")


def async_register_media_view(hass: HomeAssistant) -> None:
    """Register the proxy exactly once per HA instance."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("media_view_registered"):
        return
    domain_data["media_view_registered"] = True
    hass.http.register_view(KestrelMediaView(hass))
