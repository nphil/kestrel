"""Kestrel diagnostic entities: the plugin connection, and whether BirdNET-Go still feeds Kestrel."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .birdnet_link import SIGNAL_BIRDNET_LINK, BirdnetLink
from .const import DOMAIN
from .coordinator import KestrelCoordinator
from .entity import device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[KestrelCoordinator],
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the diagnostic sensors."""
    entities: list[BinarySensorEntity] = [KestrelConnectionSensor(entry.runtime_data)]
    link: BirdnetLink | None = hass.data.get(DOMAIN, {}).get("birdnet_link")
    if link is not None:
        entities.append(BirdnetLinkSensor(entry.runtime_data, link))
    async_add_entities(entities)


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


class BirdnetLinkSensor(BinarySensorEntity):
    """On when BirdNET-Go stopped answering the way Kestrel needs, or stopped reaching the plugin."""

    _attr_translation_key = "birdnet_link"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_has_entity_name = True
    _attr_unique_id = "kestrel_birdnet_link"
    _attr_suggested_object_id = "kestrel_birdnet_go_link"
    _attr_icon = "mdi:bird"
    _attr_should_poll = False

    def __init__(self, coordinator: KestrelCoordinator, link: BirdnetLink) -> None:
        self._link = link
        self._attr_device_info = device_info(coordinator)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_BIRDNET_LINK, self.async_write_ha_state)
        )

    @property
    def available(self) -> bool:
        return self._link.verdict is not None

    @property
    def is_on(self) -> bool | None:
        return None if self._link.verdict is None else self._link.verdict.problem

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        verdict = self._link.verdict
        if verdict is None:
            return {}
        return {
            "reason": verdict.reason,
            "detail": verdict.detail,
            "newest_detection_at": verdict.newest_detection_at.isoformat() if verdict.newest_detection_at else None,
            "last_received_at": verdict.last_received_at.isoformat() if verdict.last_received_at else None,
            "checked_at": self._link.checked_at.isoformat() if self._link.checked_at else None,
        }
