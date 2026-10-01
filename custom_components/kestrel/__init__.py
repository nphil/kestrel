"""Kestrel Home Assistant integration."""

from __future__ import annotations

from pathlib import Path
import logging

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .announced import AnnouncedVisits
from .audio import AudioPreviews
from .client import KestrelClient
from .const import (
    CONF_API_KEY,
    CONF_AUDIO_KEY,
    CONF_AUDIO_URL,
    CONF_URL,
    DOMAIN,
    INTEGRATION_VERSION,
    PANEL_COMPONENT_NAME,
    PANEL_SIDEBAR_ICON,
    PANEL_SIDEBAR_TITLE,
    PANEL_URL_PATH,
    STATIC_PATH,
)
from .coordinator import KestrelCoordinator
from .media import async_register_media_view
from .websocket_api import async_setup_websocket_api

_LOGGER = logging.getLogger(__name__)
PLATFORMS: list[Platform] = [Platform.EVENT, Platform.IMAGE, Platform.BINARY_SENSOR]
KestrelConfigEntry = ConfigEntry[KestrelCoordinator]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register process-wide views, websocket commands, and the static card bundle."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    async_register_media_view(hass)
    async_setup_websocket_api(hass)
    if not domain_data.get("frontend_registered"):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_PATH, str(frontend_dir), cache_headers=True)]
        )
        domain_data["frontend_registered"] = True
        bundles = await hass.async_add_executor_job(
            lambda: sorted(frontend_dir.glob("kestrel.*.js"))
        )
        if bundles:
            module_url = f"{STATIC_PATH}/{bundles[0].name}?v={INTEGRATION_VERSION}"
            frontend.add_extra_js_url(hass, module_url)
            domain_data["frontend_module_url"] = module_url
        else:
            _LOGGER.warning("Kestrel frontend bundle was not found in %s", frontend_dir)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: KestrelConfigEntry) -> bool:
    """Set up Kestrel after verifying that the plugin is reachable."""
    client = KestrelClient(
        async_get_clientsession(hass),
        entry.data[CONF_URL],
        entry.data[CONF_API_KEY],
    )
    coordinator = KestrelCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data["coordinator"] = coordinator
    audio = AudioPreviews(hass, entry.options.get(CONF_AUDIO_URL), entry.options.get(CONF_AUDIO_KEY))
    domain_data["audio"] = audio
    audio.async_start()

    module_url = domain_data.get("frontend_module_url")
    if module_url and not domain_data.get("panel_registered"):
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL_PATH,
            webcomponent_name=PANEL_COMPONENT_NAME,
            sidebar_title=PANEL_SIDEBAR_TITLE,
            sidebar_icon=PANEL_SIDEBAR_ICON,
            module_url=module_url,
            embed_iframe=False,
            require_admin=False,
        )
        domain_data["panel_registered"] = True
    elif not module_url:
        _LOGGER.warning(
            "Kestrel frontend bundle is unavailable; sidebar panel was not registered"
        )

    async def stop_on_shutdown(event: object) -> None:
        await coordinator.async_stop()
        await audio.async_stop()

    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop_on_shutdown))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    coordinator.async_start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: KestrelConfigEntry) -> bool:
    """Unload platforms and stop the event long-poll task."""
    coordinator = entry.runtime_data
    await coordinator.async_stop()
    audio = hass.data.get(DOMAIN, {}).pop("audio", None)
    if audio is not None:
        await audio.async_stop()
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        domain_data = hass.data.get(DOMAIN, {})
        if domain_data.get("coordinator") is coordinator:
            domain_data.pop("coordinator", None)
        if domain_data.pop("panel_registered", False):
            frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: KestrelConfigEntry) -> None:
    """Forget the announced-visit memory when the config entry is deleted."""
    await AnnouncedVisits(hass, entry.entry_id).async_remove()


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: KestrelConfigEntry, device: dr.DeviceEntry
) -> bool:
    """Allow removal only for stale Kestrel devices not owned by this entry."""
    return not any(
        domain == DOMAIN and identifier == (entry.unique_id or entry.entry_id)
        for domain, identifier in device.identifiers
    )
