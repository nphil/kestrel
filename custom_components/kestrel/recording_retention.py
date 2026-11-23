"""How long BirdNET-Go keeps its saved recordings, and how full the folder they live in is -- read and changed from Kestrel.

BirdNET-Go saves a short sound recording of every detection into its export folder (here a NAS share mounted at
/media/BirdCalls with a 30 GB quota). Its own clean-up looks at that folder every `checkInterval` minutes (15) and works by
ONE policy at a time, set in `realtime.audio.export.retention`:

    age     remove recordings older than `maxAge` ("60d"), however much room is left
    usage   remove the oldest recordings while the disk is fuller than `maxUsage` ("85%"), however old they are
    none    remove nothing

Whatever the policy, it skips every locked recording (see recording_keep.py) and leaves at least `minClips` of each species.
It reads the settings again at every pass, so a change needs no restart. It has no "age AND usage" policy and no "clean up now"
call, so Kestrel offers four choices, one policy each: 30, 60 or 90 days (`age`) or "until space runs low" (`usage`).

A time limit alone cannot stop a busy season filling the folder, and BirdNET-Go cannot combine the two policies, so
`async_guard` (run every GUARD_INTERVAL) switches a time limit to "until space runs low" once the folder is GUARD_PERCENT full,
and a time limit is not accepted while it is that full.

Changing it is a read-modify-write of the retention block through the settings API, with the CSRF token sent as for the
species filter (range_filter.py). The space is read where Home Assistant can see the folder (`os.statvfs`: the mount reports its
quota as its size) and from BirdNET-Go's own disk list when it cannot.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import timedelta
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.core import HomeAssistant

from . import birdnet_api
from .client import KestrelApiError

_LOGGER = logging.getLogger(__name__)

KEEP_DAYS = (30, 60, 90)
KEEP_SPACE = "space"
KEEP_CHOICES = ("30", "60", "90", KEEP_SPACE)
SPACE_PERCENT = 85  # "until space runs low": BirdNET-Go removes the oldest recordings once the folder is this full
GUARD_PERCENT = 90  # a time limit gives way to "until space runs low" once the folder is this full
GUARD_INTERVAL = timedelta(minutes=15)
GUARD_NOTIFICATION = "kestrel_recordings_space"

_AGE = re.compile(r"(\d+)([hdwmy]?)")
_HOURS_PER_UNIT = {"": 1, "h": 1, "d": 24, "w": 24 * 7, "m": 24 * 30, "y": 24 * 365}  # BirdNET-Go's ParseRetentionPeriod
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%?")


def _days(max_age: object) -> int | None:
    """BirdNET-Go's `maxAge` ("60d", "2w", a bare number of hours) in whole days; None when it is not a whole number of days."""
    match = _AGE.fullmatch(max_age.strip()) if isinstance(max_age, str) else None
    if match is None:
        return None
    hours = int(match[1]) * _HOURS_PER_UNIT[match[2]]
    return hours // 24 if hours > 0 and hours % 24 == 0 else None


def _percent(max_usage: object) -> int | None:
    """BirdNET-Go's `maxUsage` ("85%") as a whole percent. Like BirdNET-Go, a bare 0.8 means 80%."""
    match = _PERCENT.fullmatch(max_usage.strip()) if isinstance(max_usage, str) else None
    if match is None:
        return None
    value = float(match[1])
    if 0 < value < 1:
        value *= 100
    return round(value) if 0 < value <= 100 else None


def _keep_of(retention: dict[str, Any]) -> str:
    """Which of Kestrel's choices a retention block amounts to; "off" when nothing is removed, "other" for anything else."""
    policy = retention.get("policy")
    if policy == "usage":
        return KEEP_SPACE
    if policy == "age":
        days = _days(retention.get("maxAge"))
        return str(days) if days in KEEP_DAYS else "other"
    return "off" if policy in ("none", "", None) else "other"


def _statvfs(path: str) -> tuple[int, int] | None:
    """(bytes used, bytes in total) of the disk holding `path`, None when it cannot be read. Blocking: run it in the executor."""
    try:
        stats = os.statvfs(path)
    except OSError:
        return None
    total = stats.f_blocks * stats.f_frsize
    return ((stats.f_blocks - stats.f_bfree) * stats.f_frsize, total) if total > 0 else None


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


async def _async_birdnet_disk(hass: HomeAssistant, path: str) -> tuple[int, int] | None:
    """The same numbers from BirdNET-Go's disk list: the disk with the longest mount point that `path` is inside."""
    try:
        disks = await birdnet_api.async_request(hass, "GET", "/system/disks")
    except KestrelApiError:
        return None
    inside = path.rstrip("/") + "/"
    best: tuple[int, int, int] | None = None
    for disk in disks if isinstance(disks, list) else ():
        mount = disk.get("mountpoint") if isinstance(disk, dict) else None
        if not isinstance(mount, str) or not _is_count(disk.get("used")) or not _is_count(disk.get("total")) or not disk["total"]:
            continue
        mount = mount.rstrip("/")
        if inside.startswith(f"{mount}/") and (best is None or len(mount) > best[0]):
            best = (len(mount), disk["used"], disk["total"])
    return None if best is None else (best[1], best[2])


async def _async_storage(hass: HomeAssistant, path: object) -> dict[str, int] | None:
    """Space used and in total where recordings are saved; None when neither Home Assistant nor BirdNET-Go can say."""
    if not isinstance(path, str) or not path.startswith("/"):
        return None
    found = await hass.async_add_executor_job(_statvfs, path) or await _async_birdnet_disk(hass, path)
    return None if found is None else {"usedBytes": found[0], "totalBytes": found[1]}


