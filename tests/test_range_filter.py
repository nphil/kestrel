"""The local species filter setting: read BirdNET-Go's strictness, change it without touching anything else.

Runs the real range_filter.py and websocket_api.py against a fake BirdNET-Go with Home Assistant
stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import importlib
import math
import types
import unittest

import voluptuous as vol
from ha_stubs import SESSION, FakeResponse, FakeSession, HomeAssistant, const_module, websocket_module

range_filter = importlib.import_module("kestrel_pkg.range_filter")
API = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2"
TOKEN = "tok3n-AbCdEfGh12345678=="


class FakeBirdNetGo(FakeSession):
    """BirdNET-Go's settings and range-filter endpoints, with its real quirks: a write needs the CSRF token
    in a header AND a cookie, the species list is its own output, and the count changes only after a rebuild."""

    def __init__(self, threshold: float = 0.01, species: int = 370) -> None:
        super().__init__()
        self.range_filter = {
            "model": "latest",
            "modelPath": "",
            "labelsPath": "",
            "threshold": threshold,
            "passUnmappedSpecies": False,
            "species": [f"Species {n}" for n in range(species)],
            "lastUpdated": "2026-10-03T06:00:00Z",
        }
        self.rebuilds_after_write = True
        self.refuse_writes = False

    def _count(self) -> FakeResponse:
        return FakeResponse(
            200,
            {
                "count": len(self.range_filter["species"]),
                "lastUpdated": self.range_filter["lastUpdated"],
                "threshold": self.range_filter["threshold"],
                "location": {"latitude": 44.5, "longitude": -76.5},
            },
        )

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        if (method, url) == ("GET", f"{API}/range/species/count"):
            return self._count()
        if (method, url) == ("GET", f"{API}/app/config"):
            return FakeResponse(200, {"csrfToken": TOKEN})
        if (method, url) == ("GET", f"{API}/settings/birdnet"):
            return FakeResponse(200, {"latitude": 44.5, "longitude": -76.5, "rangeFilter": copy.deepcopy(self.range_filter)})
        if (method, url) == ("PATCH", f"{API}/settings/birdnet"):
            headers = kwargs["headers"]
            if self.refuse_writes or headers.get("X-CSRF-Token") != TOKEN or headers.get("Cookie") != f"csrf={TOKEN}":
                return FakeResponse(403, {"error": "forbidden"})
            sent = kwargs["json"]["rangeFilter"]
            self.range_filter["threshold"] = sent["threshold"]
            if self.rebuilds_after_write:
                # A looser filter lets more species through.
                self.range_filter["species"] = [f"Species {n}" for n in range(round(1.2 / sent["threshold"]))]
                self.range_filter["lastUpdated"] = "2026-10-03T07:00:00Z"
            return FakeResponse(200, {"success": True})
        return FakeResponse(404, {"error": "not_found"})

    def writes(self) -> list[dict]:
        return self.calls_to("PATCH", f"{API}/settings/birdnet")


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self, *, admin: bool = True) -> None:
        self.user = types.SimpleNamespace(is_admin=admin)
        self.results: list[tuple[int, dict]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: dict) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class SpeciesFilterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.birdnet = FakeBirdNetGo()
        SESSION["session"] = self.birdnet
        self.hass = HomeAssistant()
        self._poll = range_filter._REBUILD_POLL_S
        range_filter._REBUILD_POLL_S = 0

    def tearDown(self) -> None:
        range_filter._REBUILD_POLL_S = self._poll

    async def set_threshold(self, threshold: object, *, admin: bool = True) -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await websocket_module.ws_range_filter_set(
            self.hass, connection, {"id": 5, "type": "kestrel/range_filter/set", "threshold": threshold}
        )
        return connection

    async def test_reading_says_how_strict_the_filter_is_and_how_many_species_it_allows(self) -> None:
        connection = FakeConnection()
        await websocket_module.ws_range_filter_get(self.hass, connection, {"id": 4, "type": "kestrel/range_filter/get"})
        self.assertEqual(connection.errors, [])
        (_, result), = connection.results
        self.assertEqual(result["threshold"], 0.01)
        self.assertEqual(result["speciesCount"], 370)
        self.assertEqual((result["latitude"], result["longitude"]), (44.5, -76.5))
        self.assertTrue(result["canChange"])
        self.assertFalse(result["rebuilding"])

    async def test_anyone_may_look_but_the_page_is_told_a_non_admin_cannot_change_it(self) -> None:
        connection = FakeConnection(admin=False)
        await websocket_module.ws_range_filter_get(self.hass, connection, {"id": 4, "type": "kestrel/range_filter/get"})
        self.assertFalse(connection.results[0][1]["canChange"])

    async def test_changing_it_writes_only_the_threshold_and_keeps_every_other_setting(self) -> None:
        connection = await self.set_threshold(0.05)
        self.assertEqual(connection.errors, [])
        (write,) = self.birdnet.writes()
        # BirdNET-Go's own species list is not sent back (it refuses to take it); nothing else is lost.
        self.assertEqual(
            write["json"],
            {
                "rangeFilter": {
                    "model": "latest",
                    "modelPath": "",
                    "labelsPath": "",
                    "threshold": 0.05,
                    "passUnmappedSpecies": False,
                    "lastUpdated": "2026-10-03T06:00:00Z",
                }
            },
        )

    async def test_the_security_token_goes_in_both_the_header_and_the_cookie(self) -> None:
        await self.set_threshold(0.03)
        (write,) = self.birdnet.writes()
        self.assertEqual(write["headers"]["X-CSRF-Token"], TOKEN)
        self.assertEqual(write["headers"]["Cookie"], f"csrf={TOKEN}")

    async def test_the_answer_is_the_new_state_once_birdnet_go_has_rebuilt_its_list(self) -> None:
        connection = await self.set_threshold(0.05)
        (_, result), = connection.results
        self.assertEqual(result["threshold"], 0.05)
        self.assertEqual(result["speciesCount"], 24)  # the fake's count for 5%, not the old 370
        self.assertFalse(result["rebuilding"])

    async def test_a_rebuild_that_is_slow_is_reported_as_still_going_not_as_the_old_count(self) -> None:
        self.birdnet.rebuilds_after_write = False
        connection = await self.set_threshold(0.05)
        (_, result), = connection.results
        self.assertEqual(result["threshold"], 0.05)
        self.assertTrue(result["rebuilding"])

    async def test_choosing_what_is_already_set_changes_nothing(self) -> None:
        connection = await self.set_threshold(0.01)
        self.assertEqual(self.birdnet.writes(), [])
        self.assertEqual(connection.results[0][1]["speciesCount"], 370)

    async def test_values_outside_the_range_or_not_numbers_are_refused_before_anything_is_sent(self) -> None:
        for bad in (0.001, 0.0, -0.03, 0.51, 3, True, "0.03", None, math.nan, math.inf):
            connection = await self.set_threshold(bad)
            self.assertEqual(connection.results, [], bad)
            self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"], bad)
        self.assertEqual(self.birdnet.calls, [])

    async def test_the_ends_of_the_range_are_allowed(self) -> None:
        for edge in (range_filter.MIN_THRESHOLD, range_filter.MAX_THRESHOLD):
            connection = await self.set_threshold(edge)
            self.assertEqual(connection.errors, [], edge)
            self.assertEqual(self.birdnet.range_filter["threshold"], edge)

    async def test_only_an_administrator_may_change_it(self) -> None:
        connection = await self.set_threshold(0.05, admin=False)
        self.assertEqual([code for _, code, _ in connection.errors], ["unauthorized"])
        self.assertEqual(self.birdnet.calls, [])

    async def test_birdnet_go_refusing_the_write_is_an_error_not_a_pretend_success(self) -> None:
        self.birdnet.refuse_writes = True
        connection = await self.set_threshold(0.05)
        self.assertEqual(connection.results, [])
        self.assertEqual(len(connection.errors), 1)
        self.assertEqual(self.birdnet.range_filter["threshold"], 0.01)

    async def test_an_unreachable_birdnet_go_is_an_error(self) -> None:
        down = FakeSession()
        down.route("GET", f"{API}/range/species/count", TimeoutError())
        SESSION["session"] = down
        connection = FakeConnection()
        await websocket_module.ws_range_filter_get(self.hass, connection, {"id": 4, "type": "kestrel/range_filter/get"})
        self.assertEqual(connection.results, [])
        self.assertEqual([message for _, _, message in connection.errors], ["Could not reach BirdNET-Go"])

    def test_the_command_needs_a_number(self) -> None:
        schema = websocket_module.ws_range_filter_set.ws_schema
        schema({"id": 1, "type": "kestrel/range_filter/set", "threshold": 0.03})
        for bad in ({}, {"threshold": "high"}, {"threshold": [0.03]}):
            with self.assertRaises(vol.Invalid):
                schema({"id": 1, "type": "kestrel/range_filter/set", **bad})
