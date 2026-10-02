"""Bird-call previews through the optional kestrel-audio service.

BirdNET-Go keeps a 15 s recording for every detection. The kestrel-audio service finds the
moment the model matched, makes it loud and, where a re-check proves it helps, cleans it up.
This module is Home Assistant's side of that: it hands each heard recording to the service,
remembers which previews are ready so payloads can point at them, tells open dashboards when
one lands, deletes the preview of a deleted visit, and backfills the last 30 days.

Nothing here is required. With no service configured, or while it is down, payloads simply
carry BirdNET-Go's original recording, exactly as before.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send

from .announced import new_visit_from_event
from .birdnet_availability import detection_id_of
from .client import KestrelApiError
from .const import AUDIO_KEY_HEADER, BIRDNET_GO_INTERNAL_URL, DEFAULT_AUDIO_BACKFILL_DAYS, DOMAIN, SIGNAL_EVENTS

_LOGGER = logging.getLogger(__name__)

_QUICK = aiohttp.ClientTimeout(total=5)
_UPLOAD = aiohttp.ClientTimeout(total=30)
_MAX_JSON_BYTES = 256 * 1024  # the service's answers are tiny; anything bigger is not one of them
_MAX_ORIGINAL_BYTES = 8 * 1024 * 1024  # the service accepts 20 MiB; a 15 s clip is ~100 KB
# BirdNET-Go can finish writing a clip a little after it announces the detection.
_ORIGINAL_RETRY_DELAYS = (5, 15, 45, 120)
_TRACK_INTERVAL = 4.0  # a job takes ~2-4 s on the GPU, ~10-25 s on the CPU fallback
_TRACK_BATCH = 10
_PENDING_GIVE_UP = 1800.0
_PUSH_WINDOW_MS = 6 * 3600 * 1000  # only tell dashboards about recent visits
_HEALTH_INTERVAL = 30.0
_BACKFILL_PAGE = 50
_BACKFILL_QUEUE_LIMIT = 5  # service queue depth (waiting + running) the backfill may reach
_BACKFILL_WAIT = 15.0
_BACKFILL_PACE = 0.5  # pause after each recording sent
_BACKFILL_KNOWN_PACE = 0.02  # pause after skipping a call the service already has
_BACKFILL_START_DELAY = 20.0  # let startup, and the BirdNET species-name lookup, settle first
_BACKFILL_RESCAN = 6 * 3600.0
_PREFETCH_LIMIT = 100
_PREFETCH_TIMEOUT = 2.5
_MAX_TRACKED = 20_000
# How long a verdict other than "ready" is trusted before it is checked again.
_TTL_SECONDS = {"pending": 600.0, "failed": 600.0, "none": 60.0}

_MISSING = "missing"  # BirdNET-Go says it never saved the recording
_UNAVAILABLE = "unavailable"  # BirdNET-Go could not be asked, or sent something unusable


class AudioServiceError(Exception):
    """The audio service could not be reached or refused the request."""


@dataclass(frozen=True, slots=True)
class PreviewInfo:
    """What the service says about one detection's preview."""

    state: str  # "pending" | "ready" | "failed" | "none" (the service has no job for it)
    segment: dict[str, float] | None = None
    cleaned: bool = False
    method: str | None = None
    checked_at: float = field(default_factory=time.monotonic, compare=False)

    def as_payload(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "segment": self.segment,
            "cleaned": self.cleaned,
            "method": self.method,
        }


@dataclass(slots=True)
class _Pending:
    visit_id: str
    started_at: int | None
    since: float


@dataclass(slots=True)
class _Backfill:
    state: str = "idle"  # idle | running | waiting | done
    scanned: int = 0
    submitted: int = 0
    already_known: int = 0
    no_original: int = 0


@dataclass(frozen=True, slots=True)
class _Original:
    body: bytes
    content_type: str


def _visit_detection_id(visit: dict[str, Any]) -> int | None:
    audio = visit.get("audio")
    return detection_id_of(audio.get("birdnetDetectionId")) if isinstance(audio, dict) else None


