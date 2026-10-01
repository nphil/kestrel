"""Authenticated Home Assistant websocket API for Kestrel's dashboard."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from urllib.parse import quote, unquote

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from . import birdnet_availability
from .client import KestrelApiError
from .const import BIRDNET_GO_INGRESS_PATH, DOMAIN, MEDIA_KINDS, MEDIA_URL_TTL_HOURS, SIGNAL_EVENTS
from .coordinator import KestrelCoordinator

_LOGGER = logging.getLogger(__name__)
_MEDIA_RE = re.compile(r"(?:^|/)media/(snap|crop|clip|audio|species|camera|birdnet_audio)/([^?#]+)")


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
    path = f"/api/kestrel/media/{kind}/{quote(unquote(media_id), safe='')}"
    return async_sign_path(
        hass,
        path,
        timedelta(hours=MEDIA_URL_TTL_HOURS),
        refresh_token_id=refresh_token_id,
    )


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
            scientific_name = (
                hass.data.get(DOMAIN, {})
                .get("birdnet_species_map", {})
                .get(species.strip().lower())
            )
            if scientific_name and birdnet_availability.image_available_now(hass, scientific_name) is not False:
                result["referenceImage"] = _signed_media_url(
                    hass, "species_ref", scientific_name, refresh_token_id
                )
                result["referenceImageInfoUrl"] = _signed_media_url(
                    hass, "species_ref_info", scientific_name, refresh_token_id
                )
        audio = result.get("audio")
        if isinstance(audio, dict):
            detection_id = audio.get("birdnetDetectionId")
            result["audio"] = (
                _signed_media_url(hass, "birdnet_audio", str(detection_id), refresh_token_id)
                if detection_id is not None
                and birdnet_availability.audio_available_now(hass, str(detection_id)) is not False
                else None
            )
        heard = result.get("heard")
        if isinstance(heard, dict):
            heard_detection_id = heard.get("birdnetDetectionId")
            if heard_detection_id is not None and birdnet_availability.audio_available_now(
                hass, str(heard_detection_id)
            ) is not False:
                heard["audio_url"] = _signed_media_url(
                    hass, "birdnet_audio", str(heard_detection_id), refresh_token_id
                )
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
) -> None:
    try:
        result = await _coordinator(hass).client.async_request(
            method, path, params=params, json=body
        )
        result = _sign_media_paths(hass, result, connection.refresh_token_id)
        if postprocess is not None:
            result = postprocess(result)
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
    )


@websocket_api.websocket_command({vol.Required("type"): "kestrel/review"})
@websocket_api.async_response
async def ws_review(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "review")


@websocket_api.websocket_command({vol.Required("type"): "kestrel/species"})
@websocket_api.async_response
async def ws_species(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _async_api_call(hass, connection, msg, "GET", "species")


@websocket_api.websocket_command(
    {vol.Required("type"): "kestrel/species/detail", vol.Required("species"): str}
)
@websocket_api.async_response
async def ws_species_detail(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    await _async_api_call(
        hass, connection, msg, "GET", f"species/{quote(msg['species'], safe='') }"
    )


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
        ws_labels,
        ws_health,
        ws_settings_get,
        ws_settings_set,
        ws_subscribe,
    ):
        websocket_api.async_register_command(hass, handler)
