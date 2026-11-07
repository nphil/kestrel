"""Fixtures that run the real Kestrel integration inside Home Assistant's own test harness.

The older tests in the folder above use stand-ins for Home Assistant and run with
`python3 -m unittest discover -s tests`. The tests in this folder load the genuine thing, so they
show whether a new Home Assistant release still accepts what Kestrel registers (devices,
entities, the options form).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

try:  # Home Assistant 2026.11 and later
    from pytest_homeassistant.common import MockConfigEntry
except ImportError:  # the discontinued harness, still needed for 2026.10
    from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kestrel.const import CONF_API_KEY, CONF_URL, DOMAIN

CAMERAS = [
    {"id": "cam1", "name": "Front Yard", "wildlife": True},
    {"id": "cam2", "name": "Back Garden", "wildlife": True},
]


@pytest.fixture(autouse=True)
def _custom_integrations(request: pytest.FixtureRequest) -> None:
    """Home Assistant 2026.10's harness needs this fixture to load a custom integration; 2026.11's does not have it."""
    try:
        request.getfixturevalue("enable_custom_integrations")
    except pytest.FixtureLookupError:
        pass


@pytest.fixture
def config_entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title="Kestrel",
        data={CONF_URL: "http://kestrel.test:10443", CONF_API_KEY: "test-key-0123456789"},
        unique_id="kestrel-test-entry",
    )


@pytest.fixture
def plugin() -> Iterator[None]:
    """A Kestrel plugin that lists two cameras and never has any events.

    The long poll waits forever (Home Assistant cancels it on unload, as in real life), and the
    BirdNET-Go and Xeno-canto lookups are left out so no test touches the network.
    """

    async def get_cameras(self: Any) -> list[dict[str, Any]]:
        return [dict(camera) for camera in CAMERAS]

    async def request(self: Any, method: str, path: str, **kwargs: Any) -> Any:
        if path.startswith("events"):
            await asyncio.Event().wait()
        return None

    async def nothing(*args: Any, **kwargs: Any) -> None:
        return None

    with (
        patch("custom_components.kestrel.client.KestrelClient.async_get_cameras", get_cameras),
        patch("custom_components.kestrel.client.KestrelClient.async_request", request),
        patch("custom_components.kestrel.coordinator.KestrelCoordinator._async_load_species_map", nothing),
    ):
        yield


@pytest.fixture
async def setup_kestrel(hass: HomeAssistant, config_entry: MockConfigEntry, plugin: None) -> MockConfigEntry:
    """Kestrel set up with the frontend calls stubbed (no frontend or web server runs here)."""
    assert await async_setup_component(hass, "http", {})
    config_entry.add_to_hass(hass)
    with (
        patch("homeassistant.components.frontend.add_extra_js_url"),
        patch("homeassistant.components.panel_custom.async_register_panel"),
    ):
        assert await hass.config_entries.async_setup(config_entry.entry_id)
        await hass.async_block_till_done()
    return config_entry
