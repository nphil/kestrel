"""Authenticated Home Assistant websocket API for Kestrel's dashboard."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any
from urllib.parse import quote, unquote

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from . import birdnet_availability, birdnet_review, range_filter, recording_extras, recording_keep, recording_retention, species_descriptions
from .client import KestrelApiError
from .const import BIRDNET_GO_INGRESS_PATH, DOMAIN, MEDIA_KINDS, MEDIA_URL_TTL_HOURS, SIGNAL_EVENTS
from .coordinator import KestrelCoordinator

_LOGGER = logging.getLogger(__name__)
_MEDIA_RE = re.compile(r"(?:^|/)media/(snap|crop|clip|audio|species|camera|live|birdnet_audio)/([^?#]+)")
_PERIODS = ("today", "week", "month", "all")
_HIGHLIGHT_KINDS = ("seen", "heard", "both")


def _coordinator(hass: HomeAssistant) -> KestrelCoordinator:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        raise KestrelApiError("Kestrel is not set up")
    return coordinator


def _signed_media_url(
    hass: HomeAssistant, kind: str, media_id: str, refresh_token_id: str | None
) -> str:
    if kind not in MEDIA_KINDS:
        raise KestrelApiError("Unsupported Kestrel media type")
    # A clip name is a path under BirdNET-Go's clips folder: its "/" stays (it is validated where it is served).
    path = f"/api/kestrel/media/{kind}/{quote(unquote(media_id), safe='/' if kind == 'birdnet_clip' else '')}"
    return async_sign_path(
        hass,
        path,
        timedelta(hours=MEDIA_URL_TTL_HOURS),
        refresh_token_id=refresh_token_id,
    )


def _signed_recording_url(hass: HomeAssistant, part: dict[str, Any], refresh_token_id: str | None) -> str | None:
    """Signed link to BirdNET-Go's recording for a plugin `audio` / `heard` part, only when it is known to exist."""
    recording = birdnet_availability.recording_of(part)
    if recording is None or birdnet_availability.audio_available_now(hass, recording[1]) is not True:
        return None
    return _signed_media_url(hass, recording[0], recording[1], refresh_token_id)


def _apply_preview(
    hass: HomeAssistant,
    target: dict[str, Any],
    url_key: str,
    original: str | None,
    detection_id: Any,
    visit_id: Any,
    refresh_token_id: str | None,
) -> None:
    """Add the bird-call preview fields when the audio service has a verdict for this call."""
    previews = hass.data.get(DOMAIN, {}).get("audio")
    if previews is None or not isinstance(detection_id, int) or isinstance(detection_id, bool):
        return
    previews.note_visit(visit_id, detection_id)
    info = previews.fields(detection_id)
    if info is None:
        return
    target["audioInfo"] = info.as_payload()
    if info.state == "pending":
        previews.track(detection_id, visit_id, target.get("startedAt"))
    if info.state == "ready":
        target[url_key] = _signed_media_url(hass, "birdnet_preview", str(detection_id), refresh_token_id)
        if original is not None:
            target["audioOriginal"] = original