def _full(storage: dict[str, int] | None) -> float | None:
    """How full the folder is, in percent."""
    return None if storage is None else 100 * storage["usedBytes"] / storage["totalBytes"]


async def _async_kept(hass: HomeAssistant) -> int | None:
    """How many recordings are locked ("kept"), which no clean-up removes. BirdNET-Go counts them for the detections list."""
    try:
        page = await birdnet_api.async_request(hass, "GET", "/detections?numResults=1&locked=true")
    except KestrelApiError:
        return None
    total = page.get("total") if isinstance(page, dict) else None
    return total if _is_count(total) else None


async def _async_export(hass: HomeAssistant) -> dict[str, Any]:
    """BirdNET-Go's export settings: the folder recordings are saved in (`path`) and how they are cleaned up (`retention`)."""
    section = await birdnet_api.async_request(hass, "GET", "/settings/audio")
    export = section.get("export") if isinstance(section, dict) else None
    if not isinstance(export, dict) or not isinstance(export.get("retention"), dict):
        raise KestrelApiError("BirdNET-Go sent an answer Kestrel does not understand")
    return export


async def _async_state(hass: HomeAssistant, export: dict[str, Any]) -> dict[str, Any]:
    """What the settings sheet shows: how recordings are kept, how full their storage is, and how many are kept.

    `days` is the age BirdNET-Go goes by, or would if it went by age."""
    retention = export["retention"]
    policy = retention.get("policy")
    minimum, interval = retention.get("minClips"), retention.get("checkInterval")
    return {
        "keep": _keep_of(retention),
        "days": _days(retention.get("maxAge")),
        "spacePercent": (_percent(retention.get("maxUsage")) if policy == "usage" else None) or SPACE_PERCENT,
        "guardPercent": GUARD_PERCENT,
        "storage": await _async_storage(hass, export.get("path")),
        "kept": await _async_kept(hass),
        "minClips": minimum if _is_count(minimum) else None,
        "checkMinutes": interval if _is_count(interval) and interval > 0 else None,
    }


async def async_read(hass: HomeAssistant) -> dict[str, Any]:
    """How recordings are kept now, how full their folder is, and how many are kept for good."""
    return await _async_state(hass, await _async_export(hass))


async def _async_apply(hass: HomeAssistant, export: dict[str, Any], keep: str) -> dict[str, Any]:
    """Make BirdNET-Go keep recordings as `keep` says, leaving every other clean-up setting as it was. Returns the export settings it now has."""
    changes = (
        {"policy": "usage", "maxUsage": f"{SPACE_PERCENT}%"} if keep == KEEP_SPACE else {"policy": "age", "maxAge": f"{keep}d"}
    )
    await birdnet_api.async_request(
        hass,
        "PATCH",
        "/settings/audio",
        body={"export": {"retention": {**export["retention"], **changes}}},
        headers=await birdnet_api.async_write_headers(hass),
    )
    after = await _async_export(hass)
    if _keep_of(after["retention"]) != keep:
        raise KestrelApiError("BirdNET-Go did not keep the change")
    return after


async def async_set_keep(hass: HomeAssistant, keep: object) -> dict[str, Any]:
    """Change how long recordings are kept ("30", "60", "90" days or "space") and return the new state."""
    if not isinstance(keep, str) or keep not in KEEP_CHOICES:
        raise ValueError("Choose 30, 60 or 90 days, or until space runs low")
    export = await _async_export(hass)
    if _keep_of(export["retention"]) == keep:
        return await _async_state(hass, export)  # BirdNET-Go has nothing to change
    if keep != KEEP_SPACE:
        full = _full(await _async_storage(hass, export.get("path")))
        if full is not None and full >= GUARD_PERCENT:
            raise ValueError(
                f"The recording storage is {int(full)}% full, so a time limit can't be set right now. "
                "Choose Until space runs low first, then a time limit once there is room"
            )
    return await _async_state(hass, await _async_apply(hass, export, keep))


async def async_guard(hass: HomeAssistant) -> bool:
    """Switch a time limit to "until space runs low" once the folder is GUARD_PERCENT full, and say so. True when it switched.

    Never raises for BirdNET-Go being away: it simply looks again next time."""
    try:
        export = await _async_export(hass)
        if export["retention"].get("policy") != "age":
            return False
        full = _full(await _async_storage(hass, export.get("path")))
    except KestrelApiError as err:
        _LOGGER.debug("Kestrel could not check the recordings folder: %s", err)
        return False
    if full is None or full < GUARD_PERCENT:
        return False
    try:
        await _async_apply(hass, export, KEEP_SPACE)
    except KestrelApiError as err:
        _LOGGER.warning("The recordings folder is %d%% full but Kestrel could not change BirdNET-Go's clean-up: %s", full, err)
        return False
    _LOGGER.warning("The recordings folder is %d%% full: BirdNET-Go now removes the oldest recordings first", full)
    persistent_notification.async_create(
        hass,
        f"The storage BirdNET-Go saves bird recordings in is {int(full)}% full, so Kestrel changed how long it keeps them to "
        f"Until space runs low: the oldest recordings are now removed first, until it is below {SPACE_PERCENT}% again. "
        "Recordings you keep are never removed. Once there is room, you can choose a time limit again "
        "in Kestrel's Settings, under Bird recordings.",
        title="Kestrel: bird recording storage is nearly full",
        notification_id=GUARD_NOTIFICATION,
    )
    return True
