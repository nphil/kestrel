"""Long-poll coordinator for Kestrel events."""

from __future__ import annotations

import aiohttp
import asyncio
import logging
from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import KestrelApiError, KestrelClient
from .const import (
    BIRDNET_GO_INTERNAL_URL,
    CONF_POLL_TIMEOUT,
    DEFAULT_POLL_TIMEOUT,
    DOMAIN,
    KNOWN_CAMERA_SLUGS,
)

_LOGGER = logging.getLogger(__name__)
CameraCallback = Callable[[list[dict[str, Any]]], None]


class KestrelCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Keep camera status current and relay plugin event batches."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, client: KestrelClient
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_method=self._async_update_data,
            update_interval=None,
        )
        self.entry = entry
        self.client = client
        self.connected = False
        self._seq = 0
        self._generation = 0
        self._camera_data: dict[str, dict[str, Any]] = {}
        self._camera_callbacks: set[CameraCallback] = set()
        self._poll_task: asyncio.Task[None] | None = None
        self._species_map_task: asyncio.Task[None] | None = None
        self._poll_timeout = int(entry.options.get(CONF_POLL_TIMEOUT, DEFAULT_POLL_TIMEOUT))

    async def _async_update_data(self) -> dict[str, Any]:
        """Verify the plugin at setup and seed known cameras."""
        try:
            cameras = await self.client.async_get_cameras()
        except KestrelApiError as err:
            self.connected = False
            raise UpdateFailed(str(err)) from err
        self.connected = True
        self._replace_cameras(cameras)
        return {"cameras": self._camera_list(), "events": [], "event_generation": 0}

    def async_start(self) -> None:
        """Start the long-poll task after entities and websocket handlers are ready."""
        if self._poll_task is None:
            self._poll_task = self.hass.async_create_task(
                self._async_poll_events(), "kestrel event long poll"
            )
        if self._species_map_task is None:
            self._species_map_task = self.hass.async_create_task(
                self._async_load_species_map(), "kestrel birdnet species map"
            )

    async def _async_load_species_map(self) -> None:
        """Fetch BirdNET-Go's common<->scientific name map once, best-effort.

        Powers referenceImage/referenceImageInfoUrl signing for species with no
        own photo (see websocket_api._sign_media_paths). BirdNET-Go being
        unreachable, or not yet up, just means those fields stay absent until
        the next entry reload -- never load-bearing for anything else.
        """
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{BIRDNET_GO_INTERNAL_URL}/api/v2/species/all",
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                if response.status != 200:
                    return
                payload = await response.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError):
            return
        species = payload.get("species") if isinstance(payload, dict) else None
        if not isinstance(species, list):
            return
        mapping = {
            str(item["commonName"]).strip().lower(): str(item["scientificName"])
            for item in species
            if isinstance(item, dict) and item.get("commonName") and item.get("scientificName")
        }
        if mapping:
            self.hass.data.setdefault(DOMAIN, {})["birdnet_species_map"] = mapping

    async def async_stop(self) -> None:
        """Stop polling cleanly on unload and Home Assistant shutdown."""
        for attr in ("_poll_task", "_species_map_task"):
            task = getattr(self, attr)
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            setattr(self, attr, None)

    @callback
    def async_register_camera_callback(self, add_cameras: CameraCallback) -> Callable[[], None]:
        """Register one platform's callback for current and newly watched cameras."""
        self._camera_callbacks.add(add_cameras)
        add_cameras(self._wildlife_cameras())

        @callback
        def _remove() -> None:
            self._camera_callbacks.discard(add_cameras)

        return _remove

    def _replace_cameras(self, cameras: list[dict[str, Any]]) -> None:
        self._camera_data = {
            str(camera["id"]): camera for camera in cameras if camera.get("id") is not None
        }

    def _camera_list(self) -> list[dict[str, Any]]:
        return list(self._camera_data.values())

    def _wildlife_cameras(self) -> list[dict[str, Any]]:
        return [
            camera
            for camera in self._camera_data.values()
            if camera.get("wildlife") is True or str(camera.get("id")) in KNOWN_CAMERA_SLUGS
        ]

    @callback
    def _async_notify_camera_callbacks(self) -> None:
        cameras = self._wildlife_cameras()
        for add_cameras in tuple(self._camera_callbacks):
            add_cameras(cameras)

    async def _async_poll_events(self) -> None:
        """Long-poll until HA unloads the integration; reconnect without losing events."""
        retry_delay = 1
        while True:
            try:
                response = await self.client.async_request(
                    "GET",
                    "events",
                    params={"after": self._seq, "timeout": self._poll_timeout},
                    timeout=self._poll_timeout + 10,
                )
                if not isinstance(response, dict):
                    raise KestrelApiError("Kestrel returned an invalid event response")
                sequence = response.get("seq", self._seq)
                try:
                    next_seq = max(self._seq, int(sequence))
                except (TypeError, ValueError) as err:
                    raise KestrelApiError("Kestrel returned an invalid event sequence") from err
                was_connected = self.connected

                if response.get("resync"):
                    cameras = await self.client.async_get_cameras()
                    self._replace_cameras(cameras)
                    self._seq = next_seq
                    self.connected = True
                    retry_delay = 1
                    self._publish([], resync=True)
                    self._async_notify_camera_callbacks()
                    continue

                events = response.get("events", [])
                if not isinstance(events, list):
                    raise KestrelApiError("Kestrel returned an invalid event list")
                camera_changed = any(
                    isinstance(event, dict) and event.get("type") == "camera" for event in events
                )
                if camera_changed:
                    cameras = await self.client.async_get_cameras()
                    self._replace_cameras(cameras)
                    self._async_notify_camera_callbacks()

                self._seq = next_seq
                self.connected = True
                retry_delay = 1
                if events:
                    self._publish([event for event in events if isinstance(event, dict)])
                elif not was_connected:
                    self._publish([])
            except asyncio.CancelledError:
                raise
            except (KestrelApiError, asyncio.TimeoutError) as err:
                if self.connected:
                    self.connected = False
                    self._publish([])
                _LOGGER.warning("Kestrel event connection failed: %s", err)
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)
            except Exception:  # Keep the diagnostic entity usable for unexpected plugin shapes.
                if self.connected:
                    self.connected = False
                    self._publish([])
                _LOGGER.exception("Unexpected Kestrel event polling error")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 30)

    @callback
    def _publish(self, events: list[dict[str, Any]], *, resync: bool = False) -> None:
        self._generation += 1
        current = dict(self.data or {})
        current.update(
            cameras=self._camera_list(),
            events=events,
            event_generation=self._generation,
            resync=resync,
        )
        self.async_set_updated_data(current)
