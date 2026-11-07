"""Kestrel inside a real Home Assistant: setup, devices, entities, options form."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from custom_components.kestrel.const import DOMAIN


async def test_setup_creates_one_device_and_the_entities(hass: HomeAssistant, setup_kestrel) -> None:
    """Every entity hangs off the single Kestrel service device (DeviceInfo built with keywords)."""
    assert setup_kestrel.state is ConfigEntryState.LOADED

    devices = dr.async_entries_for_config_entry(dr.async_get(hass), setup_kestrel.entry_id)
    assert len(devices) == 1
    assert devices[0].name == "Kestrel"
    assert devices[0].manufacturer == "Kestrel"
    assert devices[0].entry_type is dr.DeviceEntryType.SERVICE

    entities = er.async_entries_for_config_entry(er.async_get(hass), setup_kestrel.entry_id)
    domains = sorted(entity.domain for entity in entities)
    # One connection sensor, one heard-animal event, and an event + image per camera.
    assert domains == ["binary_sensor", "event", "event", "event", "image", "image"]
    assert {entity.device_id for entity in entities} == {devices[0].id}
    assert hass.states.get("binary_sensor.kestrel_connection").state == "on"


async def test_entity_id_change_keeps_the_entity_working(hass: HomeAssistant, setup_kestrel) -> None:
    """Renaming an entity id (in place from 2026.11, remove and re-add before) leaves one live entity."""
    registry = er.async_get(hass)
    sensor = registry.async_get("binary_sensor.kestrel_connection")
    assert sensor is not None

    registry.async_update_entity(sensor.entity_id, new_entity_id="binary_sensor.kestrel_link")
    await hass.async_block_till_done()

    assert hass.states.get("binary_sensor.kestrel_connection") is None
    assert hass.states.get("binary_sensor.kestrel_link").state == "on"


async def test_unload_and_reload(hass: HomeAssistant, setup_kestrel) -> None:
    assert await hass.config_entries.async_unload(setup_kestrel.entry_id)
    await hass.async_block_till_done()
    assert setup_kestrel.state is ConfigEntryState.NOT_LOADED
    assert "coordinator" not in hass.data.get(DOMAIN, {})

    assert await hass.config_entries.async_setup(setup_kestrel.entry_id)
    await hass.async_block_till_done()
    assert setup_kestrel.state is ConfigEntryState.LOADED


async def test_options_form_saves_and_reloads(hass: HomeAssistant, setup_kestrel) -> None:
    """The options flow shows its form with a step id and saves; the entry reloads once."""
    result = await hass.config_entries.options.async_init(setup_kestrel.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"

    result = await hass.config_entries.options.async_configure(result["flow_id"], {"poll_timeout": 20})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert setup_kestrel.state is ConfigEntryState.LOADED
    assert setup_kestrel.options["poll_timeout"] == 20