def _sign_media_paths(
    hass: HomeAssistant, value: Any, refresh_token_id: str | None
) -> Any:
    """Replace plugin-only media paths with signed HA-local URLs."""
    if isinstance(value, list):
        return [_sign_media_paths(hass, item, refresh_token_id) for item in value]
    if isinstance(value, dict):
        result = {
            key: _sign_media_paths(hass, item, refresh_token_id)
            for key, item in value.items()
        }
        species = result.get("species")
        has_photo = result.get("hasPhoto")
        if has_photo is True and isinstance(species, str) and species:
            result["photo_url"] = _signed_media_url(
                hass, "species", species + ".jpg", refresh_token_id
            )
        elif has_photo is False and isinstance(species, str) and species:
            # Kestrel has no photo of its own: offer the reference picture (BirdNET-Go's, else iNaturalist's, else Wikipedia's;
            # reference_photos.py picks when the picture is asked for) unless every source is known to have none.
            photos = hass.data.get(DOMAIN, {}).get("reference_photos")
            if photos is not None and photos.offer(species):
                result["referenceImage"] = _signed_media_url(hass, "species_ref", species, refresh_token_id)
                result["referenceImageInfoUrl"] = _signed_media_url(hass, "species_ref_info", species, refresh_token_id)
        if isinstance(has_photo, bool) and isinstance(species, str) and species:
            # Every species-shaped item (the list, a species sheet, a highlight) also says its scientific name, when it is known
            # without asking anyone (species_descriptions.py); null when it is not.
            result["scientific"] = species_descriptions.scientific_name(hass, species)
        audio = result.get("audio")
        if isinstance(audio, dict):
            original = _signed_recording_url(hass, audio, refresh_token_id)
            result["audio"] = original
            # Only a recording with a real detection id can have a bird-call preview (the audio service is keyed by it).
            _apply_preview(
                hass, result, "audio", original, birdnet_availability.recording_id_of(audio),
                result.get("id", result.get("visit_id")), refresh_token_id,
            )
        heard = result.get("heard")
        if isinstance(heard, dict):
            heard_original = _signed_recording_url(hass, heard, refresh_token_id)
            if heard_original is not None:
                heard["audio_url"] = heard_original
            _apply_preview(
                hass, heard, "audio_url", heard_original, birdnet_availability.recording_id_of(heard),
                heard.get("visitId"), refresh_token_id,
            )
            if "hasAudio" in heard:
                heard["hasAudio"] = bool(heard.get("audio_url"))  # the panel offers "Play call" only for a call it can play
        clip = result.get("clip")
        visit_id = result.get("id", result.get("visit_id"))
        if isinstance(clip, dict) and clip.get("state") == "ready" and visit_id is not None:
            clip["url"] = _signed_media_url(
                hass, "clip", f"{visit_id}.mp4", refresh_token_id
            )
        return result
    if isinstance(value, str):
        match = _MEDIA_RE.search(value)
        if match:
            return _signed_media_url(hass, match.group(1), match.group(2), refresh_token_id)
    return value


async def _async_api_call(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    body: Any | None = None,
    postprocess: Callable[[Any], Any] | None = None,
    async_postprocess: Callable[[Any], Awaitable[Any]] | None = None,
    on_result: Callable[[Any], None] | None = None,
) -> None:
    try:
        result = await _coordinator(hass).client.async_request(
            method, path, params=params, json=body
        )
        if on_result is not None:
            try:  # the raw answer, before media paths are signed; a failure here never changes what the panel gets
                on_result(result)
            except Exception:
                _LOGGER.warning("Kestrel after-request hook failed", exc_info=True)
        # Both lookups are for the same answer and ask different services: they run side by side, so the slower one sets the wait, not their sum.
        lookups = [birdnet_availability.async_confirm_audio(hass, result)]
        previews = hass.data.get(DOMAIN, {}).get("audio")
        if previews is not None:
            lookups.append(previews.async_prefetch(result))
        await asyncio.gather(*lookups)
        result = _sign_media_paths(hass, result, connection.refresh_token_id)
        if postprocess is not None:
            result = postprocess(result)
        if async_postprocess is not None:
            result = await async_postprocess(result)
        connection.send_result(msg["id"], result)
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
    except Exception:
        _LOGGER.exception("Kestrel websocket request failed")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")


