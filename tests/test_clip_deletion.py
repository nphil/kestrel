"""Deleting saved camera clips from settings: the storage numbers (anyone may look) and the delete command (administrators only).

Runs the real websocket_api.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import types
import unittest

import voluptuous as vol
from ha_stubs import HomeAssistant, KestrelApiError, const_module, new_coordinator, websocket_module

DOMAIN = const_module.DOMAIN
STORAGE = {
    "count": 312,
    "bytes": 1_500_000_000,
    "oldestAt": 1_772_000_000_000,
    "byReason": {"notAnimal": {"count": 9, "bytes": 40_000_000}, "unconfirmed": {"count": 21, "bytes": 90_000_000}},
}


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self, *, admin: bool = True) -> None:
        self.user = types.SimpleNamespace(is_admin=admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object = None) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


def running(script: list) -> tuple:
    hass = HomeAssistant()
    coordinator = new_coordinator(script, hass)
    hass.data.setdefault(DOMAIN, {})["coordinator"] = coordinator
    return hass, coordinator


class ClipStorageTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_numbers_come_from_the_plugin_and_an_admin_is_told_they_may_delete(self) -> None:
        hass, coordinator = running([dict(STORAGE)])
        connection = FakeConnection(admin=True)
        await websocket_module.ws_clips_storage(hass, connection, {"id": 1, "type": "kestrel/clips/storage"})
        self.assertEqual(coordinator.client.requests, [("GET", "clips/storage")])
        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, {**STORAGE, "canDelete": True})])

    async def test_an_age_limit_is_forwarded_so_the_numbers_say_what_deleting_would_remove(self) -> None:
        hass, coordinator = running([{"count": 48, "bytes": 210_000_000, "oldestAt": 1_772_000_000_000}])
        connection = FakeConnection()
        message = {"id": 2, "type": "kestrel/clips/storage", "older_than": 1_760_000_000_000}
        websocket_module.ws_clips_storage.ws_schema(message)
        await websocket_module.ws_clips_storage(hass, connection, message)
        self.assertEqual(coordinator.client.calls, [{"olderThan": 1_760_000_000_000}])
        self.assertEqual(connection.results[0][1]["count"], 48)

    async def test_a_bad_age_limit_is_refused_before_the_plugin(self) -> None:
        for bad in (0, -1, True):
            hass, coordinator = running([])
            connection = FakeConnection()
            await websocket_module.ws_clips_storage(hass, connection, {"id": 2, "type": "kestrel/clips/storage", "older_than": bad})
            self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"])
            self.assertEqual(coordinator.client.requests, [])

    async def test_anyone_may_look_but_a_non_admin_is_told_they_may_not_delete(self) -> None:
        hass, _ = running([dict(STORAGE)])
        connection = FakeConnection(admin=False)
        await websocket_module.ws_clips_storage(hass, connection, {"id": 1, "type": "kestrel/clips/storage"})
        self.assertEqual(connection.results[0][1]["canDelete"], False)
        self.assertEqual(connection.results[0][1]["count"], 312)

    async def test_a_plugin_error_is_passed_on(self) -> None:
        hass, _ = running([KestrelApiError("Kestrel plugin unreachable")])
        connection = FakeConnection()
        await websocket_module.ws_clips_storage(hass, connection, {"id": 1, "type": "kestrel/clips/storage"})
        self.assertEqual(connection.results, [])
        self.assertEqual([message for _, _, message in connection.errors], ["Kestrel plugin unreachable"])


class ClipDeleteTests(unittest.IsolatedAsyncioTestCase):
    async def delete(self, script: list, *, admin: bool = True, **extra: object) -> tuple:
        hass, coordinator = running(script)
        connection = FakeConnection(admin=admin)
        message = {"id": 3, "type": "kestrel/clips/delete", **extra}
        websocket_module.ws_clips_delete.ws_schema(message)
        await websocket_module.ws_clips_delete(hass, connection, message)
        return connection, coordinator.client

    async def test_each_way_of_choosing_is_forwarded_to_the_plugin_in_its_own_words(self) -> None:
        cases = [
            ({"visit_ids": ["a", "b"]}, {"visitIds": ["a", "b"]}),
            ({"older_than": 1_700_000_000_000}, {"olderThan": 1_700_000_000_000}),
            ({"reason": "notAnimal"}, {"reason": "notAnimal"}),
        ]
        for extra, body in cases:
            with self.subTest(extra=extra):
                connection, client = await self.delete([{"deleted": 4, "freedBytes": 1234}], **extra)
                self.assertEqual(connection.errors, [])
                self.assertEqual(client.requests, [("POST", "clips/delete")])
                self.assertEqual(client.bodies, [body])
                self.assertEqual(connection.results, [(3, {"deleted": 4, "freedBytes": 1234})])

    async def test_a_reason_the_plugin_does_not_know_is_refused_before_it(self) -> None:
        connection, client = await self.delete([], reason="unconfirmed")
        self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"])
        self.assertEqual(client.requests, [])

    async def test_only_an_administrator_may_delete_and_nothing_reaches_the_plugin_otherwise(self) -> None:
        connection, client = await self.delete([], admin=False, visit_ids=["a"])
        self.assertEqual([code for _, code, _ in connection.errors], ["unauthorized"])
        self.assertEqual(connection.results, [])
        self.assertEqual(client.requests, [])

    async def test_exactly_one_way_of_choosing_is_needed(self) -> None:
        bad = [
            {},
            {"visit_ids": ["a"], "reason": "notAnimal"},
            {"older_than": 1_700_000_000_000, "reason": "notAnimal"},
            {"visit_ids": ["a"], "older_than": 1_700_000_000_000, "reason": "notAnimal"},
        ]
        for extra in bad:
            with self.subTest(extra=extra):
                connection, client = await self.delete([], **extra)
                self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"])
                self.assertEqual(client.requests, [])

    async def test_empty_or_unknown_choices_are_refused_before_the_plugin(self) -> None:
        bad = [{"visit_ids": []}, {"visit_ids": ["  "]}, {"older_than": 0}, {"older_than": -5}, {"older_than": True}, {"reason": "everything"}]
        for extra in bad:
            with self.subTest(extra=extra):
                connection, client = await self.delete([], **extra)
                self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"])
                self.assertEqual(client.requests, [])

    async def test_a_plugin_error_is_an_error_not_a_pretend_success(self) -> None:
        connection, _ = await self.delete([KestrelApiError("Kestrel plugin unreachable")], reason="notAnimal")
        self.assertEqual(connection.results, [])
        self.assertEqual([message for _, _, message in connection.errors], ["Kestrel plugin unreachable"])

    def test_the_schema_rejects_values_of_the_wrong_kind(self) -> None:
        schema = websocket_module.ws_clips_delete.ws_schema
        for bad in ({"visit_ids": "a"}, {"visit_ids": [1]}, {"older_than": "soon"}, {"reason": 5}):
            with self.assertRaises(vol.Invalid):
                schema({"id": 1, "type": "kestrel/clips/delete", **bad})


if __name__ == "__main__":
    unittest.main()
