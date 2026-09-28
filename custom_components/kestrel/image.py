"""Latest animal image entities."""

from __future__ import annotations

from typing import Any

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .client import KestrelApiError
from .coordinator import KestrelCoordinator
from .entity import camera_slug, device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[KestrelCoordinator],
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create one latest-animal image entity per wildlife camera."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_camera_images(cameras: list[dict[str, Any]]) -> None:
        entities: list[KestrelLatestAnimalImage] = []
        for camera in cameras:
            camera_id = str(camera.get("id", ""))
            slug = camera_slug(camera)
            if not camera_id or slug in known:
                continue
            known.add(slug)
            entities.append(KestrelLatestAnimalImage(coordinator, camera))
        if entities:
            async_add_entities(entities, update_before_add=True)

    entry.async_on_unload(coordinator.async_register_camera_callback(add_camera_images))


class KestrelLatestAnimalImage(CoordinatorEntity[KestrelCoordinator], ImageEntity):
    """The plugin's most recent animal snapshot for one camera."""

    _attr_translation_key = "latest_animal"
    _attr_icon = "mdi:camera-image"
    _attr_has_entity_name = False

    def __init__(self, coordinator: KestrelCoordinator, camera: dict[str, Any]) -> None:
        super().__init__(coordinator)
        self._camera_id = str(camera["id"])
        self._camera_name = str(camera.get("name") or f"Camera {self._camera_id}")
        slug = camera_slug(camera)
        self._attr_unique_id = f"kestrel_{slug}_latest_animal"
        self._attr_suggested_object_id = self._attr_unique_id
        self._attr_name = f"{self._camera_name} latest animal"
        self._attr_device_info = device_info(coordinator)

    @property
    def available(self) -> bool:
        return True

    async def async_image(self) -> bytes | None:
        try:
            return await self.coordinator.client.async_get_media_bytes("camera", self._camera_id + ".jpg")
        except KestrelApiError:
            return None
