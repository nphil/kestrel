"""Stand-ins for the parts of Home Assistant that the Kestrel integration imports.

Importing this module installs the stubs and then loads the REAL integration modules
(announced, coordinator, event, websocket_api) under the package name `kestrel_pkg`, so the
tests exercise the shipped code without a Home Assistant install. Only the plugin client and
the entity helpers are replaced by simple fakes.
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import voluptuous as vol

INTEGRATION = Path(__file__).resolve().parents[1] / "custom_components" / "kestrel"
DISK: dict[str, object] = {}  # stands in for Home Assistant's .storage directory


def _module(name: str, **attrs: object) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


class Store:
    def __init__(self, hass: object, version: int, key: str) -> None:
        self.key = key

    async def async_load(self) -> object:
        return copy.deepcopy(DISK.get(self.key))

    async def async_save(self, data: object) -> None:
        DISK[self.key] = copy.deepcopy(data)

    def async_delay_save(self, data_func: object, delay: float = 0) -> None:
        pass  # Home Assistant writes later; the integration also flushes on stop

    async def async_remove(self) -> None:
        DISK.pop(self.key, None)


class EventEntity:
    def _trigger_event(self, event_type: str, event_attributes: dict | None = None) -> None:
        assert event_type in self._attr_event_types, f"{event_type!r} is not a declared event type"
        self.fired.append((event_type, dict(event_attributes or {})))

    def async_write_ha_state(self) -> None:
        pass


class CoordinatorEntity:
    def __class_getitem__(cls, item: object) -> type:
        return cls

    def __init__(self, coordinator: object) -> None:
        self.coordinator = coordinator
        self.fired: list[tuple[str, dict]] = []

    def _handle_coordinator_update(self) -> None:
        pass


class DataUpdateCoordinator:
    def __class_getitem__(cls, item: object) -> type:
        return cls

    def __init__(self, hass: object, logger: object, **kwargs: object) -> None:
        self.hass = hass
        self.data: dict | None = None
        self.listeners: list = []

    def async_add_listener(self, update_callback: object, context: object = None) -> object:
        self.listeners.append(update_callback)
        return lambda: self.listeners.remove(update_callback)

    def async_set_updated_data(self, data: dict) -> None:
        self.data = data
        for listener in list(self.listeners):
            listener()


class HomeAssistant:
    def __init__(self) -> None:
        self.data: dict = {}

    def async_create_task(self, coro: object, name: str | None = None) -> asyncio.Future:
        return asyncio.ensure_future(coro)


class KestrelApiError(Exception):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = "invalid_auth" if status == 401 else "not_found" if status == 404 else "api_error"


def async_dispatcher_connect(hass: HomeAssistant, signal: str, target: object) -> object:
    listeners = hass.data.setdefault("dispatcher", {}).setdefault(signal, [])
    listeners.append(target)

    def disconnect() -> None:
        if target in listeners:
            listeners.remove(target)

    return disconnect


def async_dispatcher_send(hass: HomeAssistant, signal: str, *args: object) -> None:
    for target in list(hass.data.get("dispatcher", {}).get(signal, [])):
        target(*args)


def _websocket_command(schema: dict) -> object:
    def decorate(fn: object) -> object:
        fn.ws_schema = vol.Schema({vol.Required("id"): int, **schema})  # as Home Assistant adds the id
        return fn

    return decorate


def _install_stubs() -> None:
    _module("homeassistant")
    _module("homeassistant.core", HomeAssistant=HomeAssistant, callback=lambda fn: fn)
    _module("homeassistant.config_entries", ConfigEntry=type("ConfigEntry", (), {}))
    _module("homeassistant.components")
    _module("homeassistant.components.event", EventEntity=EventEntity)
    _module(
        "homeassistant.components.websocket_api",
        websocket_command=_websocket_command,
        async_response=lambda fn: fn,
        async_register_command=lambda hass, fn: None,
        ActiveConnection=type("ActiveConnection", (), {}),
        ERR_INVALID_FORMAT="invalid_format",
    )
    _module("homeassistant.components.http")
    _module(
        "homeassistant.components.http.auth",
        async_sign_path=lambda hass, path, expiry, refresh_token_id=None: f"{path}?authSig=FAKE",
    )
    _module("homeassistant.helpers")
    _module("homeassistant.helpers.entity_platform", AddEntitiesCallback=type("AddEntitiesCallback", (), {}))
    _module(
        "homeassistant.helpers.update_coordinator",
        CoordinatorEntity=CoordinatorEntity,
        DataUpdateCoordinator=DataUpdateCoordinator,
        UpdateFailed=type("UpdateFailed", (Exception,), {}),
    )
    _module("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: None)
    _module("homeassistant.helpers.storage", Store=Store)
    _module(
        "homeassistant.helpers.dispatcher",
        async_dispatcher_connect=async_dispatcher_connect,
        async_dispatcher_send=async_dispatcher_send,
    )
    _module("homeassistant.util")
    _module("homeassistant.util.dt", utcnow=lambda: datetime.now(timezone.utc))
    _module("aiohttp", ClientError=type("ClientError", (Exception,), {}), ClientTimeout=lambda **kwargs: None)
    package = types.ModuleType("kestrel_pkg")
    package.__path__ = [str(INTEGRATION)]  # the real files, so relative imports resolve
    sys.modules["kestrel_pkg"] = package
    _module("kestrel_pkg.client", KestrelApiError=KestrelApiError, KestrelClient=object)
    _module(
        "kestrel_pkg.entity",
        camera_slug=lambda camera: str(camera["id"]),
        device_info=lambda coordinator: {},
    )


_install_stubs()
announced_module = importlib.import_module("kestrel_pkg.announced")
coordinator_module = importlib.import_module("kestrel_pkg.coordinator")
event_module = importlib.import_module("kestrel_pkg.event")
websocket_module = importlib.import_module("kestrel_pkg.websocket_api")
const_module = importlib.import_module("kestrel_pkg.const")

FRONT = {"id": "55", "name": "Front Door Camera"}
BACK = {"id": "88", "name": "Backyard Camera"}
STORAGE_KEY = "kestrel.announced.E1"


def seen(visit_id: str, species: str, *, grp: str = "mammal", camera: dict = FRONT, **extra: object) -> dict:
    return {
        "id": visit_id, "species": species, "grp": grp, "kind": "seen", "score": 0.9,
        "camera": dict(camera), "notify": True, "firstEver": True, **extra,
    }


def heard(visit_id: str, species: str, *, grp: str = "bird", camera: dict = BACK) -> dict:
    return {
        "id": visit_id, "species": species, "grp": grp, "kind": "heard", "score": 0.7,
        "camera": dict(camera), "notify": False, "firstEver": False,
    }


def event(kind: str, visit: dict, *, wrapped: bool = False) -> dict:
    return {"type": kind, "data": {"visit": visit} if wrapped else visit}


def fired_ids(entity: CoordinatorEntity) -> list[str]:
    return [attributes["visit_id"] for _, attributes in entity.fired]


class BatchDelivery:
    """Hands batches to entities the way KestrelCoordinator._publish does."""

    def __init__(self, announced: object) -> None:
        self.announced = announced
        self.data: dict = {}
        self._generation = 0

    def deliver(self, entities: list, events: list[dict]) -> None:
        self._generation += 1
        self.data = {"events": events, "event_generation": self._generation}
        for entity in entities:
            entity._handle_coordinator_update()


class FakeClient:
    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls: list[dict] = []
        self.requests: list[tuple[str, str]] = []

    async def async_request(self, method: str, path: str, params: dict | None = None, **kwargs: object) -> object:
        self.calls.append(dict(params or {}))
        self.requests.append((method, path))
        if not self.script:
            raise asyncio.CancelledError  # ends the endless poll loop
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def async_get_cameras(self) -> list[dict]:
        return [FRONT, BACK]


def new_announced(entry_id: str = "E1") -> object:
    return announced_module.AnnouncedVisits(HomeAssistant(), entry_id)


def new_coordinator(script: list, hass: HomeAssistant | None = None) -> coordinator_module.KestrelCoordinator:
    entry = types.SimpleNamespace(entry_id="E1", options={})
    coordinator = coordinator_module.KestrelCoordinator(hass or HomeAssistant(), entry, FakeClient(script))
    coordinator._replace_cameras([FRONT, BACK])
    return coordinator


def attach(coordinator: object, *entities: CoordinatorEntity) -> None:
    coordinator.listeners.extend(entity._handle_coordinator_update for entity in entities)


async def run_poll_loop(coordinator: coordinator_module.KestrelCoordinator) -> None:
    try:
        await coordinator._async_poll_events()
    except asyncio.CancelledError:
        pass
