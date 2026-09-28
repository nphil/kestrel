"""Kestrel connection diagnostic entity."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import KestrelCoordinator
from .entity import device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[KestrelCoordinator],
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the diagnostic connection sensor."""
    async_add_entities([KestrelConnectionSensor(entry.runtime_data)])


class KestrelConnectionSensor(CoordinatorEntity[KestrelCoordinator], BinarySensorEntity):
    """Whether the Kestrel plugin event connection is currently reachable."""

    _attr_translation_key = "connection"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = False
    _attr_unique_id = "kestrel_connection"
    _attr_suggested_object_id = "kestrel_connection"
    _attr_name = "Connection"
    _attr_icon = "mdi:lan-connect"

    def __init__(self, coordinator: KestrelCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_device_info = device_info(coordinator)

    @property
    def available(self) -> bool:
        return True

    @property
    def is_on(self) -> bool:
        return self.coordinator.connected