@websocket_api.websocket_command({vol.Required("type"): "kestrel/cameras"})
@websocket_api.async_response
async def ws_cameras(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "cameras")


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/visits",
        vol.Optional("camera"): str,
        vol.Optional("species"): str,
        vol.Optional("kind"): str,
        vol.Optional("status"): str,
        vol.Optional("before"): str,
        vol.Optional("limit"): vol.All(int, vol.Range(min=1, max=50)),
    }
)
@websocket_api.async_response
async def ws_visits(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    params = {
        key: msg[key]
        for key in ("camera", "species", "kind", "status", "before", "limit")
        if key in msg
    }
    await _async_api_call(hass, connection, msg, "GET", "visits", params=params or None)


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/visit", vol.Optional("visit_id"): vol.Any(str, None)}
)
@websocket_api.async_response
async def ws_visit(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    visit_id = msg.get("visit_id")
    if not isinstance(visit_id, str) or not visit_id.strip():
        # The schema leaves visit_id optional so a missing id is answered here with a plain
        # error; a schema failure would make Home Assistant log an error for every attempt.
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, "A visit_id is required")
        return
    await _async_api_call(hass, connection, msg, "GET", f"visits/{quote(visit_id, safe='')}")


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/visit/correct",
        vol.Required("visit_id"): str,
        vol.Required("species"): str,
    }
)
@websocket_api.async_response
async def ws_visit_correct(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    await _async_api_call(
        hass,
        connection,
        msg,
        "POST",
        f"visits/{quote(msg['visit_id'], safe='')}/correct",
        body={"species": msg["species"]},
        on_result=birdnet_review.review_hook(hass, connection, "correct", msg["species"]),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/visit/confirm",
        vol.Required("visit_id"): str,
        vol.Optional("also_heard", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_visit_confirm(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    body = {"also_heard": True} if msg.get("also_heard") else None
    await _async_api_call(
        hass,
        connection,
        msg,
        "POST",
        f"visits/{quote(msg['visit_id'], safe='')}/confirm",
        body=body,
        on_result=birdnet_review.review_hook(hass, connection, "confirm"),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/visit/undo", vol.Required("visit_id"): str}
)
@websocket_api.async_response
async def ws_visit_undo(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    await _async_api_call(
        hass,
        connection,
        msg,
        "POST",
        f"visits/{quote(msg['visit_id'], safe='')}/undo",
        on_result=birdnet_review.review_hook(hass, connection, "undo"),
    )


@websocket_api.websocket_command({vol.Required("type"): "kestrel/review"})
@websocket_api.async_response
async def ws_review(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "review")


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/species", vol.Optional("period"): vol.In(_PERIODS)}
)
@websocket_api.async_response
async def ws_species(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The species list. With `period` (today, week, month or all; days are New York days) only the species that came in that
    period are listed, each with `periodCount`, `periodSeen` and `periodHeard`; every other number stays all-time."""
    await _async_api_call(
        hass, connection, msg, "GET", "species", params={"period": msg["period"]} if "period" in msg else None
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/species/detail", vol.Required("species"): str}
)
@websocket_api.async_response
async def ws_species_detail(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """A species' sheet. The numbers are the plugin's; the few words about the species (`description`, from Wikipedia, with
    `descriptionSource` to credit it) and its scientific name are added here, but only what is already known: the sheet never
    waits for Wikipedia. When the words are not kept yet their lookup is started in the background and `descriptionPending`
    is true: the sheet then asks `kestrel/species/description` for them a moment later."""

    def describe(result: Any) -> Any:
        descriptions = hass.data.get(DOMAIN, {}).get("species_descriptions")
        entry = descriptions.describe_now(msg["species"]) if descriptions is not None else None
        if not isinstance(result, dict):
            return result
        return {
            **result,
            "scientific": result.get("scientific") or (entry.scientific if entry is not None else None),
            "description": entry.text if entry is not None else None,
            "descriptionSource": entry.source() if entry is not None else None,
            "descriptionPending": entry is None and descriptions is not None and descriptions.pending(msg["species"]),
        }

    await _async_api_call(
        hass, connection, msg, "GET", f"species/{quote(msg['species'], safe='')}", postprocess=describe
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/species/description", vol.Required("species"): vol.All(str, vol.Length(min=1, max=100))}
)
@websocket_api.async_response
async def ws_species_description(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """The words a sheet that opened with `descriptionPending` is waiting for: `{species, scientific, description,
    descriptionSource}`; the last two are null when there is none (no article, or Wikipedia could not be asked just now).
    Waits for the lookup that is already running, for a while at most (species_descriptions.ASK_WAIT_S)."""
    descriptions = hass.data.get(DOMAIN, {}).get("species_descriptions")
    if descriptions is None:
        connection.send_error(msg["id"], "not_ready", "Species descriptions are not set up")
        return
    try:
        entry = await descriptions.async_describe(msg["species"])
    except Exception:
        _LOGGER.exception("Kestrel species description request failed")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(
        msg["id"],
        {
            "species": msg["species"],
            "scientific": (entry.scientific if entry is not None else None)
            or species_descriptions.scientific_name(hass, msg["species"]),
            "description": entry.text if entry is not None else None,
            "descriptionSource": entry.source() if entry is not None else None,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/highlights",
        vol.Optional("period"): vol.In(_PERIODS),
        vol.Optional("kind"): vol.In(_HIGHLIGHT_KINDS),
    }
)
@websocket_api.async_response
async def ws_highlights(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The latest, the most frequent and the rarest species of a period (default all), among what was seen, heard or both
    (default both): `{period, kind, latest, top, rare}`, each a species item with `kind`, `count` and `visitId`, or null."""
    params = {key: msg[key] for key in ("period", "kind") if key in msg}
    await _async_api_call(hass, connection, msg, "GET", "highlights", params=params or None)


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/species/reference", vol.Required("species"): vol.All(str, vol.Length(min=1, max=100))}
)
@websocket_api.async_response
async def ws_species_reference(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """A reference recording of a species ("Play reference"): who made it, where it comes from, and a signed link to it.

    Looked up the first time it is asked for, then remembered (reference_sounds.py). `state` is "ready", "none" (no
    recording exists) or "unavailable" (a source could not be asked just now; ask again later).
    """
    sounds = hass.data.get(DOMAIN, {}).get("reference_sounds")
    if sounds is None:
        connection.send_error(msg["id"], "not_ready", "Reference sounds are not set up")
        return
    try:
        result = await sounds.async_lookup(msg["species"])
        result["clips"] = [
            {**clip, "url": _signed_media_url(hass, "species_sound", clip["id"], connection.refresh_token_id)}
            for clip in result["clips"]
        ]
    except Exception:
        _LOGGER.exception("Kestrel reference sound lookup failed")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "kestrel/labels"})
@websocket_api.async_response
async def ws_labels(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "labels")


@websocket_api.websocket_command({vol.Required("type"): "kestrel/health"})
@websocket_api.async_response
async def ws_health(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(
        hass,
        connection,
        msg,
        "GET",
        "health",
        postprocess=lambda result: (
            {**result, "birdnetLink": BIRDNET_GO_INGRESS_PATH}
            if isinstance(result, dict)
            else result
        ),
    )


@websocket_api.websocket_command({vol.Required("type"): "kestrel/settings/get"})
@websocket_api.async_response
async def ws_settings_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "settings")


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/settings/set", vol.Required("settings"): dict}
)
@websocket_api.async_response
async def ws_settings_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    await _async_api_call(hass, connection, msg, "PUT", "settings", body=msg["settings"])


_CLIP_REASONS = ("notAnimal",)


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/clips/storage", vol.Optional("older_than"): vol.Any(int, float)}
)
@websocket_api.async_response
async def ws_clips_storage(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """How many camera clips Kestrel keeps and how much space they use. Anyone signed in may look; the page is told whether this user may delete.
    With `older_than` (millisecond timestamp) the numbers cover only clips from visits before it: what "delete older than..." would remove."""
    can_delete = bool(connection.user.is_admin)
    older_than = msg.get("older_than")
    if older_than is not None and (isinstance(older_than, bool) or older_than <= 0):
        connection.send_error(msg["id"], "invalid_format", "older_than must be a millisecond timestamp")
        return
    await _async_api_call(
        hass,
        connection,
        msg,
        "GET",
        "clips/storage",
        params={"olderThan": older_than} if older_than is not None else None,
        postprocess=lambda result: {**result, "canDelete": can_delete} if isinstance(result, dict) else result,
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/clips/delete",
        vol.Optional("visit_ids"): [str],
        vol.Optional("older_than"): vol.Any(int, float),
        vol.Optional("reason"): str,
    }
)
@websocket_api.async_response
async def ws_clips_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Delete saved camera clips (the photos and visits stay). Administrators only. Exactly one way of choosing which clips:
    `visit_ids` (these visits), `older_than` (millisecond timestamp: clips from visits before it) or `reason` (`notAnimal`: visits marked Not an animal or Can't tell)."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Only a Home Assistant administrator can delete clips")
        return
    chosen = [key for key in ("visit_ids", "older_than", "reason") if key in msg]
    if len(chosen) != 1:
        connection.send_error(msg["id"], "invalid_format", "Choose exactly one of visit_ids, older_than or reason")
        return
    (key,) = chosen
    if key == "visit_ids":
        ids = msg["visit_ids"]
        if not ids or any(not item.strip() for item in ids):
            connection.send_error(msg["id"], "invalid_format", "visit_ids needs at least one visit id")
            return
        body: dict[str, Any] = {"visitIds": ids}
    elif key == "older_than":
        older_than = msg["older_than"]
        if isinstance(older_than, bool) or older_than <= 0:
            connection.send_error(msg["id"], "invalid_format", "older_than must be a millisecond timestamp")
            return
        body = {"olderThan": older_than}
    else:
        if msg["reason"] not in _CLIP_REASONS:
            connection.send_error(msg["id"], "invalid_format", f"reason must be one of {', '.join(_CLIP_REASONS)}")
            return
        body = {"reason": msg["reason"]}
    await _async_api_call(hass, connection, msg, "POST", "clips/delete", body=body)


@websocket_api.websocket_command({vol.Required("type"): "kestrel/range_filter/get"})
@websocket_api.async_response
async def ws_range_filter_get(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """BirdNET-Go's local species filter: strictness, species allowed, location. Anyone signed in may look."""
    try:
        state = await range_filter.async_read(hass)
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not read the BirdNET-Go species filter")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": bool(connection.user.is_admin)})


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/range_filter/set", vol.Required("threshold"): vol.Any(int, float)}
)
@websocket_api.async_response
async def ws_range_filter_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Change the species filter's strictness. Administrators only: it changes what BirdNET-Go reports."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Only a Home Assistant administrator can change this")
        return
    try:
        state = await range_filter.async_set_threshold(hass, msg["threshold"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not change the BirdNET-Go species filter")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": True})


