"""Is BirdNET-Go still feeding Kestrel? A check that outlives BirdNET-Go updates.

BirdNET-Go is a separately updated Home Assistant app. Kestrel depends on three things
from it, and an update could break any of them without either side logging an error:

* its HTTP API answers (Kestrel plays recordings, reads models and sends corrections
  through it), checked by ``GET /api/v2/detections/recent?limit=1``;
* its write token still comes from ``/api/v2/app/config`` (corrections and the species
  filter need it);
* its detections still arrive at the Kestrel plugin over MQTT. BirdNET-Go's newest
  detection is compared with the last one the plugin received: if BirdNET-Go has been
  detecting while the plugin heard nothing, the link is broken even though both ends
  look healthy on their own.

Every five minutes the result is published as one problem sensor, and after three bad
checks in a row as a repair issue naming what broke. Quiet nights are not a problem: a
BirdNET-Go with nothing new to report is judged by the first two checks alone.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import birdnet_api
from .client import KestrelApiError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CHECK_INTERVAL = timedelta(minutes=5)
FIRST_CHECK_DELAY = 60.0  # let BirdNET-Go and the plugin finish starting after a restart
SETTLE_SECONDS = 10 * 60  # a detection gets this long to reach the plugin before it counts
ALLOWED_LAG_SECONDS = 15 * 60  # how far the plugin may trail BirdNET-Go's newest detection
ISSUE_AFTER_CHECKS = 3  # bad checks in a row before a repair issue is raised
ISSUE_ID = "birdnet_link"
SIGNAL_BIRDNET_LINK = f"{DOMAIN}_birdnet_link"

OK = "ok"
UNREACHABLE = "unreachable"
API_CHANGED = "api_changed"
NOT_REACHING_KESTREL = "not_reaching_kestrel"


@dataclass(frozen=True)
class LinkVerdict:
    """One check: what is wrong (``OK`` when nothing is) and what was seen."""

    reason: str
    newest_detection_at: datetime | None = None
    last_received_at: datetime | None = None
    detail: str | None = None

    @property
    def problem(self) -> bool:
        return self.reason != OK


def _http_status(err: BaseException) -> int | None:
    status = getattr(err, "status", None)
    return status if isinstance(status, int) else None


def _failure(err: BaseException, what: str) -> LinkVerdict:
    """An unreachable BirdNET-Go, or one that answers but no longer the way Kestrel expects."""
    status = _http_status(err)
    if status is None:
        return LinkVerdict(UNREACHABLE, detail=f"{what}: {err}")
    return LinkVerdict(API_CHANGED, detail=f"{what}: HTTP {status}")


def _newest_detection(payload: Any) -> tuple[bool, datetime | None]:
    """(understood, timestamp) for the answer to /detections/recent?limit=1."""
    if not isinstance(payload, list):
        return False, None
    if not payload:
        return True, None  # nothing detected yet
    first = payload[0]
    if not isinstance(first, dict) or not isinstance(first.get("id"), int):
        return False, None
    stamp = first.get("timestamp")
    parsed = dt_util.parse_datetime(stamp) if isinstance(stamp, str) else None
    if parsed is None or parsed.tzinfo is None:
        return False, None
    return True, parsed


def _last_received(health: Any) -> tuple[bool, datetime | None]:
    """(known, time) of the plugin's last BirdNET reading; not known when the plugin did not answer."""
    if isinstance(health, BaseException) or not isinstance(health, dict):
        return False, None
    birdnet = health.get("birdnet")
    if birdnet is None:
        return True, None  # the plugin has never received a reading
    millis = birdnet.get("lastHeardAt") if isinstance(birdnet, dict) else None
    if not isinstance(millis, (int, float)) or isinstance(millis, bool):
        return False, None
    return True, dt_util.utc_from_timestamp(millis / 1000)


def judge(recent: Any, config: Any, health: Any, now: datetime) -> LinkVerdict:
    """Decide from the three answers (each the parsed JSON, or the exception the request raised)."""
    if isinstance(recent, BaseException):
        return _failure(recent, "recent detections")
    understood, newest = _newest_detection(recent)
    if not understood:
        return LinkVerdict(API_CHANGED, detail="recent detections: unexpected answer")

    if isinstance(config, BaseException):
        verdict = _failure(config, "write token")
        return LinkVerdict(verdict.reason, newest, None, verdict.detail)
    token = config.get("csrfToken") if isinstance(config, dict) else None
    if not isinstance(token, str) or not birdnet_api._CSRF_TOKEN.fullmatch(token):
        return LinkVerdict(API_CHANGED, newest, detail="write token: missing from /app/config")

    known, received = _last_received(health)
    if newest is not None and known and (now - newest).total_seconds() >= SETTLE_SECONDS:
        if received is None or (newest - received).total_seconds() > ALLOWED_LAG_SECONDS:
            return LinkVerdict(
                NOT_REACHING_KESTREL,
                newest,
                received,
                "BirdNET-Go is detecting, but its detections are not reaching the Kestrel plugin over MQTT",
            )
    return LinkVerdict(OK, newest, received)


class BirdnetLink:
    """Runs the check on a timer and keeps the latest verdict for the problem sensor."""

    def __init__(self, hass: HomeAssistant, client: Any) -> None:
        self._hass = hass
        self._client = client
        self.verdict: LinkVerdict | None = None
        self.checked_at: datetime | None = None
        self._bad_in_a_row = 0
        self._unsub: Any = None
        self._task: asyncio.Task | None = None

    @callback
    def async_start(self) -> None:
        self._unsub = async_track_time_interval(self._hass, self._async_tick, CHECK_INTERVAL)
        self._task = self._hass.async_create_background_task(self._async_first(), "kestrel birdnet link check")

    async def async_stop(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _async_first(self) -> None:
        await asyncio.sleep(FIRST_CHECK_DELAY)
        await self.async_check()

    async def _async_tick(self, _now: datetime) -> None:
        await self.async_check()

    async def _async_fetch(self, coro: Any) -> Any:
        try:
            return await coro
        except (KestrelApiError, TimeoutError) as err:
            return err

    async def async_check(self) -> LinkVerdict:
        recent, config, health = await asyncio.gather(
            self._async_fetch(birdnet_api.async_request(self._hass, "GET", "/detections/recent?limit=1")),
            self._async_fetch(birdnet_api.async_request(self._hass, "GET", "/app/config")),
            self._async_fetch(self._client.async_request("GET", "health")),
        )
        verdict = judge(recent, config, health, dt_util.utcnow())
        previous = self.verdict
        self.verdict, self.checked_at = verdict, dt_util.utcnow()
        self._bad_in_a_row = self._bad_in_a_row + 1 if verdict.problem else 0
        if verdict.problem and (previous is None or previous.reason != verdict.reason):
            _LOGGER.warning("BirdNET-Go link: %s (%s)", verdict.reason, verdict.detail)
        elif not verdict.problem and previous is not None and previous.problem:
            _LOGGER.info("BirdNET-Go link is working again")
        self._update_issue(verdict)
        async_dispatcher_send(self._hass, SIGNAL_BIRDNET_LINK)
        return verdict

    @callback
    def _update_issue(self, verdict: LinkVerdict) -> None:
        if not verdict.problem:
            ir.async_delete_issue(self._hass, DOMAIN, ISSUE_ID)
            return
        if self._bad_in_a_row < ISSUE_AFTER_CHECKS:
            return
        ir.async_create_issue(
            self._hass,
            DOMAIN,
            ISSUE_ID,
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key=f"birdnet_link_{verdict.reason}",
            translation_placeholders={"detail": verdict.detail or ""},
        )