def detection_ids(value: Any, found: list[int] | None = None) -> list[int]:
    """Detection ids of every call a payload mentions (heard `audio` and a seen visit's `heard`)."""
    found = [] if found is None else found
    if isinstance(value, list):
        for item in value:
            detection_ids(item, found)
    elif isinstance(value, dict):
        for key in ("audio", "heard"):
            part = value.get(key)
            if isinstance(part, dict) and (identifier := detection_id_of(part.get("birdnetDetectionId"))) is not None:
                found.append(identifier)
        for item in value.values():
            if isinstance(item, (list, dict)):
                detection_ids(item, found)
    return found


def _parse_info(data: Any) -> PreviewInfo | None:
    """Read the service's /info answer; anything unexpected is treated as unknown."""
    if not isinstance(data, dict) or data.get("state") not in ("pending", "ready", "failed"):
        return None
    state = data["state"]
    if state != "ready":
        return PreviewInfo(state)
    segment = data.get("segment")
    if (
        isinstance(segment, dict)
        and isinstance(segment.get("start"), (int, float))
        and isinstance(segment.get("end"), (int, float))
    ):
        segment = {"start": float(segment["start"]), "end": float(segment["end"])}
    else:
        segment = None
    method = data.get("method")
    return PreviewInfo(
        "ready",
        segment=segment,
        cleaned=bool(data.get("cleaned")),
        method=method if isinstance(method, str) else None,
    )


