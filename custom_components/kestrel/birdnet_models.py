"""Which BirdNET-Go models heard a visit: the evidence behind "Both models agreed".

BirdNET-Go runs two listening models over the same sound (BirdNET v3.0 and Perch). Each detection it keeps says which models
heard it, in its `modelContributions` list; the MQTT message the Kestrel plugin listens to names only the winning model, so the
plugin cannot see the agreement and this module carries it over:

    a heard visit announced by the plugin (visit_new / visit_updated, with its BirdNET-Go detection number)
      -> GET  <BirdNET-Go>/api/v2/detections/<id>             its modelContributions (open, no token)
      -> POST <plugin>/visits/<visit id>/models               {"detectionId": id, "contributions": [...]}

The plugin turns two different models naming the visit's species into "Both models agreed", which counts as evidence toward
Likely (two models naming different birds stays a Check). This is best effort, like everything here that talks to BirdNET-Go:
BirdNET-Go being slow, down, or having nothing to say leaves the visit exactly as it was, with a line in diagnostics.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import Counter, OrderedDict, deque
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util import dt as dt_util

from . import birdnet_api
from .announced import visit_id
from .birdnet_availability import detection_id_of
from .client import KestrelApiError
from .const import SIGNAL_EVENTS

_LOGGER = logging.getLogger(__name__)

MAX_AGE_S = 3600  # a visit older than this is not looked at (events replayed after a restart of Home Assistant)
RETRY_S = 20  # BirdNET-Go sometimes announces a detection before its model list is filled in: ask once more
MAX_CONCURRENT = 2  # BirdNET-Go can be slow (its storage stalls at times); never pile requests on it
REMEMBERED = 300  # (visit, detection) pairs not asked about twice
HISTORY = 30
MAX_CONTRIBUTIONS = 8  # the plugin takes at most this many
OUTCOMES = ("recorded", "unchanged", "no_models", "skipped", "failed")


class BirdnetModels:
    """Fetches which models heard each new heard visit and tells the plugin. One per config entry (`hass.data[DOMAIN]["birdnet_models"]`)."""

    def __init__(self, hass: HomeAssistant, client: Any, *, retry_s: float = RETRY_S) -> None:
        self._hass = hass
        self._client = client
        self._retry_s = retry_s
        self._done: OrderedDict[tuple[str, int], None] = OrderedDict()
        self._busy: set[tuple[str, int]] = set()
        self._tasks: set[asyncio.Future] = set()
        self._gate = asyncio.Semaphore(MAX_CONCURRENT)
        self._unsubscribe: Any = None
        self._log: deque[dict[str, Any]] = deque(maxlen=HISTORY)
        self._counts: Counter[str] = Counter()

    def async_start(self) -> None:
        """Start listening to the plugin's events (the coordinator passes every batch on)."""
        if self._unsubscribe is None:
            self._unsubscribe = async_dispatcher_connect(self._hass, SIGNAL_EVENTS, self._on_events)

    async def async_stop(self) -> None:
        """Stop listening and cancel every lookup still running, so no task outlives the integration."""
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._busy.clear()

    def diagnostics(self) -> dict[str, Any]:
        """What was asked of BirdNET-Go lately and how it went. Nothing secret: visit ids, detection numbers and plain notes."""
        return {
            "configured": True,
            "waiting": len(self._busy),
            "counts": {outcome: self._counts[outcome] for outcome in OUTCOMES},
            "recent": list(self._log),
        }

    # ---- what the coordinator's events trigger ---------------------------------------------------------------------------

    @callback
    def _on_events(self, events: list[dict[str, Any]]) -> None:
        for event in events:
            try:
                self._consider(event)
            except Exception:  # an odd event must never break the others (or the coordinator that sent them)
                _LOGGER.warning("Could not look at a visit for BirdNET-Go's models", exc_info=True)

    def _consider(self, event: Any) -> None:
        if not isinstance(event, dict) or event.get("type") not in ("visit_new", "visit_updated"):
            return
        data = event.get("data")
        visit = data.get("visit", data) if isinstance(data, dict) else None
        if not isinstance(visit, dict) or visit.get("kind") != "heard" or visit.get("status", "auto") != "auto":
            return  # a camera visit has no sound; a visit somebody already decided on no longer needs a tier
        identifier = visit_id(visit)
        audio = visit.get("audio")
        detection_id = detection_id_of(audio.get("birdnetDetectionId")) if isinstance(audio, dict) else None
        if identifier is None or detection_id is None:
            return
        key = (identifier, detection_id)
        if key in self._done or key in self._busy:
            return
        age = _age_s(visit)
        if age is not None and age > MAX_AGE_S:
            return
        if _agreed(visit):  # the plugin already knows
            self._remember(key)
            return
        self._busy.add(key)
        task = self._hass.async_create_background_task(self._look(identifier, detection_id), f"kestrel_birdnet_models_{identifier}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _look(self, identifier: str, detection_id: int) -> None:
        key = (identifier, detection_id)
        try:
            outcome, detail = await self._ask(identifier, detection_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.warning("BirdNET-Go models lookup for detection %s failed unexpectedly", detection_id, exc_info=True)
            outcome, detail = "failed", "unexpected error (see the log)"
        finally:
            self._busy.discard(key)
        if outcome != "failed":  # a failure is tried again on the visit's next event
            self._remember(key)
        else:
            _LOGGER.debug("BirdNET-Go models for detection %s: %s", detection_id, detail)
        self._record(identifier, detection_id, outcome, detail)

    async def _ask(self, identifier: str, detection_id: int) -> tuple[str, str]:
        contributions: list[dict[str, Any]] = []
        for attempt in (0, 1):
            try:
                async with self._gate:
                    detection = await birdnet_api.async_request(self._hass, "GET", f"/detections/{detection_id}")
            except KestrelApiError as err:
                if getattr(err, "status", None) == 404:
                    return "skipped", f"BirdNET-Go has no detection {detection_id}"
                return "failed", str(err)
            contributions = _contributions(detection)
            if contributions or attempt:
                break
            await asyncio.sleep(self._retry_s)
        if not contributions:
            return "no_models", "BirdNET-Go did not say which models heard it"
        try:
            async with self._gate:
                answer = await self._client.async_request(
                    "POST",
                    f"visits/{quote(identifier, safe='')}/models",
                    json={"detectionId": detection_id, "contributions": contributions},
                    timeout=15,
                )
        except KestrelApiError as err:
            if getattr(err, "status", None) == 404:
                return "skipped", "the plugin no longer has this visit"
            return "failed", str(err)
        result = answer.get("result") if isinstance(answer, dict) else None
        names = ", ".join(sorted({f"{item['modelName']} {item.get('modelVersion', '')}".strip() for item in contributions}))
        if result == "updated":
            return "recorded", f"models that heard it: {names}"
        if result == "unchanged":
            return "unchanged", f"models that heard it: {names} (the plugin already knew)"
        return "skipped", f"the plugin did not take it ({result or 'no answer'})"

    # ---- bookkeeping -----------------------------------------------------------------------------------------------------

    def _remember(self, key: tuple[str, int]) -> None:
        self._done[key] = None
        self._done.move_to_end(key)
        while len(self._done) > REMEMBERED:
            self._done.popitem(last=False)

    def _record(self, identifier: str, detection_id: int, outcome: str, detail: str) -> None:
        self._counts[outcome] += 1
        self._log.append(
            {
                "visitId": identifier,
                "detectionId": detection_id,
                "outcome": outcome,
                "detail": detail,
                "at": dt_util.utcnow().isoformat(),
            }
        )


def _contributions(detection: object) -> list[dict[str, Any]]:
    """The models BirdNET-Go says heard a detection, in the shape the plugin takes: a name, a version, how many hits and the best score."""
    items = detection.get("modelContributions") if isinstance(detection, dict) else None
    found: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return found
    for item in items:
        if not isinstance(item, dict):
            continue
        name, hits = item.get("modelName"), item.get("hitCount")
        if not isinstance(name, str) or not name.strip() or isinstance(hits, bool) or not isinstance(hits, (int, float)) or hits <= 0:
            continue
        entry: dict[str, Any] = {"modelName": name.strip()[:60], "hitCount": int(hits)}
        version = item.get("modelVersion")
        if isinstance(version, str) and version.strip():
            entry["modelVersion"] = version.strip()[:30]
        best = item.get("maxConfidence")
        if isinstance(best, (int, float)) and not isinstance(best, bool) and math.isfinite(best) and best >= 0:
            entry["maxConfidence"] = float(best)
        found.append(entry)
        if len(found) == MAX_CONTRIBUTIONS:
            break
    return found


def _agreed(visit: dict[str, Any]) -> bool:
    """True when the visit already lists two different models that named its species (nothing to look up)."""
    models, species = visit.get("models"), visit.get("species")
    if not isinstance(models, list) or not isinstance(species, str) or not species.strip():
        return False
    wanted = species.strip().lower()
    keys = {
        call.get("model")
        for call in models
        if isinstance(call, dict)
        and call.get("role") != "other"
        and call.get("model") not in (None, "", "other")
        and isinstance(call.get("species"), str)
        and call["species"].strip().lower() == wanted
    }
    return len(keys) >= 2


def _age_s(visit: dict[str, Any]) -> float | None:
    """Seconds since the visit started, or None when its start cannot be read."""
    started = visit.get("startedAt")
    if isinstance(started, bool):
        return None
    if isinstance(started, (int, float)):
        return time.time() - started / 1000
    if isinstance(started, str):
        try:
            parsed = datetime.fromisoformat(started)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - parsed).total_seconds()
    return None
