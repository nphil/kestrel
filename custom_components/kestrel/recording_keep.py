"""Keeping a heard recording: BirdNET-Go's "lock" on its detection.

BirdNET-Go deletes a recording's audio file once it is older than its retention age (30 days here). Its
clean-up skips the file of every LOCKED detection (diskmanager, `isEligibleForAgeDeletion` and the usage policy
both ask for the set of locked clip names first), so "keep this recording" is exactly "lock this detection":

    GET  /api/v2/detections/<id>            -> {"locked": bool, "clipName": str | null, ...}   (open)
    POST /api/v2/detections/<id>/lock       {"locked": true | false}                           (CSRF token)

The POST answers 204; locking something already locked answers 409, unlocking is always accepted. A detection
with no clip name has nothing to keep, and a detection announced with id 0 has no database row of its own (see
birdnet_availability), so there is nothing to lock for it either -- those recordings are reported as not keepable.
"""

from __future__ import annotations

from typing import Any

from . import birdnet_api
from .birdnet_availability import detection_id_of, recording_id_of
from .client import KestrelApiError


def detection_id_for_visit(visit: object) -> int | None:
    """The BirdNET-Go detection whose recording a plugin visit plays, or None when it has no lockable one.

    A heard visit carries it in `audio`; a sighting that also has a call linked carries it in `heard`."""
    if not isinstance(visit, dict):
        return None
    for key in ("audio", "heard"):
        if (detection_id := recording_id_of(visit.get(key))) is not None:
            return detection_id
    return None


async def async_read(hass: Any, detection_id: int) -> dict[str, bool]:
    """Whether this detection's recording can be kept, and whether it is kept now."""
    if detection_id_of(detection_id) is None:
        return {"keepable": False, "kept": False}
    detection = await birdnet_api.async_request(hass, "GET", f"/detections/{detection_id}")
    locked = detection.get("locked") if isinstance(detection, dict) else None
    if not isinstance(locked, bool):
        raise KestrelApiError("BirdNET-Go sent an answer Kestrel does not understand")
    clip = detection.get("clipName")
    if not isinstance(clip, str) or not clip.strip():
        return {"keepable": False, "kept": False}
    return {"keepable": True, "kept": locked}


async def async_set(hass: Any, detection_id: int, keep: bool) -> dict[str, bool]:
    """Keep or release the recording, and return what BirdNET-Go says afterwards."""
    before = await async_read(hass, detection_id)
    if not before["keepable"]:
        raise KestrelApiError("BirdNET-Go has no recording to keep for this one", status=404)
    if before["kept"] == keep:
        return before
    headers = await birdnet_api.async_write_headers(hass)
    try:
        await birdnet_api.async_request(
            hass, "POST", f"/detections/{detection_id}/lock", body={"locked": keep}, headers=headers
        )
    except KestrelApiError as err:
        if not (keep and err.status == 409):  # 409: somebody locked it a moment ago, which is what was asked
            raise
    after = await async_read(hass, detection_id)
    if after["kept"] != keep:
        raise KestrelApiError("BirdNET-Go did not change this recording")
    return after