async def _read_limited(response: Any, limit: int) -> bytes | None:
    """Read a response body, giving up (None) as soon as it turns out to be bigger than `limit`."""
    declared = response.headers.get("Content-Length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.content.iter_chunked(16 * 1024):
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _bounded_insert(store: OrderedDict[Any, Any], key: Any, value: Any = None) -> None:
    store[key] = value
    store.move_to_end(key)
    while len(store) > _MAX_TRACKED:
        store.popitem(last=False)


class AudioPreviews:
    """Home Assistant's connection to the kestrel-audio service (a no-op when not configured)."""

    def __init__(
        self,
        hass: HomeAssistant,
        url: str | None,
        key: str | None,
        backfill_days: int = DEFAULT_AUDIO_BACKFILL_DAYS,
    ) -> None:
        self._hass = hass
        self._url = (url or "").strip().rstrip("/")
        self._key = (key or "").strip()
        self._backfill_days = max(0, int(backfill_days))
        self._cache: OrderedDict[int, PreviewInfo] = OrderedDict()
        self._detection_by_visit: OrderedDict[str, int] = OrderedDict()
        self._deleted: OrderedDict[str, None] = OrderedDict()
        self._submitted: OrderedDict[int, None] = OrderedDict()  # in flight, or sent successfully
        self._no_original: OrderedDict[int, None] = OrderedDict()
        self._pending: dict[int, _Pending] = {}
        self._submit_tasks: dict[int, asyncio.Task[Any]] = {}
        self._reachable: bool | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._unsubscribe: Callable[[], None] | None = None
        self._wake = asyncio.Event()
        self._rescan = asyncio.Event()
        self._live_inflight = 0
        self._backfill = _Backfill()

    # --- configuration -----------------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return bool(self._key and self._url.startswith(("http://", "https://")))

    @property
    def headers(self) -> dict[str, str]:
        return {AUDIO_KEY_HEADER: self._key}

    def preview_url(self, detection_id: int | str) -> str:
        return f"{self._url}/v1/previews/{int(detection_id)}"

    # --- lifecycle ---------------------------------------------------------------------------

    @callback
    def async_start(self) -> None:
        """Start listening for heard visits and run the background jobs."""
        if not self.enabled or self._unsubscribe is not None:
            return
        self._unsubscribe = async_dispatcher_connect(self._hass, SIGNAL_EVENTS, self._on_events)
        self._spawn(self._track_loop(), "kestrel audio tracker")
        self._spawn(self._health_loop(), "kestrel audio health")
        if self._backfill_days > 0:
            self._spawn(self._backfill_loop(), "kestrel audio backfill")
        else:
            self._backfill.state = "off"

    async def async_stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._submit_tasks.clear()

    def _spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> asyncio.Task[Any]:
        task = self._hass.async_create_background_task(coro, name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # --- talking to the service --------------------------------------------------------------

    def _mark_reachable(self) -> None:
        if self._reachable is False:
            _LOGGER.info("Kestrel audio service is reachable again; bird-call previews resume")
            self._rescan.set()
        self._reachable = True

    def _mark_unreachable(self, reason: object) -> None:
        if self._reachable is not False:
            _LOGGER.warning(
                "Kestrel audio service is not usable (%s); playing the original bird-call "
                "recordings until it is",
                reason,
            )
        self._reachable = False

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: aiohttp.ClientTimeout = _QUICK,
    ) -> tuple[int, Any]:
        """One call to the service: (status, parsed JSON or None). Raises when it is unusable."""
        session = async_get_clientsession(self._hass)
        try:
            async with session.request(
                method,
                f"{self._url}{path}",
                params=params,
                data=data,
                headers={**self.headers, **(headers or {})},
                timeout=timeout,
                allow_redirects=False,
            ) as response:
                payload = None
                if response.status in (200, 202):
                    raw = await _read_limited(response, _MAX_JSON_BYTES)
                    if raw is not None:
                        try:
                            payload = json.loads(raw)
                        except ValueError:
                            payload = None
                status = response.status
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            self._mark_unreachable(err)
            raise AudioServiceError(str(err)) from err
        if status in (401, 403):
            self._mark_unreachable("the service rejected the key")
            raise AudioServiceError("the service rejected the key")
        if status >= 500:
            self._mark_unreachable(f"HTTP {status}")
            raise AudioServiceError(f"HTTP {status}")
        self._mark_reachable()
        return status, payload

    async def _fetch_info(self, detection_id: int) -> PreviewInfo | None:
        status, data = await self._request("GET", f"/v1/previews/{detection_id}/info")
        if status == 404:
            info: PreviewInfo | None = PreviewInfo("none")
        elif status == 200:
            info = _parse_info(data)
        else:
            info = None
        if info is not None:
            _bounded_insert(self._cache, detection_id, info)
        return info

    def _fresh(self, detection_id: int) -> PreviewInfo | None:
        info = self._cache.get(detection_id)
        if info is None:
            return None
        ttl = _TTL_SECONDS.get(info.state)
        if ttl is not None and time.monotonic() - info.checked_at > ttl:
            return None
        return info

    # --- what payloads say about a call ------------------------------------------------------

    def fields(self, detection_id: int) -> PreviewInfo | None:
        """The cached verdict for a call, or None when there is nothing to add to a payload."""
        if not self.enabled or self._reachable is False:
            return None
        info = self._fresh(detection_id)
        return None if info is None or info.state == "none" else info

    def note_visit(self, visit_id: object, detection_id: int) -> None:
        """Remember which visit a call belongs to, so a deleted visit can clean up its preview."""
        if self.enabled and isinstance(visit_id, str) and visit_id:
            _bounded_insert(self._detection_by_visit, visit_id, detection_id)

    def track(self, detection_id: int, visit_id: object, started_at: object) -> None:
        """Watch a pending job so open dashboards are told when its preview is ready."""
        if detection_id in self._pending or not isinstance(visit_id, str) or not visit_id:
            return
        started = started_at if isinstance(started_at, int) and not isinstance(started_at, bool) else None
        self._pending[detection_id] = _Pending(visit_id, started, time.monotonic())
        self._wake.set()

    async def async_prefetch(self, payload: Any) -> None:
        """Look up, once and in parallel, every call in a payload the cache does not know yet."""
        if not self.enabled or self._reachable is False:
            return
        wanted = [d for d in dict.fromkeys(detection_ids(payload)) if self._fresh(d) is None]
        if not wanted:
            return
        semaphore = asyncio.Semaphore(8)

        async def look_up(detection_id: int) -> None:
            async with semaphore:
                try:
                    await self._fetch_info(detection_id)
                except AudioServiceError:
                    pass

        try:
            await asyncio.wait_for(
                asyncio.gather(*(look_up(d) for d in wanted[:_PREFETCH_LIMIT])), _PREFETCH_TIMEOUT
            )
        except TimeoutError:
            # A lookup that should take milliseconds stalled: stop waiting on the service for
            # every request until the health check sees it answer again.
            self._mark_unreachable("lookups timed out")

    # --- sending recordings ------------------------------------------------------------------

    @callback
    def _on_events(self, events: list[dict[str, Any]]) -> None:
        for event in events:
            kind = event.get("type")
            if kind == "visit_new":
                visit = new_visit_from_event(event)
                if visit is None or str(visit.get("kind", "")).lower() != "heard":
                    continue
                detection_id = _visit_detection_id(visit)
                if detection_id is None or detection_id in self._submit_tasks:
                    continue
                task = self._spawn(self._submit_live(visit), "kestrel audio submit")
                self._submit_tasks[detection_id] = task
                task.add_done_callback(lambda _task, d=detection_id: self._submit_tasks.pop(d, None))
            elif kind == "visit_deleted":
                data = event.get("data")
                identifier = data.get("id") if isinstance(data, dict) else None
                if isinstance(identifier, str) and identifier:
                    self._spawn(self._delete_for_visit(identifier), "kestrel audio delete")

    async def _submit_live(self, visit: dict[str, Any]) -> None:
        detection_id = _visit_detection_id(visit)
        if detection_id is None or detection_id in self._submitted:
            return
        self.note_visit(visit.get("id"), detection_id)
        _bounded_insert(self._submitted, detection_id)
        self._live_inflight += 1
        sent = False
        try:
            outcome = "unavailable"
            for delay in (0, *_ORIGINAL_RETRY_DELAYS):
                if delay:
                    await asyncio.sleep(delay)
                outcome = await self._submit(visit, detection_id)
                if outcome not in ("no_original", "unavailable"):
                    sent = outcome == "sent"
                    return
            if outcome == "no_original":
                _bounded_insert(self._no_original, detection_id)
        finally:
            self._live_inflight -= 1
            if not sent:
                self._submitted.pop(detection_id, None)  # let the backfill try again later

    async def _fetch_original(self, detection_id: int) -> _Original | str:
        """BirdNET-Go's recording, or _MISSING (never saved) / _UNAVAILABLE (try again later)."""
        session = async_get_clientsession(self._hass)
        try:
            async with session.request(
                "GET",
                f"{BIRDNET_GO_INTERNAL_URL}/api/v2/audio/{detection_id}",
                timeout=_UPLOAD,
                allow_redirects=False,
            ) as response:
                if response.status == 404:
                    return _MISSING
                if response.status != 200:
                    return _UNAVAILABLE
                body = await _read_limited(response, _MAX_ORIGINAL_BYTES)
                content_type = response.headers.get("Content-Type") or ""
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
            _LOGGER.debug("Could not fetch BirdNET-Go recording %s: %s", detection_id, err)
            return _UNAVAILABLE
        if body is None:
            return _MISSING  # absurdly large: not a bird-call clip, do not keep asking
        if not body:
            return _UNAVAILABLE
        return _Original(body, content_type if content_type.startswith("audio/") else "audio/ogg")

    async def _submit(self, visit: dict[str, Any], detection_id: int, *, low_priority: bool = False) -> str:
        """Send one recording to the service.

        Returns 'sent', 'no_original' (BirdNET-Go never saved it), 'unavailable' (BirdNET-Go
        could not be asked), 'unreachable' (the audio service is down) or 'rejected'.
        """
        visit_id = visit.get("id")
        if not self.enabled or visit_id in self._deleted:
            return "rejected"
        original = await self._fetch_original(detection_id)
        if original == _MISSING:
            return "no_original"
        if not isinstance(original, _Original):
            return "unavailable"
        if visit_id in self._deleted:  # the visit was deleted while its recording downloaded
            return "rejected"
        species = visit.get("species")
        params: dict[str, Any] = {"detection_id": detection_id, "species": species if isinstance(species, str) else ""}
        names = self._hass.data.get(DOMAIN, {}).get("birdnet_species_map", {})
        scientific = names.get(species.strip().lower()) if isinstance(species, str) else None
        if scientific:
            params["scientific"] = scientific
        camera = visit.get("camera")
        camera_name = camera.get("name") if isinstance(camera, dict) else None
        if isinstance(camera_name, str) and camera_name:
            params["camera"] = camera_name
        if low_priority:  # back-filling old calls must never delay a call that has just been heard
            params["priority"] = "low"
        try:
            status, data = await self._request(
                "POST",
                "/v1/jobs",
                params=params,
                data=original.body,
                headers={"Content-Type": original.content_type},
                timeout=_UPLOAD,
            )
        except AudioServiceError:
            return "unreachable"
        if status not in (200, 202):
            _LOGGER.debug("Kestrel audio service refused job %s: HTTP %s", detection_id, status)
            return "rejected"
        state = data.get("state") if isinstance(data, dict) else None
        if state in ("ready", "failed"):
            try:
                await self._fetch_info(detection_id)
            except AudioServiceError:
                pass
            return "sent"
        _bounded_insert(self._cache, detection_id, PreviewInfo("pending"))
        self.track(detection_id, visit_id, visit.get("startedAt"))
        return "sent"

    # --- telling dashboards when a preview lands ---------------------------------------------

    async def _track_loop(self) -> None:
        while True:
            if not self._pending:
                self._wake.clear()
                await self._wake.wait()
            await asyncio.sleep(_TRACK_INTERVAL)
            await self._track_once()

    async def _track_once(self) -> None:
        """One round of asking the service whether the previews we are waiting for are done."""
        for detection_id in list(self._pending)[:_TRACK_BATCH]:
            pending = self._pending.get(detection_id)
            if pending is None:
                continue
            if time.monotonic() - pending.since > _PENDING_GIVE_UP:
                self._pending.pop(detection_id, None)
                continue
            try:
                info = await self._fetch_info(detection_id)
            except AudioServiceError:
                return  # the service is down; try again next round
            if info is None or info.state == "pending":
                # Still waiting: go to the back of the queue so every job gets its turn.
                self._pending[detection_id] = self._pending.pop(detection_id, pending)
                continue
            self._pending.pop(detection_id, None)
            if info.state == "ready":
                await self._push_update(pending)

    async def _push_update(self, pending: _Pending) -> None:
        """Send open dashboards a fresh copy of the visit so they can swap in the preview."""
        if pending.started_at is not None and time.time() * 1000 - pending.started_at > _PUSH_WINDOW_MS:
            return
        coordinator = self._hass.data.get(DOMAIN, {}).get("coordinator")
        if coordinator is None:
            return
        try:
            visit = await coordinator.client.async_request(
                "GET", f"visits/{quote(pending.visit_id, safe='')}"
            )
        except KestrelApiError:
            return
        if isinstance(visit, dict):
            async_dispatcher_send(self._hass, SIGNAL_EVENTS, [{"type": "visit_updated", "data": visit}])

    # --- deleted visits ----------------------------------------------------------------------

    async def _delete_for_visit(self, visit_id: str) -> None:
        _bounded_insert(self._deleted, visit_id)
        detection_id = self._detection_by_visit.pop(visit_id, None)
        if detection_id is None:
            return
        # An upload still in flight would recreate the preview after we delete it: stop it first.
        task = self._submit_tasks.pop(detection_id, None)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._cache.pop(detection_id, None)
        self._pending.pop(detection_id, None)
        self._submitted.pop(detection_id, None)
        try:
            await self._request("DELETE", f"/v1/previews/{detection_id}")
        except AudioServiceError:
            pass

    # --- health and backfill -----------------------------------------------------------------

    async def _health_loop(self) -> None:
        """While the service is down, notice when it comes back (which also triggers a rescan)."""
        while True:
            await asyncio.sleep(_HEALTH_INTERVAL)
            if self._reachable is False:
                try:
                    await self._request("GET", "/v1/stats")
                except AudioServiceError:
                    pass

    async def _backfill_loop(self) -> None:
        await asyncio.sleep(_BACKFILL_START_DELAY)
        while True:
            await self._wait_until_reachable()
            self._rescan.clear()
            try:
                await self._backfill_once()
            except AudioServiceError:
                self._backfill.state = "waiting"
                await asyncio.sleep(_HEALTH_INTERVAL)
                continue
            try:
                await asyncio.wait_for(self._rescan.wait(), _BACKFILL_RESCAN)
            except TimeoutError:
                pass

    async def _wait_until_reachable(self) -> None:
        """Wait for an authenticated answer: /healthz is open, so it cannot prove the key works."""
        while True:
            try:
                status, _ = await self._request("GET", "/v1/stats")
                if status == 200:
                    return
            except AudioServiceError:
                pass
            self._backfill.state = "waiting"
            await asyncio.sleep(_HEALTH_INTERVAL)

    async def _backfill_once(self) -> None:
        """Give every heard visit of the last `backfill_days` days a preview, newest first and gently."""
        self._backfill = _Backfill(state="running")
        cutoff = (time.time() - self._backfill_days * 86400) * 1000
        before: int | float | None = None
        while True:
            coordinator = self._hass.data.get(DOMAIN, {}).get("coordinator")
            if coordinator is None:
                await asyncio.sleep(10)
                continue
            params: dict[str, Any] = {"kind": "heard", "limit": _BACKFILL_PAGE}
            if before is not None:
                params["before"] = before
            try:
                page = await coordinator.client.async_request("GET", "visits", params=params)
            except KestrelApiError as err:
                _LOGGER.debug("Audio backfill could not list visits: %s", err)
                await asyncio.sleep(30)
                continue
            items = page.get("items") if isinstance(page, dict) else None
            if not isinstance(items, list) or not items:
                break
            for visit in items:
                started = visit.get("startedAt") if isinstance(visit, dict) else None
                if isinstance(started, (int, float)) and started < cutoff:
                    self._backfill.state = "done"
                    return
                if isinstance(visit, dict):
                    await self._backfill_visit(visit)
            before = page.get("next")
            if before is None:
                break
        self._backfill.state = "done"

    async def _backfill_visit(self, visit: dict[str, Any]) -> None:
        detection_id = _visit_detection_id(visit)
        if detection_id is None:
            return
        self._backfill.scanned += 1
        self.note_visit(visit.get("id"), detection_id)
        info = self._fresh(detection_id)
        if info is None:
            info = await self._fetch_info(detection_id)
        if info is not None and info.state != "none":
            self._backfill.already_known += 1
            if info.state == "pending":
                self.track(detection_id, visit.get("id"), visit.get("startedAt"))
            await asyncio.sleep(_BACKFILL_KNOWN_PACE)
            return
        if detection_id in self._no_original or detection_id in self._submitted:
            return
        await self._wait_for_room()
        _bounded_insert(self._submitted, detection_id)
        outcome = "unreachable"
        try:
            outcome = await self._submit(visit, detection_id, low_priority=True)
        finally:
            if outcome != "sent":
                self._submitted.pop(detection_id, None)
        if outcome == "unreachable":
            raise AudioServiceError("the service went away during the backfill")
        if outcome == "no_original":
            _bounded_insert(self._no_original, detection_id)
            self._backfill.no_original += 1
        elif outcome == "sent":
            self._backfill.submitted += 1
        # "unavailable" (a BirdNET-Go hiccup) is simply left for the next pass.
        await asyncio.sleep(_BACKFILL_PACE)

    async def _wait_for_room(self) -> None:
        """Hold back while live recordings are being sent or the service queue is busy."""
        while True:
            if self._live_inflight:
                await asyncio.sleep(1.0)
                continue
            depth = await self._queue_depth()
            if depth is None or depth <= _BACKFILL_QUEUE_LIMIT:
                self._backfill.state = "running"
                return
            self._backfill.state = "waiting"
            await asyncio.sleep(_BACKFILL_WAIT)

    async def _queue_depth(self) -> int | None:
        status, stats = await self._request("GET", "/v1/stats")
        queue = stats.get("queue") if status == 200 and isinstance(stats, dict) else None
        depth = queue.get("depth") if isinstance(queue, dict) else None
        return depth if isinstance(depth, int) and not isinstance(depth, bool) else None

    # --- diagnostics -------------------------------------------------------------------------

    async def async_diagnostics(self) -> dict[str, Any]:
        stats: Any = None
        if self.enabled:
            try:
                status, body = await self._request("GET", "/v1/stats")
                stats = body if status == 200 else {"http_status": status}
            except AudioServiceError as err:
                stats = {"error": str(err)}
        counts: dict[str, int] = {}
        for info in self._cache.values():
            counts[info.state] = counts.get(info.state, 0) + 1
        result: dict[str, Any] = {
            "configured": self.enabled,
            "url": self._url or None,
            "reachable": self._reachable,
            "known_previews": counts,
            "waiting_for_service": len(self._pending),
            "backfill_days": self._backfill_days,
            "backfill": dataclasses.asdict(self._backfill),
        }
        if stats is not None:
            result["stats"] = stats
        return result
