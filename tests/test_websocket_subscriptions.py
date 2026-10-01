"""Dashboard subscriptions (kestrel/subscribe) and the kestrel/visit command.

Runs the real websocket_api.py and coordinator.py with Home Assistant stubbed out
(see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import unittest

from ha_stubs import (
    DISK,
    FRONT,
    STORAGE_KEY,
    HomeAssistant,
    KestrelApiError,
    attach,
    const_module,
    event,
    event_module,
    fired_ids,
    new_coordinator,
    run_poll_loop,
    seen,
    websocket_module,
)

DOMAIN = const_module.DOMAIN


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.subscriptions: dict = {}
        self.events: list[tuple[int, dict]] = []
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_event(self, msg_id: int, event_payload: dict) -> None:
        self.events.append((msg_id, event_payload))

    def send_result(self, msg_id: int, result: object = None) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


def running(script: list, hass: HomeAssistant | None = None) -> tuple:
    """A coordinator registered the way async_setup_entry registers it."""
    hass = hass or HomeAssistant()
    coordinator = new_coordinator(script, hass)
    hass.data.setdefault(DOMAIN, {})["coordinator"] = coordinator
    return hass, coordinator


async def subscribe(hass: HomeAssistant, connection: FakeConnection, msg_id: int = 7) -> None:
    await websocket_module.ws_subscribe(hass, connection, {"id": msg_id, "type": "kestrel/subscribe"})


async def settle() -> None:
    for _ in range(3):  # let the tasks that deliver pushed events run
        await asyncio.sleep(0)


def types_received(connection: FakeConnection) -> list[str]:
    return [payload["type"] for _, payload in connection.events]


class SubscriptionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        DISK.clear()

    async def test_a_subscription_keeps_receiving_after_the_integration_reloads(self) -> None:
        hass, old_coordinator = running([])
        connection = FakeConnection()
        await subscribe(hass, connection)
        self.assertEqual(connection.results, [(7, {"subscribed": True})])

        raccoon = seen("r1", "Raccoon")
        old_coordinator._publish([event("visit_new", raccoon)])
        reloaded = new_coordinator([], hass)  # a config-entry reload replaces the coordinator
        hass.data[DOMAIN]["coordinator"] = reloaded
        reloaded._publish([event("visit_updated", raccoon)])
        await settle()

        self.assertEqual(types_received(connection), ["visit_new", "visit_updated"])
        self.assertTrue(all(msg_id == 7 for msg_id, _ in connection.events))

    async def test_unsubscribing_or_closing_stops_delivery_for_that_connection_only(self) -> None:
        hass, coordinator = running([])
        leaving, staying = FakeConnection(), FakeConnection()
        await subscribe(hass, leaving, 7)
        await subscribe(hass, staying, 3)

        leaving.subscriptions[7]()  # what Home Assistant calls on unsubscribe or when the socket closes
        coordinator._publish([event("visit_new", seen("r1", "Raccoon"))])
        await settle()

        self.assertEqual(leaving.events, [])
        self.assertEqual(types_received(staying), ["visit_new"])

    async def test_every_plugin_event_type_reaches_dashboards_but_only_new_visits_fire_entities(self) -> None:
        DISK[STORAGE_KEY] = {"ids": []}  # not a first run
        raccoon = seen("r1", "Raccoon")
        hass, coordinator = running([{"seq": 5, "events": [
            event("visit_new", raccoon),
            event("visit_updated", raccoon),
            {"type": "visit_deleted", "data": {"id": "f1"}},
            {"type": "camera", "data": {"id": "55"}},
        ]}])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        attach(coordinator, camera_entity)
        connection = FakeConnection()
        await subscribe(hass, connection)

        await run_poll_loop(coordinator)
        await settle()

        self.assertEqual(types_received(connection), ["visit_new", "visit_updated", "visit_deleted", "camera"])
        self.assertEqual(connection.events[2][1]["data"], {"id": "f1"}, "payload passed through untouched")
        self.assertEqual(fired_ids(camera_entity), ["r1"])
        self.assertNotIn("f1", coordinator.announced)

    async def test_media_paths_in_pushed_events_are_signed(self) -> None:
        hass, coordinator = running([])
        connection = FakeConnection()
        await subscribe(hass, connection)

        coordinator._publish([event("visit_new", seen("r1", "Raccoon", snapshot="media/snap/abc.jpg"))])
        await settle()

        self.assertEqual(
            connection.events[0][1]["data"]["snapshot"], "/api/kestrel/media/snap/abc.jpg?authSig=FAKE"
        )

    async def test_subscribing_before_the_integration_is_set_up_is_an_error(self) -> None:
        connection = FakeConnection()
        await subscribe(HomeAssistant(), connection)
        self.assertEqual(connection.errors, [(7, "api_error", "Kestrel is not set up")])
        self.assertEqual(connection.subscriptions, {})


class VisitCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_visit_id_gets_a_plain_error_and_never_reaches_the_plugin(self) -> None:
        hass, coordinator = running([])
        connection = FakeConnection()
        messages = [{}, {"visit_id": None}, {"visit_id": ""}, {"visit_id": "   "}]
        for index, extra in enumerate(messages, start=1):
            message = {"id": index, "type": "kestrel/visit", **extra}
            # Home Assistant logs an error whenever a message fails its schema, so the schema
            # must accept these and the handler must answer them itself.
            websocket_module.ws_visit.ws_schema(message)
            await websocket_module.ws_visit(hass, connection, message)
        self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"] * len(messages))
        self.assertEqual(coordinator.client.requests, [])

    async def test_a_visit_lookup_forwards_the_id_and_maps_an_unknown_id_to_not_found(self) -> None:
        hass, coordinator = running([{"id": "r1", "species": "Raccoon"}, KestrelApiError("Not found", status=404)])
        connection = FakeConnection()
        with self.assertNoLogs(level="ERROR"):
            await websocket_module.ws_visit(hass, connection, {"id": 1, "type": "kestrel/visit", "visit_id": "r1"})
            await websocket_module.ws_visit(hass, connection, {"id": 2, "type": "kestrel/visit", "visit_id": "nope"})
        self.assertEqual(coordinator.client.requests, [("GET", "visits/r1"), ("GET", "visits/nope")])
        self.assertEqual(connection.results, [(1, {"id": "r1", "species": "Raccoon"})])
        self.assertEqual(connection.errors, [(2, "not_found", "Not found")])


if __name__ == "__main__":
    unittest.main()
