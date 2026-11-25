"""The BirdNET-Go link check: what counts as broken, and the repair issue it raises and clears."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from custom_components.kestrel import birdnet_link
from custom_components.kestrel.birdnet_link import (
    API_CHANGED,
    NOT_REACHING_KESTREL,
    OK,
    UNREACHABLE,
    BirdnetLink,
    judge,
)
from custom_components.kestrel.client import KestrelApiError
from custom_components.kestrel.const import DOMAIN

NOW = datetime(2026, 11, 25, 22, 0, tzinfo=timezone.utc)
CONFIG = {"csrfToken": "abcdefgh12345678"}


def recent(minutes_ago: float) -> list[dict]:
    stamp = (NOW - timedelta(minutes=minutes_ago)).astimezone(timezone(timedelta(hours=-5)))
    return [{"id": 114512, "timestamp": stamp.isoformat(), "commonName": "Common Raven"}]


def health(minutes_ago: float | None) -> dict:
    if minutes_ago is None:
        return {"birdnet": None}
    return {"birdnet": {"online": True, "lastHeardAt": (NOW - timedelta(minutes=minutes_ago)).timestamp() * 1000}}


def test_detections_arriving_is_ok() -> None:
    assert judge(recent(30), CONFIG, health(30), NOW).reason == OK


def test_a_quiet_night_is_ok() -> None:
    """Nothing new from BirdNET-Go for hours, and the plugin received the last one: not a problem."""
    assert judge(recent(300), CONFIG, health(301), NOW).reason == OK


def test_a_fresh_detection_gets_time_to_arrive() -> None:
    assert judge(recent(2), CONFIG, health(600), NOW).reason == OK


def test_detections_not_reaching_the_plugin() -> None:
    verdict = judge(recent(20), CONFIG, health(180), NOW)
    assert verdict.reason == NOT_REACHING_KESTREL
    assert verdict.problem


def test_plugin_that_never_received_anything_while_birdnet_detects() -> None:
    assert judge(recent(20), CONFIG, health(None), NOW).reason == NOT_REACHING_KESTREL


def test_plugin_down_is_not_blamed_on_birdnet() -> None:
    """The plugin's own outage is the connection sensor's job; the link judges only what it can see."""
    assert judge(recent(20), CONFIG, KestrelApiError("Could not reach the Kestrel plugin"), NOW).reason == OK


def test_birdnet_unreachable() -> None:
    assert judge(KestrelApiError("Could not reach BirdNET-Go"), CONFIG, health(5), NOW).reason == UNREACHABLE


def test_birdnet_endpoint_gone() -> None:
    err = KestrelApiError("BirdNET-Go refused the request (HTTP 404)", status=404)
    assert judge(err, CONFIG, health(5), NOW).reason == API_CHANGED


def test_detection_shape_changed() -> None:
    assert judge([{"id": "x", "when": "now"}], CONFIG, health(5), NOW).reason == API_CHANGED
    assert judge({"data": []}, CONFIG, health(5), NOW).reason == API_CHANGED


def test_write_token_missing() -> None:
    assert judge(recent(30), {"other": 1}, health(30), NOW).reason == API_CHANGED


def test_no_detections_yet_is_ok() -> None:
    assert judge([], CONFIG, health(None), NOW).reason == OK


async def test_issue_raised_after_three_bad_checks_and_cleared(hass: HomeAssistant) -> None:
    client = AsyncMock()
    client.async_request.return_value = health(5)
    link = BirdnetLink(hass, client)
    issues = ir.async_get(hass)
    down = AsyncMock(side_effect=KestrelApiError("Could not reach BirdNET-Go"))

    with patch.object(birdnet_link.birdnet_api, "async_request", down):
        for _ in range(2):
            assert (await link.async_check()).reason == UNREACHABLE
            assert issues.async_get_issue(DOMAIN, birdnet_link.ISSUE_ID) is None
        await link.async_check()
    issue = issues.async_get_issue(DOMAIN, birdnet_link.ISSUE_ID)
    assert issue is not None
    assert issue.translation_key == "birdnet_link_unreachable"

    async def answers(_hass: HomeAssistant, _method: str, path: str) -> object:
        return CONFIG if path == "/app/config" else []

    with patch.object(birdnet_link.birdnet_api, "async_request", answers):
        assert (await link.async_check()).reason == OK
    assert issues.async_get_issue(DOMAIN, birdnet_link.ISSUE_ID) is None
