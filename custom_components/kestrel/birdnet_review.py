"""Telling BirdNET-Go about a correction: when a heard bird is confirmed or corrected in Kestrel, BirdNET-Go (the add-on
that made the detection) is told too, so its own review state agrees with what Nitin said.

    POST /api/v2/detections/<id>/review   {"verified": "correct" | "false_positive"}    (CSRF token)
    PUT  /api/v2/detections/<id>/species  {"scientificName": "<Genus species>"}         (CSRF token; also marks it correct)
    GET  /api/v2/detections/<id>          -> {"verified", "locked", "scientificName", ...}   (open)

What Kestrel does with a heard visit (a seen visit, or a detection announced with id 0, is ignored):

    confirm                      -> verdict "correct"
    correct, "Not an animal"     -> verdict "false_positive"
    correct, a real species      -> the detection's species is changed to it
    correct, "unknown"           -> nothing: BirdNET-Go has no "can't tell"
    undo                         -> takes back what was queued

This is best effort. BirdNET-Go being down, refusing, or not knowing the species must never block, slow down or undo the
correction in Kestrel, so every problem here is only logged and written to diagnostics -- never raised to the panel.

Why the write waits 11 seconds: Kestrel lets a person undo a confirm or correction for 10 seconds, and BirdNET-Go can
not clear a review once it is written (it refuses "unverified"). So nothing is sent until that window is over; a newer
action on the same visit replaces the waiting one (the last one wins), and an undo inside the window simply means
nothing is ever sent. If an undo still arrives after the write (within 5 minutes), the old verdict and species are put
back as far as BirdNET-Go allows; a detection that was unreviewed before stays reviewed, and diagnostics says so.

A kept recording (a locked detection) is never changed, and never unlocked to make it changeable: BirdNET-Go's lock is
what keeps its audio file safe from clean-up, and Kestrel does not touch it from here.

Only admins' actions are passed on (see review_hook): reviewing BirdNET-Go's detections is an admin job.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import birdnet_api
from .birdnet_availability import detection_id_of
from .client import KestrelApiError
from .const import DOMAIN
from .species_descriptions import scientific_name

_LOGGER = logging.getLogger(__name__)

UNDO_GRACE_S = 11  # Kestrel's undo lasts 10 seconds; one more so a last-moment undo still wins
REVERT_WINDOW_S = 300  # an undo this long after a write still puts BirdNET-Go back as far as it can
HISTORY = 30
OUTCOMES = ("sent", "skipped", "failed", "cancelled", "reverted")
_VERDICTS = ("correct", "false_positive")
KEPT_NOTE = "kept recording: BirdNET-Go does not allow changes"


def review_hook(hass: HomeAssistant, connection: Any, action: str, species: str | None = None) -> Callable[[Any], None] | None:
    """What the websocket handlers pass as `on_result`: it hands the plugin's answer to the service, for admins only.

    None (nothing to call) for a non-admin or when the service is not running."""
    if getattr(getattr(connection, "user", None), "is_admin", False) is not True:
        return None
    service = hass.data.get(DOMAIN, {}).get("birdnet_reviews")
    if service is None:
        return None
    return lambda visit: service.visit_action(action, visit, species)


@dataclass(slots=True)
class _Pending:
    """A write that is waiting out the undo window."""

    detection_id: int
    action: str
    verdict: str | None  # "correct" / "false_positive", or None when the species is what changes
    scientific: str | None
    task: asyncio.Future | None = None
    sending: bool = False


@dataclass(slots=True)
class _Sent:
    """What was written, and what BirdNET-Go had before, so an undo can put it back."""

    detection_id: int
    action: str
    verdict_now: str  # the verdict BirdNET-Go shows after the write
    scientific: str | None  # the species written, when it was a species change
    before_verdict: str | None
    before_scientific: str | None
    at: float


class BirdnetReviews:
    """Sends confirmations and corrections of heard visits to BirdNET-Go. One per config entry (`hass.data[DOMAIN]["birdnet_reviews"]`)."""

    def __init__(self, hass: HomeAssistant, grace_s: float = UNDO_GRACE_S) -> None:
        self._hass = hass
        self._grace_s = grace_s
        self._pending: dict[str, _Pending] = {}
        self._sent: dict[str, _Sent] = {}
        self._tasks: set[asyncio.Future] = set()
        self._log: deque[dict[str, Any]] = deque(maxlen=HISTORY)
        self._counts: Counter[str] = Counter()

    # ---- what the websocket handlers call ------------------------------------------------------------------------------

    def visit_action(self, action: str, visit: Any, species: str | None = None) -> None:
        """A confirm, correct or undo of `visit` (the plugin's raw answer) succeeded in Kestrel. Never raises, never waits."""
        try:
            self._visit_action(action, visit, species)
        except Exception:  # best effort: the correction in Kestrel is already done
            _LOGGER.warning("Could not queue the BirdNET-Go update", exc_info=True)

    def _visit_action(self, action: str, visit: Any, species: str | None) -> None:
        if not isinstance(visit, dict) or visit.get("kind") != "heard":
            return
        visit_id = visit.get("id")
        audio = visit.get("audio")
        detection_id = detection_id_of(audio.get("birdnetDetectionId")) if isinstance(audio, dict) else None
        if not isinstance(visit_id, str) or not visit_id or detection_id is None:
            return
        if action == "undo":
            self._undo(visit_id)
            return
        if action == "confirm":
            self._queue(visit_id, detection_id, "confirm", "correct", None)
            return
        name = species.strip() if isinstance(species, str) else ""
        if name == "not_animal":
            self._queue(visit_id, detection_id, "not_animal", "false_positive", None)
        elif name == "unknown":
            self._drop_pending(visit_id, "replaced by a newer action")
            self._record(visit_id, detection_id, "unknown", "skipped", "unknown has no BirdNET-Go equivalent")
        elif name:
            scientific = scientific_name(self._hass, name)
            if scientific is None:
                self._drop_pending(visit_id, "replaced by a newer action")
                self._record(visit_id, detection_id, f"species:{name}", "skipped", f"no scientific name for {name}")
            else:
                self._queue(visit_id, detection_id, f"species:{name}", None, scientific)

    async def async_stop(self) -> None:
        """Cancel every write that is still waiting, so no task outlives the integration."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._pending.clear()
        self._sent.clear()

    def diagnostics(self) -> dict[str, Any]:
        """What was sent to BirdNET-Go lately and how it went. Nothing secret: visit ids, detection numbers and plain notes."""
        return {
            "configured": True,
            "waiting": len(self._pending),
            "counts": {outcome: self._counts[outcome] for outcome in OUTCOMES},
            "recent": list(self._log),
        }

    # ---- queueing ------------------------------------------------------------------------------------------------------

    def _queue(self, visit_id: str, detection_id: int, action: str, verdict: str | None, scientific: str | None) -> None:
        self._drop_pending(visit_id, "replaced by a newer action")
        entry = _Pending(detection_id, action, verdict, scientific)
        self._pending[visit_id] = entry
        entry.task = self._spawn(self._send_later(visit_id, entry), f"kestrel_birdnet_review_{visit_id}")

    def _spawn(self, coro: Any, name: str) -> asyncio.Future:
        task = self._hass.async_create_background_task(coro, name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _drop_pending(self, visit_id: str, why: str) -> bool:
        """Cancel the write waiting for this visit, if there is one that has not started."""
        entry = self._pending.get(visit_id)
        if entry is None or entry.sending:
            return False
        del self._pending[visit_id]
        if entry.task is not None:
            entry.task.cancel()
        self._record(visit_id, entry.detection_id, entry.action, "cancelled", why)
        return True

    def _undo(self, visit_id: str) -> None:
        pending = self._pending.get(visit_id)
        if pending is not None:
            if self._drop_pending(visit_id, "undone before it was sent"):
                return
            # The write has just started; let it finish, then take it back.
            self._spawn(self._revert_after(visit_id, pending), f"kestrel_birdnet_revert_{visit_id}")
            return
        if visit_id in self._sent:
            self._spawn(self._revert(visit_id), f"kestrel_birdnet_revert_{visit_id}")

    # ---- the writes ----------------------------------------------------------------------------------------------------

    async def _send_later(self, visit_id: str, entry: _Pending) -> None:
        try:
            await asyncio.sleep(self._grace_s)
            entry.sending = True
            await self._send(visit_id, entry)
        finally:
            if self._pending.get(visit_id) is entry:
                del self._pending[visit_id]

    async def _send(self, visit_id: str, entry: _Pending) -> None:
        detection_id = entry.detection_id
        try:
            detection = await birdnet_api.async_request(self._hass, "GET", f"/detections/{detection_id}")
            if not isinstance(detection, dict):
                raise KestrelApiError("BirdNET-Go sent an answer Kestrel does not understand")
            if detection.get("locked") is True:
                self._record(visit_id, detection_id, entry.action, "skipped", KEPT_NOTE)
                return
            before = _Sent(
                detection_id=detection_id,
                action=entry.action,
                verdict_now="correct" if entry.scientific else str(entry.verdict),
                scientific=entry.scientific,
                before_verdict=_text(detection.get("verified")),
                before_scientific=_text(detection.get("scientificName")),
                at=time.monotonic(),
            )
            headers = await birdnet_api.async_write_headers(self._hass)
            if entry.scientific:
                await birdnet_api.async_request(
                    self._hass, "PUT", f"/detections/{detection_id}/species",
                    body={"scientificName": entry.scientific}, headers=headers,
                )
                detail = f"species changed to {entry.scientific}"
            else:
                await birdnet_api.async_request(
                    self._hass, "POST", f"/detections/{detection_id}/review",
                    body={"verified": entry.verdict}, headers=headers,
                )
                detail = f"marked {entry.verdict}"
        except KestrelApiError as err:
            self._refused(visit_id, detection_id, entry.action, err, species=entry.scientific is not None)
            return
        except Exception:
            _LOGGER.warning("BirdNET-Go update for detection %s failed unexpectedly", detection_id, exc_info=True)
            self._record(visit_id, detection_id, entry.action, "failed", "unexpected error (see the log)")
            return
        self._forget_old()
        self._sent[visit_id] = before
        self._record(visit_id, detection_id, entry.action, "sent", detail)

    async def _revert_after(self, visit_id: str, entry: _Pending) -> None:
        if entry.task is not None:
            await asyncio.wait([entry.task])
        await self._revert(visit_id)

    async def _revert(self, visit_id: str) -> None:
        """Put BirdNET-Go back as it was before the write, as far as it allows (it can not clear a review)."""
        sent = self._sent.pop(visit_id, None)
        if sent is None or time.monotonic() - sent.at > REVERT_WINDOW_S:
            return
        detection_id = sent.detection_id
        label = f"undo of {sent.action}"
        notes: list[str] = []
        restored = False
        try:
            headers: dict[str, str] | None = None
            verdict = sent.verdict_now
            if sent.scientific and sent.scientific != sent.before_scientific:
                if sent.before_scientific:
                    headers = await birdnet_api.async_write_headers(self._hass)
                    await birdnet_api.async_request(
                        self._hass, "PUT", f"/detections/{detection_id}/species",
                        body={"scientificName": sent.before_scientific}, headers=headers,
                    )
                    notes.append(f"species put back to {sent.before_scientific}")
                    restored = True
                    verdict = "correct"  # changing the species marks the detection correct
                else:
                    notes.append("the old species is not known, so it was left changed")
            if sent.before_verdict in _VERDICTS:
                if verdict != sent.before_verdict:
                    headers = headers or await birdnet_api.async_write_headers(self._hass)
                    await birdnet_api.async_request(
                        self._hass, "POST", f"/detections/{detection_id}/review",
                        body={"verified": sent.before_verdict}, headers=headers,
                    )
                    notes.append(f"verdict put back to {sent.before_verdict}")
                    restored = True
            elif verdict != "unverified":
                notes.append(f"BirdNET-Go cannot clear a review; left as {verdict}")
        except KestrelApiError as err:
            self._refused(visit_id, detection_id, label, err, species=False)
            return
        except Exception:
            _LOGGER.warning("BirdNET-Go undo for detection %s failed unexpectedly", detection_id, exc_info=True)
            self._record(visit_id, detection_id, label, "failed", "unexpected error (see the log)")
            return
        if not notes:
            notes.append("nothing to change: BirdNET-Go already showed what it showed before")
            restored = True
        self._record(visit_id, detection_id, label, "reverted" if restored else "skipped", "; ".join(notes))

    # ---- bookkeeping ---------------------------------------------------------------------------------------------------

    def _forget_old(self) -> None:
        """Drop the writes too old to take back, so the memory stays small."""
        now = time.monotonic()
        for visit_id in [key for key, sent in self._sent.items() if now - sent.at > REVERT_WINDOW_S]:
            del self._sent[visit_id]

    def _refused(self, visit_id: str, detection_id: int, action: str, err: KestrelApiError, *, species: bool) -> None:
        """BirdNET-Go said no, or could not be reached: remember why, log once, change nothing."""
        status = getattr(err, "status", None)
        if status == 409:
            # Locked (a kept recording); for a species change it can also mean BirdNET-Go's v2 database is off.
            detail = f"{KEPT_NOTE} (or its v2 database is not enabled)" if species else KEPT_NOTE
            self._record(visit_id, detection_id, action, "skipped", detail)
            return
        if status == 404:
            detail = f"BirdNET-Go has no detection {detection_id}"
        elif status == 400:
            detail = "BirdNET-Go refused it as invalid" + (" (unknown species?)" if species else "")
        else:
            detail = str(err)
        _LOGGER.warning("BirdNET-Go update for detection %s failed: %s", detection_id, detail)
        self._record(visit_id, detection_id, action, "failed", detail)

    def _record(self, visit_id: str, detection_id: int, action: str, outcome: str, detail: str) -> None:
        self._counts[outcome] += 1
        self._log.append(
            {
                "visitId": visit_id,
                "detectionId": detection_id,
                "action": action,
                "outcome": outcome,
                "detail": detail,
                "at": dt_util.utcnow().isoformat(),
            }
        )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
