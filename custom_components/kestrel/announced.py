"""Remember which visits Home Assistant has already announced as events.

The event entities are what automations turn into phone notifications, so a
visit must be announced once, ever. Two things work against that: the plugin
publishes `visit_updated` whenever a clip finishes, a visit is merged or a
correction lands (only `visit_new` is a new sighting), and the plugin replays
up to 500 past events to anyone who asks for history, which Home Assistant does
after every restart. This module is the memory that makes both harmless.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterable
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

STORAGE_VERSION = 1
# The plugin keeps 500 events, so no more than 500 `visit_new` can ever be replayed.
MAX_ANNOUNCED = 500
SAVE_DELAY_SECONDS = 10


def new_visit_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Return the visit inside a plugin `visit_new` event; every other type is ignored."""
    if event.get("type") != "visit_new":
        return None
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    visit = data.get("visit", data)
    return visit if isinstance(visit, dict) else None


def visit_id(visit: dict[str, Any]) -> str | None:
    """Return the visit's id as a string, or None when the payload has none."""
    value = visit.get("id", visit.get("visitId"))
    return None if value is None or value == "" else str(value)


class AnnouncedVisits:
    """A bounded, persisted set of visit ids that already produced an event."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.announced.{entry_id}"
        )
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._dirty = False

    def __len__(self) -> int:
        return len(self._ids)

    def __contains__(self, identifier: object) -> bool:
        return identifier in self._ids

    async def async_load(self) -> bool:
        """Load the saved ids. False means nothing usable was saved (the very first run)."""
        stored = await self._store.async_load()
        ids = stored.get("ids") if isinstance(stored, dict) else None
        if not isinstance(ids, list):
            return False
        self._ids.clear()
        for identifier in ids[-MAX_ANNOUNCED:]:
            if isinstance(identifier, str) and identifier:
                self._ids[identifier] = None
        return True

    def claim(self, identifier: str) -> bool:
        """Mark a visit announced. True only the first time it is ever claimed."""
        if identifier in self._ids:
            return False
        self._remember(identifier)
        self._dirty = True
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECONDS)
        return True

    def record(self, identifiers: Iterable[str]) -> None:
        """Mark visits as already announced without announcing them. Call async_save after."""
        for identifier in identifiers:
            if identifier not in self._ids:
                self._remember(identifier)
                self._dirty = True

    async def async_save(self) -> None:
        """Write the ids now (also cancels any delayed write that is still pending)."""
        await self._store.async_save(self._data_to_save())

    async def async_flush(self) -> None:
        """Write the ids now if anything changed since the last write."""
        if self._dirty:
            await self.async_save()

    async def async_remove(self) -> None:
        """Delete the saved ids (the config entry is being removed)."""
        await self._store.async_remove()

    def _remember(self, identifier: str) -> None:
        self._ids[identifier] = None
        while len(self._ids) > MAX_ANNOUNCED:
            self._ids.popitem(last=False)

    def _data_to_save(self) -> dict[str, Any]:
        self._dirty = False
        return {"ids": list(self._ids)}
