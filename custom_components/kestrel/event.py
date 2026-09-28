"""Wildlife and heard-bird event entities."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import KestrelCoordinator
from .entity import camera_slug, device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[KestrelCoordinator],
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create wildlife-camera event entities and one heard-animal event entity."""
    coordinator = entry.runtime_data
    async_add_entities([KestrelHeardAnimalEvent(coordinator)], update_before_add=True)
    known: set[str] = set()

    @callback
    def add_camera_entities(cameras: list[dict[str, Any]]) -> None:
        entities: list[KestrelAnimalEvent] = []
        for camera in cameras:
            camera_id = str(camera.get("id", ""))
            slug = camera_slug(camera)
            if not camera_id or slug in known:
                continue
            known.add(slug)
            entities.append(KestrelAnimalEvent(coordinator, camera))
        if entities:
            async_add_entities(entities, update_before_add=True)

    entry.async_on_unload(coordinator.async_register_camera_callback(add_camera_entities))


class _KestrelEventBase(CoordinatorEntity[KestrelCoordinator], EventEntity):
    """Keep event sensors available so connection loss remains diagnosable."""

    _attr_has_entity_name = False

    def __init__(self, coordinator: KestrelCoordinator) -> None:
        super().__init__(coordinator)
        self._last_generation = -1

    @property
    def available(self) -> bool:
        return True

    def _read_event_batch(self) -> list[dict[str, Any]]:
        data = self.coordinator.data or {}
        generation = data.get("event_generation", 0)
        if generation == self._last_generation:
            return []
        self._last_generation = generation
        events = data.get("events", [])
        return events if isinstance(events, list) else []


class KestrelAnimalEvent(_KestrelEventBase):
    """A camera's latest animal visit as a Home Assistant event entity."""

    _attr_translation_key = "animal"
    _attr_event_types = ["bird", "mammal", "unidentified"]
    _attr_icon = "mdi:paw"

    def __init__(self, coordinator: KestrelCoordinator, camera: dict[str, Any]) -> None:
        super().__init__(coordinator)
        self._camera_id = str(camera["id"])
        self._camera_name = str(camera.get("name") or f"Camera {self._camera_id}")
        self._camera_slug = camera_slug(camera)
        self._attr_unique_id = f"kestrel_{self._camera_slug}_animal"
        self._attr_suggested_object_id = self._attr_unique_id
        self._attr_name = f"{self._camera_name} animal"
        self._attr_device_info = device_info(coordinator)

    def _handle_coordinator_update(self) -> None:
        for event in self._read_event_batch():
            visit = _visit_from_event(event)
            if visit is None or _visit_camera_id(visit) != self._camera_id:
                continue
            if str(visit.get("kind", "seen")).lower() == "heard":
                continue
            self._trigger_event(_event_type(visit), _event_attributes(visit, self._camera_name))
            self.async_write_ha_state()
        super()._handle_coordinator_update()


class KestrelHeardAnimalEvent(_KestrelEventBase):
    """A BirdNET-linked heard-animal visit (bird, mammal, or other call)."""

    _attr_translation_key = "heard_animal"
    _attr_event_types = ["bird", "mammal", "other"]
    _attr_icon = "mdi:ear-hearing"
    _attr_unique_id = "kestrel_heard_animal"
    _attr_suggested_object_id = "kestrel_heard_animal"
    _attr_name = "Heard animal"

    def __init__(self, coordinator: KestrelCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_device_info = device_info(coordinator)

    def _handle_coordinator_update(self) -> None:
        for event in self._read_event_batch():
            visit = _visit_from_event(event)
            if visit is None or str(visit.get("kind", "")).lower() != "heard":
                continue
            group = str(visit.get("grp", "")).lower()
            if group not in ("bird", "mammal", "other"):
                continue
            self._trigger_event(group, _event_attributes(visit, _camera_name(visit)))
            self.async_write_ha_state()
        super()._handle_coordinator_update()


def _visit_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
    if event.get("type") not in ("visit_new", "visit_updated"):
        return None
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    visit = data.get("visit", data)
    return visit if isinstance(visit, dict) else None


def _visit_camera_id(visit: dict[str, Any]) -> str:
    camera = visit.get("camera")
    if isinstance(camera, dict):
        return str(camera.get("id", ""))
    return str(visit.get("camera_id", camera or ""))


def _camera_name(visit: dict[str, Any]) -> str:
    camera = visit.get("camera")
    if isinstance(camera, dict):
        return str(camera.get("name") or "Unknown camera")
    return str(camera or "Unknown camera")


def _event_type(visit: dict[str, Any]) -> str:
    group = str(visit.get("grp", visit.get("group", "unknown"))).lower()
    return group if group in ("bird", "mammal") else "unidentified"


def _event_attributes(visit: dict[str, Any], camera_name: str) -> dict[str, Any]:
    return {
        "species": visit.get("species"),
        "score": visit.get("score"),
        "visit_id": visit.get("id", visit.get("visitId")),
        "camera": camera_name,
        "kind": visit.get("kind", "seen"),
        "notify": bool(visit.get("notify", False)),
        "first_ever": bool(visit.get("firstEver", visit.get("first_ever", False))),
    }
