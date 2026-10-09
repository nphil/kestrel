"""Stand-ins for the parts of Home Assistant that the Kestrel integration imports.

Importing this module installs the stubs and then loads the REAL integration modules
(announced, coordinator, event, websocket_api) under the package name `kestrel_pkg`, so the
tests exercise the shipped code without a Home Assistant install. Only the plugin client and
the entity helpers are replaced by simple fakes.
"""

from __future__ import annotations

import asyncio
import copy
import json
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
        self._tasks: set[asyncio.Future] = set()  # the tasks Home Assistant's own startup waits for

    def async_create_task(self, coro: object, name: str | None = None) -> asyncio.Future:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def async_create_background_task(self, coro: object, name: str | None = None) -> asyncio.Future:
        return asyncio.ensure_future(coro)  # not tracked: startup does not wait for it

    async def async_block_till_done(self) -> None:
        """What Home Assistant's startup does after the integrations are set up: wait for every ordinary task."""
        while self._tasks:
            await asyncio.wait(list(self._tasks))

    async def async_add_executor_job(self, target: object, *args: object) -> object:
        return target(*args)  # run in place: the tests need no thread


class _FakeContent:
    def __init__(self, data: bytes, hang: bool = False) -> None:
        self._data = data
        self._hang = hang

    async def iter_chunked(self, size: int):
        if self._hang:
            await asyncio.Event().wait()  # never finishes: a stalled server
        for start in range(0, len(self._data), size):
            yield self._data[start : start + size]


class FakeResponse:
    """A response with a status, headers and a body streamed in chunks (JSON or raw bytes)."""

    def __init__(
        self,
        status: int = 200,
        json_data: object = None,
        body: bytes = b"",
        headers: dict | None = None,
        hang: bool = False,
    ) -> None:
        self.status = status
        self.headers = dict(headers or {})
        data = json.dumps(json_data).encode() if json_data is not None else body
        self._data = data
        self.content = _FakeContent(data, hang)

    async def json(self, content_type: str | None = None) -> object:
        return json.loads(self._data)

    async def __aenter__(self) -> "FakeResponse":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False


class FakeSession:
    """Serves scripted responses by (method, url) and records every call made."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self._routes: dict[tuple[str, str], list] = {}

    def route(self, method: str, url: str, *responses: object) -> None:
        """Responses are served in order; the last one repeats. An Exception is raised instead."""
        self._routes[(method, url)] = list(responses)

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        queue = self._routes.get((method, url))
        if not queue:
            return FakeResponse(404, {"error": "not_found"})
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        return self.request("GET", url, **kwargs)

    def calls_to(self, method: str, url: str) -> list[dict]:
        return [kwargs for call_method, call_url, kwargs in self.calls if (call_method, call_url) == (method, url)]


SESSION: dict[str, FakeSession] = {"session": FakeSession()}


class FakeWebResponse:
    """aiohttp.web.Response: just the status, headers and text."""

    def __init__(self, *, status: int = 200, headers: dict | None = None, text: str | None = None) -> None:
        self.status = status
        self.headers = dict(headers or {})
        self.text = text


class FakeStreamResponse(FakeWebResponse):
    """aiohttp.web.StreamResponse: collects what is written."""

    def __init__(self, *, status: int = 200, headers: dict | None = None) -> None:
        super().__init__(status=status, headers=headers)
        self.body = b""

    async def prepare(self, request: object) -> None:
        pass

    async def write(self, chunk: bytes) -> None:
        self.body += chunk

    async def write_eof(self) -> None:
        pass


class FakeFileResponse(FakeWebResponse):
    """aiohttp.web.FileResponse: remembers which file it would send (the real one adds Range, ETag and 304 itself)."""

    def __init__(self, path: object, *, headers: dict | None = None) -> None:
        super().__init__(status=200, headers=headers)
        self.path = path


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


class _FlowBase:
    """Just enough of Home Assistant's flow classes to run Kestrel's own form logic."""

    hass: object = None

    def __init_subclass__(cls, domain: str | None = None, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)

    def async_show_form(self, **kwargs: object) -> dict:
        return {"type": "form", **kwargs}

    def async_create_entry(self, **kwargs: object) -> dict:
        return {"type": "create_entry", **kwargs}


class _TextSelectorType:
    URL = "url"
    PASSWORD = "password"


class _TextSelectorConfig:
    def __init__(self, type: object = None) -> None:
        self.type = type


class _TextSelector:
    def __init__(self, config: object = None) -> None:
        self.config = config

    def __call__(self, value: object) -> object:
        return value


def _redact(data: object, to_redact: set) -> object:
    """Home Assistant's async_redact_data: values under the named keys are replaced, at any depth."""
    if isinstance(data, dict):
        return {key: "**REDACTED**" if key in to_redact else _redact(value, to_redact) for key, value in data.items()}
    if isinstance(data, list):
        return [_redact(item, to_redact) for item in data]
    return data


def _install_stubs() -> None:
    _module("homeassistant")
    _module("homeassistant.core", HomeAssistant=HomeAssistant, callback=lambda fn: fn)
    _module(
        "homeassistant.config_entries",
        ConfigEntry=type("ConfigEntry", (), {}),
        ConfigFlow=_FlowBase,
        ConfigFlowResult=dict,
        OptionsFlowWithReload=_FlowBase,
    )
    _module(
        "homeassistant.helpers.selector",
        TextSelector=_TextSelector,
        TextSelectorConfig=_TextSelectorConfig,
        TextSelectorType=_TextSelectorType,
    )
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
    _module("homeassistant.components.http", HomeAssistantView=type("HomeAssistantView", (), {}))
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
    _module("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: SESSION["session"])
    _module("homeassistant.helpers.storage", Store=Store)
    _module(
        "homeassistant.helpers.dispatcher",
        async_dispatcher_connect=async_dispatcher_connect,
        async_dispatcher_send=async_dispatcher_send,
    )
    _module("homeassistant.helpers.redact", async_redact_data=_redact)
    _module("homeassistant.util")
    _module("homeassistant.util.dt", utcnow=lambda: datetime.now(timezone.utc))
    web = _module("aiohttp.web", Response=FakeWebResponse, StreamResponse=FakeStreamResponse, FileResponse=FakeFileResponse, Request=object)
    _module(
        "aiohttp",
        ClientError=type("ClientError", (Exception,), {}),
        ClientTimeout=lambda **kwargs: None,
        ClientSession=object,
        web=web,
    )
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
audio_module = importlib.import_module("kestrel_pkg.audio")
media_module = importlib.import_module("kestrel_pkg.media")
config_flow_module = importlib.import_module("kestrel_pkg.config_flow")
reference_module = importlib.import_module("kestrel_pkg.reference_sounds")
reference_photos_module = importlib.import_module("kestrel_pkg.reference_photos")
diagnostics_module = importlib.import_module("kestrel_pkg.diagnostics")

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
        self.bodies: list[object] = []

    async def async_request(self, method: str, path: str, params: dict | None = None, **kwargs: object) -> object:
        self.calls.append(dict(params or {}))
        self.requests.append((method, path))
        self.bodies.append(kwargs.get("json"))
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