@websocket_api.websocket_command({vol.Required("type"): "kestrel/recording_retention/get"})
@websocket_api.async_response
async def ws_recording_retention_get(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """How long BirdNET-Go keeps its recordings, how full their folder is, how many are kept for good. Anyone signed in may look."""
    try:
        state = await recording_retention.async_read(hass)
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not read how BirdNET-Go keeps its recordings")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": bool(connection.user.is_admin)})


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/recording_retention/set", vol.Required("keep"): vol.In(recording_retention.KEEP_CHOICES)}
)
@websocket_api.async_response
async def ws_recording_retention_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Change how long BirdNET-Go keeps its recordings (30, 60 or 90 days, or until space runs low). Administrators only: it deletes recordings."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Only a Home Assistant administrator can change this")
        return
    try:
        state = await recording_retention.async_set_keep(hass, msg["keep"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not change how BirdNET-Go keeps its recordings")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": True})


async def _async_keep_target(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> int | None | bool:
    """The BirdNET-Go detection behind a visit's recording: its number, None when the visit has no lockable
    recording, or False after an error was sent (the caller stops)."""
    try:
        visit = await _coordinator(hass).client.async_request("GET", f"visits/{quote(msg['visit_id'], safe='')}")
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return False
    except Exception:
        _LOGGER.exception("Kestrel could not look up a visit's recording")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return False
    return recording_keep.detection_id_for_visit(visit)


@websocket_api.websocket_command({vol.Required("type"): "kestrel/recording/keep/get", vol.Required("visit_id"): str})
@websocket_api.async_response
async def ws_recording_keep_get(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Whether a visit's recording is kept (exempt from BirdNET-Go's age clean-up) and can be. Anyone signed in may look."""
    can_change = bool(connection.user.is_admin)
    detection_id = await _async_keep_target(hass, connection, msg)
    if detection_id is False:
        return
    if detection_id is None:
        connection.send_result(msg["id"], {"keepable": False, "kept": False, "canChange": can_change})
        return
    try:
        state = await recording_keep.async_read(hass, detection_id)
    except KestrelApiError as err:
        if err.status == 404:  # BirdNET-Go no longer has this detection
            connection.send_result(msg["id"], {"keepable": False, "kept": False, "canChange": can_change})
        else:
            connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not read whether a recording is kept")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": can_change})


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/recording/keep/set", vol.Required("visit_id"): str, vol.Required("keep"): bool}
)
@websocket_api.async_response
async def ws_recording_keep_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Keep a visit's recording, or release it to the normal clean-up. Administrators only: it decides what BirdNET-Go deletes."""
    if not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Only a Home Assistant administrator can change this")
        return
    detection_id = await _async_keep_target(hass, connection, msg)
    if detection_id is False:
        return
    if detection_id is None:
        connection.send_error(msg["id"], "not_found", "BirdNET-Go has no recording to keep for this one")
        return
    try:
        state = await recording_keep.async_set(hass, detection_id, msg["keep"])
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not change whether a recording is kept")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    connection.send_result(msg["id"], {**state, "canChange": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kestrel/recordings",
        vol.Required("visit_ids"): vol.All([vol.All(str, vol.Length(min=1, max=100))], vol.Length(min=1, max=20)),
    }
)
@websocket_api.async_response
async def ws_recordings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The weather and the spectrogram of the recordings of up to 20 visits (heard visits, or sightings with a call linked):
    `{items: {<visit id>: {weather, spectrogram}}}`, an entry for every id asked about, both null when there is nothing to show.
    `weather` is {temp, unit, conditions, icon} in Home Assistant's unit system; `spectrogram` is a signed link to a picture
    (an answer of "no content" means BirdNET-Go has not drawn it yet, or cannot). Asked for when a sheet opens, not with the list.
    The visits come from the plugin in ONE request (`POST visits/lookup`); an id it has no visit for (deleted since the panel
    listed it) is simply missing from its answer and gets no extras."""
    ids = list(dict.fromkeys(msg["visit_ids"]))
    try:
        answer = await _coordinator(hass).client.async_request("POST", "visits/lookup", json={"ids": ids})
        found = answer.get("items") if isinstance(answer, dict) else None
        found = found if isinstance(found, dict) else {}
        extras = await recording_extras.async_extras(hass, {visit_id: found[visit_id] for visit_id in ids if found.get(visit_id) is not None})
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    except Exception:
        _LOGGER.exception("Kestrel could not look up the extras of some recordings")
        connection.send_error(msg["id"], "unknown_error", "Kestrel request failed")
        return
    items: dict[str, dict[str, Any]] = {}
    for visit_id in ids:
        extra = extras.get(visit_id, recording_extras.NO_EXTRAS)
        items[visit_id] = {
            "weather": extra.weather,
            "spectrogram": None if extra.spectrogram is None else _signed_media_url(
                hass, "birdnet_spectrogram", str(extra.spectrogram), connection.refresh_token_id
            ),
        }
    connection.send_result(msg["id"], {"items": items})


@websocket_api.websocket_command({vol.Required("type"): "kestrel/subscribe"})
@websocket_api.async_response
async def ws_subscribe(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    try:
        _coordinator(hass)
    except KestrelApiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return

    @callback
    def forward_batch(events: list[dict[str, Any]]) -> None:
        hass.async_create_task(send_events(events), "kestrel websocket event batch")

    async def send_events(events: list[dict[str, Any]]) -> None:
        await birdnet_availability.async_confirm_audio(hass, events)
        for event in events:
            signed_event = _sign_media_paths(hass, event, connection.refresh_token_id)
            connection.send_event(msg["id"], signed_event)

    # Listen on the hass-wide signal rather than on one coordinator: a config-entry reload
    # replaces the coordinator, and this subscription must keep receiving from the new one.
    # The disconnect callable it returns is what Home Assistant calls on unsubscribe or close.
    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_EVENTS, forward_batch)
    connection.send_result(msg["id"], {"subscribed": True})


def async_setup_websocket_api(hass: HomeAssistant) -> None:
    """Register the Kestrel websocket commands once per HA instance."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("websocket_registered"):
        return
    domain_data["websocket_registered"] = True
    for handler in (
        ws_cameras,
        ws_visits,
        ws_visit,
        ws_visit_correct,
        ws_visit_confirm,
        ws_visit_undo,
        ws_review,
        ws_species,
        ws_species_detail,
        ws_species_description,
        ws_highlights,
        ws_species_reference,
        ws_labels,
        ws_health,
        ws_settings_get,
        ws_settings_set,
        ws_clips_storage,
        ws_clips_delete,
        ws_range_filter_get,
        ws_range_filter_set,
        ws_recording_retention_get,
        ws_recording_retention_set,
        ws_recording_keep_get,
        ws_recording_keep_set,
        ws_recordings,
        ws_subscribe,
    ):
        websocket_api.async_register_command(hass, handler)
