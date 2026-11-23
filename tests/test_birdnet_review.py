"""Telling BirdNET-Go about a correction: confirm / correct / undo of a heard visit reaches BirdNET-Go after the undo window.

Runs the real birdnet_review.py, birdnet_api.py and websocket_api.py against a fake BirdNET-Go (its detection, review and
species endpoints, with the CSRF token, locks and refusals) with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import importlib
import json
import types
import unittest

from ha_stubs import (
    SESSION,
    FakeResponse,
    FakeSession,
    HomeAssistant,
    const_module,
    diagnostics_module,
    new_coordinator,
    websocket_module,
)

import aiohttp  # the stub ha_stubs installs

birdnet_review = importlib.import_module("kestrel_pkg.birdnet_review")
DOMAIN = const_module.DOMAIN
API = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2"
TOKEN = "tok3n-AbCdEfGh12345678=="
JAY = "Cyanocitta cristata"
GOOSE = "Branta canadensis"
KNOWN_SPECIES = {JAY, GOOSE}


class FakeBirdNetGo(FakeSession):
    """BirdNET-Go's detection, review and species endpoints as the real ones behave: a write needs the CSRF token as a header
    AND a cookie, a locked detection answers 409, an unknown species 400, an unknown detection 404. `fail` makes one
    request (method, last part of the path) answer a chosen status, or raise a network error."""

    def __init__(self) -> None:
        super().__init__()
        self.detections: dict[int, dict] = {}
        self.fail: dict[tuple[str, str], object] = {}

    def add(self, detection_id: int, *, verified: str = "unverified", scientific: str = JAY, locked: bool = False) -> None:
        self.detections[detection_id] = {
            "id": detection_id, "commonName": "Blue Jay", "scientificName": scientific, "verified": verified, "locked": locked,
        }

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        if (method, url) == ("GET", f"{API}/app/config"):
            return FakeResponse(200, {"csrfToken": TOKEN, "version": "20261122"})
        prefix = f"{API}/detections/"
        if not url.startswith(prefix):
            return FakeResponse(404, {"error": "not_found"})
        number, _, tail = url[len(prefix):].partition("/")
        failure = self.fail.get((method, tail))
        if isinstance(failure, Exception):
            raise failure
        if isinstance(failure, int):
            return FakeResponse(failure, {"error": "refused"})
        detection = self.detections.get(int(number))
        if detection is None:
            return FakeResponse(404, {"error": "Detection not found"})
        if method == "GET" and not tail:
            return FakeResponse(200, dict(detection))
        headers = kwargs["headers"] or {}
        if headers.get("X-CSRF-Token") != TOKEN or headers.get("Cookie") != f"csrf={TOKEN}":
            return FakeResponse(403, {"error": "forbidden"})
        if detection["locked"]:
            return FakeResponse(409, {"error": "Detection is locked and status cannot be changed"})
        body = kwargs["json"]
        if (method, tail) == ("POST", "review"):
            if body.get("verified") not in ("correct", "false_positive"):
                return FakeResponse(400, {"error": "bad status"})
            detection["verified"] = body["verified"]
            return FakeResponse(200, {"status": "success"})
        if (method, tail) == ("PUT", "species"):
            if body.get("scientificName") not in KNOWN_SPECIES:
                return FakeResponse(400, {"error": "unknown species"})
            detection["scientificName"] = body["scientificName"]
            detection["verified"] = "correct"  # BirdNET-Go marks a species change correct
            return FakeResponse(200, {"status": "success"})
        return FakeResponse(404, {"error": "not_found"})

    def writes(self) -> list[tuple[str, str, object]]:
        """Every call that is not a plain read: (method, path after /detections/, body)."""
        found = []
        for method, url, kwargs in self.calls:
            if method != "GET":
                found.append((method, url.removeprefix(f"{API}/detections/"), kwargs.get("json")))
        return found

    def review_calls(self) -> list[str]:
        """The calls about detections and the token. (A visit going through the handlers also gets Kestrel's own audio
        availability check, which is not part of this feature.)"""
        return [path for path in self.paths() if "/detections/" in path or "/app/config" in path]

    def paths(self) -> list[str]:
        return [f"{method} {url.removeprefix(API)}" for method, url, _ in self.calls]


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self, *, admin: bool = True) -> None:
        self.user = types.SimpleNamespace(is_admin=admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


def heard(detection_id: object = 360, visit_id: str = "h1") -> dict:
    return {"id": visit_id, "kind": "heard", "species": "Blue Jay", "audio": {"birdnetDetectionId": detection_id, "birdnetClip": "2026/11/x.opus"}}


def seen(visit_id: str = "s1") -> dict:
    return {"id": visit_id, "kind": "seen", "species": "Blue Jay", "heard": {"birdnetDetectionId": 360}}


class ReviewTestCase(unittest.IsolatedAsyncioTestCase):
    GRACE = 0

    def setUp(self) -> None:
        self.birdnet = FakeBirdNetGo()
        SESSION["session"] = self.birdnet
        self.hass = HomeAssistant()
        self.visit: object = heard()
        self.plugin_calls: list[tuple[str, str]] = []

        async def async_request(method: str, path: str, **kwargs: object) -> object:
            self.plugin_calls.append((method, path))
            if isinstance(self.visit, Exception):
                raise self.visit
            return self.visit

        self.hass.data[DOMAIN] = {
            "coordinator": types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request)),
            "birdnet_species_map": {"canada goose": GOOSE, "blue jay": JAY},
        }
        self.service = birdnet_review.BirdnetReviews(self.hass, grace_s=self.GRACE)
        self.hass.data[DOMAIN]["birdnet_reviews"] = self.service
        self.birdnet.add(360)

    async def asyncTearDown(self) -> None:
        await self.service.async_stop()

    async def settle(self) -> None:
        """Let every queued write finish."""
        while self.service._tasks:
            await asyncio.gather(*list(self.service._tasks), return_exceptions=True)

    def entries(self) -> list[dict]:
        return self.service.diagnostics()["recent"]

    def last(self) -> dict:
        return self.entries()[-1]


class WritesTests(ReviewTestCase):
    async def test_a_confirm_marks_the_detection_correct_after_the_wait(self) -> None:
        self.service.visit_action("confirm", heard())
        self.assertEqual(self.birdnet.calls, [], "nothing goes out until the undo window is over")
        await self.settle()
        self.assertEqual(self.birdnet.paths(), ["GET /detections/360", "GET /app/config", "POST /detections/360/review"])
        self.assertEqual(self.birdnet.writes(), [("POST", "360/review", {"verified": "correct"})])
        self.assertEqual(self.birdnet.detections[360]["verified"], "correct")
        self.assertEqual((self.last()["outcome"], self.last()["visitId"], self.last()["detectionId"]), ("sent", "h1", 360))

    async def test_not_an_animal_is_a_false_positive(self) -> None:
        self.service.visit_action("correct", heard(), "not_animal")
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("POST", "360/review", {"verified": "false_positive"})])
        self.assertEqual(self.last()["outcome"], "sent")

    async def test_a_real_species_changes_the_detections_species_by_its_scientific_name(self) -> None:
        self.service.visit_action("correct", heard(), "Canada Goose")
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": GOOSE})])
        self.assertEqual(self.birdnet.detections[360]["scientificName"], GOOSE)
        self.assertEqual(self.last()["outcome"], "sent")

    async def test_the_species_the_panel_sends_may_have_stray_spaces(self) -> None:
        self.service.visit_action("correct", heard(), "  Canada Goose ")
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": GOOSE})])

    async def test_a_species_with_no_scientific_name_is_skipped_and_noted(self) -> None:
        self.service.visit_action("correct", heard(), "Purple Unicorn")
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual((self.last()["outcome"], self.last()["detail"]), ("skipped", "no scientific name for Purple Unicorn"))

    async def test_cant_tell_has_no_birdnet_equivalent_and_is_noted(self) -> None:
        self.service.visit_action("correct", heard(), "unknown")
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.last()["outcome"], "skipped")
        self.assertIn("unknown has no BirdNET-Go equivalent", self.last()["detail"])

    async def test_cant_tell_after_a_waiting_confirm_drops_the_confirm(self) -> None:
        self.service.visit_action("confirm", heard())
        self.service.visit_action("correct", heard(), "unknown")
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual([entry["outcome"] for entry in self.entries()], ["cancelled", "skipped"])

    async def test_the_last_action_on_a_visit_wins(self) -> None:
        self.service.visit_action("confirm", heard())
        self.service.visit_action("correct", heard(), "Canada Goose")
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": GOOSE})])
        self.assertEqual([entry["outcome"] for entry in self.entries()], ["cancelled", "sent"])

    async def test_two_visits_are_written_independently(self) -> None:
        self.birdnet.add(361)
        self.service.visit_action("confirm", heard(360, "h1"))
        self.service.visit_action("correct", heard(361, "h2"), "not_animal")
        await self.settle()
        self.assertEqual(
            sorted(self.birdnet.writes(), key=lambda write: write[1]),
            [("POST", "360/review", {"verified": "correct"}), ("POST", "361/review", {"verified": "false_positive"})],
        )


class IgnoredTests(ReviewTestCase):
    async def assert_nothing(self, action: str, visit: object, species: str | None = None) -> None:
        self.service.visit_action(action, visit, species)
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.entries(), [])

    async def test_a_seen_visit_is_ignored(self) -> None:
        await self.assert_nothing("confirm", seen())
        await self.assert_nothing("correct", seen(), "Canada Goose")
        await self.assert_nothing("undo", seen())

    async def test_detection_id_zero_and_missing_ids_are_ignored(self) -> None:
        await self.assert_nothing("confirm", heard(0))
        await self.assert_nothing("confirm", heard(None))
        await self.assert_nothing("confirm", heard(True))
        await self.assert_nothing("confirm", heard("360"))
        await self.assert_nothing("confirm", {"id": "h1", "kind": "heard", "species": "Blue Jay"})

    async def test_not_a_visit_is_ignored(self) -> None:
        await self.assert_nothing("confirm", None)
        await self.assert_nothing("confirm", [heard()])
        await self.assert_nothing("confirm", {"kind": "heard", "audio": {"birdnetDetectionId": 360}})

    async def test_an_unknown_action_or_an_empty_species_does_nothing(self) -> None:
        await self.assert_nothing("rename", heard())
        await self.assert_nothing("correct", heard(), "   ")
        await self.assert_nothing("correct", heard(), None)

    async def test_an_undo_with_nothing_sent_or_waiting_does_nothing(self) -> None:
        await self.assert_nothing("undo", heard())


class UndoTests(ReviewTestCase):
    GRACE = 30  # long: these tests act inside the window

    async def test_an_undo_inside_the_wait_means_nothing_is_ever_sent(self) -> None:
        self.service.visit_action("confirm", heard())
        self.assertEqual(self.service.diagnostics()["waiting"], 1)
        self.service.visit_action("undo", heard())
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.service.diagnostics()["waiting"], 0)
        self.assertEqual((self.last()["outcome"], self.last()["detail"]), ("cancelled", "undone before it was sent"))

    async def test_stopping_cancels_the_waiting_writes_and_leaves_no_task(self) -> None:
        self.service.visit_action("confirm", heard())
        self.service.visit_action("correct", heard(361, "h2"), "Canada Goose")
        tasks = list(self.service._tasks)
        self.assertEqual(len(tasks), 2)
        await self.service.async_stop()
        self.assertTrue(all(task.cancelled() for task in tasks))
        self.assertEqual(self.service._tasks, set())
        self.assertEqual(self.birdnet.calls, [])


class RevertTests(ReviewTestCase):
    """An undo that comes after the write (it should not, but the clocks of two machines are what they are)."""

    async def sent_then_undone(self, action: str = "confirm", species: str | None = None) -> None:
        self.service.visit_action(action, heard(), species)
        await self.settle()
        self.assertEqual(self.last()["outcome"], "sent")
        self.birdnet.calls.clear()
        self.service.visit_action("undo", heard())
        await self.settle()

    async def test_the_old_verdict_is_put_back(self) -> None:
        self.birdnet.add(360, verified="false_positive")
        await self.sent_then_undone("confirm")
        self.assertEqual(self.birdnet.writes(), [("POST", "360/review", {"verified": "false_positive"})])
        self.assertEqual(self.birdnet.detections[360]["verified"], "false_positive")
        self.assertEqual(self.last()["outcome"], "reverted")

    async def test_a_not_an_animal_over_a_correct_goes_back_to_correct(self) -> None:
        self.birdnet.add(360, verified="correct")
        await self.sent_then_undone("correct", "not_animal")
        self.assertEqual(self.birdnet.writes(), [("POST", "360/review", {"verified": "correct"})])
        self.assertEqual(self.last()["outcome"], "reverted")

    async def test_the_old_species_is_put_back(self) -> None:
        self.birdnet.add(360, verified="correct", scientific=JAY)
        await self.sent_then_undone("correct", "Canada Goose")
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": JAY})])
        self.assertEqual(self.birdnet.detections[360]["scientificName"], JAY)
        self.assertEqual(self.last()["outcome"], "reverted")

    async def test_a_review_that_was_not_there_before_cannot_be_cleared_and_diagnostics_says_so(self) -> None:
        await self.sent_then_undone("confirm")  # before: unverified
        self.assertEqual(self.birdnet.writes(), [])
        self.assertEqual(self.birdnet.detections[360]["verified"], "correct")
        self.assertEqual(self.last()["outcome"], "skipped")
        self.assertEqual(self.last()["detail"], "BirdNET-Go cannot clear a review; left as correct")

    async def test_a_species_put_back_from_unreviewed_also_says_the_review_stays(self) -> None:
        await self.sent_then_undone("correct", "Canada Goose")
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": JAY})])
        self.assertEqual(self.last()["outcome"], "reverted")
        self.assertIn("species put back to " + JAY, self.last()["detail"])
        self.assertIn("BirdNET-Go cannot clear a review; left as correct", self.last()["detail"])

    async def test_confirming_what_was_already_correct_has_nothing_to_undo(self) -> None:
        self.birdnet.add(360, verified="correct")
        await self.sent_then_undone("confirm")
        self.assertEqual(self.birdnet.writes(), [])
        self.assertEqual(self.last()["outcome"], "reverted")

    async def test_only_the_latest_write_of_a_visit_is_taken_back_once(self) -> None:
        self.birdnet.add(360, verified="false_positive")
        await self.sent_then_undone("confirm")
        self.birdnet.calls.clear()
        self.service.visit_action("undo", heard())
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])

    async def test_an_undo_long_after_the_write_leaves_birdnet_go_alone(self) -> None:
        self.birdnet.add(360, verified="false_positive")
        self.service.visit_action("confirm", heard())
        await self.settle()
        self.service._sent["h1"].at -= birdnet_review.REVERT_WINDOW_S + 1
        self.birdnet.calls.clear()
        self.service.visit_action("undo", heard())
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.birdnet.detections[360]["verified"], "correct")

    async def test_a_refused_revert_is_a_failed_entry_not_an_error(self) -> None:
        self.birdnet.add(360, verified="false_positive")
        self.service.visit_action("confirm", heard())
        await self.settle()
        self.birdnet.fail[("POST", "review")] = 500
        self.service.visit_action("undo", heard())
        await self.settle()
        self.assertEqual(self.last()["outcome"], "failed")


class LockedTests(ReviewTestCase):
    async def test_a_kept_recording_is_never_changed_and_never_unlocked(self) -> None:
        self.birdnet.add(360, locked=True)
        for action, species in (("confirm", None), ("correct", "not_animal"), ("correct", "Canada Goose")):
            self.service.visit_action(action, heard(), species)
            await self.settle()
            self.assertEqual((self.last()["outcome"], self.last()["detail"]), ("skipped", birdnet_review.KEPT_NOTE))
        self.assertEqual(self.birdnet.writes(), [], "no review, no species change and no unlock")
        self.assertFalse(any(url.endswith("/lock") for _, url, _ in self.birdnet.calls))
        self.assertTrue(self.birdnet.detections[360]["locked"])

    async def test_a_409_on_the_write_is_also_the_kept_note(self) -> None:
        self.birdnet.fail[("POST", "review")] = 409
        self.service.visit_action("confirm", heard())
        await self.settle()
        self.assertEqual((self.last()["outcome"], self.last()["detail"]), ("skipped", birdnet_review.KEPT_NOTE))
        self.assertEqual([write[0] for write in self.birdnet.writes()], ["POST"], "tried once, and did not try to unlock")

    async def test_a_409_on_a_species_change_also_mentions_the_v2_database(self) -> None:
        self.birdnet.fail[("PUT", "species")] = 409
        self.service.visit_action("correct", heard(), "Canada Goose")
        await self.settle()
        self.assertEqual(self.last()["outcome"], "skipped")
        self.assertIn(birdnet_review.KEPT_NOTE, self.last()["detail"])
        self.assertIn("v2 database", self.last()["detail"])


class FailureTests(ReviewTestCase):
    async def test_every_failure_is_a_failed_entry_and_nothing_escapes(self) -> None:
        cases = {
            "review 400": (("POST", "review"), 400, "refused it as invalid"),
            "review 404": (("POST", "review"), 404, "no detection 360"),
            "review 500": (("POST", "review"), 500, "HTTP 500"),
            "review network": (("POST", "review"), aiohttp.ClientError("boom"), "Could not reach BirdNET-Go"),
            "read 404": (("GET", ""), 404, "no detection 360"),
            "read network": (("GET", ""), aiohttp.ClientError("boom"), "Could not reach BirdNET-Go"),
            "read 500": (("GET", ""), 500, "HTTP 500"),
        }
        for name, (key, failure, expected) in cases.items():
            with self.subTest(name):
                self.birdnet.fail = {key: failure}
                self.birdnet.calls.clear()
                self.service.visit_action("confirm", heard())
                await self.settle()
                self.assertEqual(self.last()["outcome"], "failed")
                self.assertIn(expected, self.last()["detail"])
                self.assertEqual(self.birdnet.detections[360]["verified"], "unverified")

    async def test_a_species_birdnet_go_does_not_know_is_a_failed_entry(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"]["odd bird"] = "Nonexistus birdus"
        self.service.visit_action("correct", heard(), "Odd Bird")
        await self.settle()
        self.assertEqual(self.last()["outcome"], "failed")
        self.assertIn("unknown species", self.last()["detail"])

    async def test_an_answer_that_is_not_a_detection_is_a_failed_entry(self) -> None:
        self.birdnet.detections[360] = []  # type: ignore[assignment]
        original = self.birdnet.request

        def odd(method: str, url: str, **kwargs: object) -> FakeResponse:
            if (method, url) == ("GET", f"{API}/detections/360"):
                self.birdnet.calls.append((method, url, kwargs))
                return FakeResponse(200, ["not", "a", "detection"])
            return original(method, url, **kwargs)

        self.birdnet.request = odd  # type: ignore[method-assign]
        self.service.visit_action("confirm", heard())
        await self.settle()
        self.assertEqual(self.last()["outcome"], "failed")

    async def test_a_bug_inside_the_service_is_logged_not_raised(self) -> None:
        async def broken(*args: object, **kwargs: object) -> object:
            raise RuntimeError("bug")

        original = birdnet_review.birdnet_api.async_request
        birdnet_review.birdnet_api.async_request = broken
        try:
            with self.assertLogs("kestrel_pkg.birdnet_review", level="WARNING"):
                self.service.visit_action("confirm", heard())
                await self.settle()
        finally:
            birdnet_review.birdnet_api.async_request = original
        self.assertEqual(self.last()["outcome"], "failed")

    async def test_a_failure_is_logged_once_per_attempt_without_a_stack(self) -> None:
        self.birdnet.fail[("POST", "review")] = 500
        with self.assertLogs("kestrel_pkg.birdnet_review", level="WARNING") as logs:
            self.service.visit_action("confirm", heard())
            await self.settle()
        self.assertEqual(len(logs.records), 1)
        self.assertIsNone(logs.records[0].exc_info)

    async def test_a_hostile_visit_payload_never_raises(self) -> None:
        for visit in ({"id": "h1", "kind": "heard", "audio": "x"}, {"id": 5, "kind": "heard", "audio": {"birdnetDetectionId": 360}}):
            self.service.visit_action("confirm", visit)
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])


class WebsocketTests(ReviewTestCase):
    """The three handlers: same answers for the panel as before, BirdNET-Go told off the request path, admins only."""

    async def call(self, handler: object, msg: dict, *, admin: bool = True) -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await handler(self.hass, connection, {"id": 7, **msg})  # type: ignore[operator]
        return connection

    async def test_confirm_answers_the_panel_at_once_and_birdnet_go_hears_later(self) -> None:
        self.service._grace_s = 30
        connection = await self.call(websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"})
        self.assertEqual((connection.errors, len(connection.results)), ([], 1))
        self.assertEqual(self.plugin_calls, [("POST", "visits/h1/confirm")])
        self.assertEqual(self.birdnet.review_calls(), [], "the handler does not wait for BirdNET-Go")
        self.assertEqual(self.service.diagnostics()["waiting"], 1)

    async def test_with_no_wait_the_confirm_reaches_birdnet_go(self) -> None:
        await self.call(websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"})
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("POST", "360/review", {"verified": "correct"})])

    async def test_correct_passes_the_species_and_undo_passes_the_undo(self) -> None:
        await self.call(websocket_module.ws_visit_correct, {"type": "kestrel/visit/correct", "visit_id": "h1", "species": "Canada Goose"})
        await self.settle()
        self.assertEqual(self.birdnet.writes(), [("PUT", "360/species", {"scientificName": GOOSE})])
        self.birdnet.calls.clear()
        await self.call(websocket_module.ws_visit_undo, {"type": "kestrel/visit/undo", "visit_id": "h1"})
        await self.settle()
        self.assertEqual(self.last()["outcome"], "reverted")

    async def test_an_undo_in_the_window_through_the_handlers_sends_nothing(self) -> None:
        self.service._grace_s = 30
        await self.call(websocket_module.ws_visit_correct, {"type": "kestrel/visit/correct", "visit_id": "h1", "species": "not_animal"})
        await self.call(websocket_module.ws_visit_undo, {"type": "kestrel/visit/undo", "visit_id": "h1"})
        await self.settle()
        self.assertEqual(self.birdnet.review_calls(), [])
        self.assertEqual(self.last()["outcome"], "cancelled")

    async def test_a_non_admin_is_answered_normally_and_nothing_is_sent(self) -> None:
        for handler, msg in (
            (websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"}),
            (websocket_module.ws_visit_correct, {"type": "kestrel/visit/correct", "visit_id": "h1", "species": "not_animal"}),
            (websocket_module.ws_visit_undo, {"type": "kestrel/visit/undo", "visit_id": "h1"}),
        ):
            connection = await self.call(handler, msg, admin=False)
            self.assertEqual((connection.errors, len(connection.results)), ([], 1))
        await self.settle()
        self.assertEqual(self.birdnet.review_calls(), [])
        self.assertEqual(self.entries(), [])

    async def test_a_seen_visit_through_the_handlers_does_nothing(self) -> None:
        self.visit = seen()
        connection = await self.call(
            websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "s1", "also_heard": True}
        )
        self.assertEqual(len(connection.results), 1)
        await self.settle()
        self.assertEqual(self.birdnet.review_calls(), [])

    async def test_a_plugin_error_reaches_the_panel_and_sends_nothing(self) -> None:
        self.visit = websocket_module.KestrelApiError("The plugin refused", status=404)
        connection = await self.call(websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"})
        self.assertEqual([error[1] for error in connection.errors], ["not_found"])
        await self.settle()
        self.assertEqual(self.birdnet.review_calls(), [])

    async def test_a_missing_service_changes_nothing_for_the_panel(self) -> None:
        del self.hass.data[DOMAIN]["birdnet_reviews"]
        connection = await self.call(websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"})
        self.assertEqual((connection.errors, len(connection.results)), ([], 1))

    async def test_a_failing_birdnet_go_never_reaches_the_panel(self) -> None:
        self.birdnet.fail[("GET", "")] = aiohttp.ClientError("down")
        connection = await self.call(websocket_module.ws_visit_confirm, {"type": "kestrel/visit/confirm", "visit_id": "h1"})
        await self.settle()
        self.assertEqual((connection.errors, len(connection.results)), ([], 1))
        self.assertEqual(self.last()["outcome"], "failed")

    async def test_the_hook_sees_the_raw_answer_and_an_exception_in_it_is_swallowed(self) -> None:
        seen_by_hook: list[object] = []

        def hook(result: object) -> None:
            seen_by_hook.append(result)
            raise RuntimeError("hook bug")

        connection = FakeConnection()
        with self.assertLogs("kestrel_pkg.websocket_api", level="WARNING"):
            await websocket_module._async_api_call(
                self.hass, connection, {"id": 9}, "POST", "visits/h1/confirm", on_result=hook
            )
        self.assertEqual(seen_by_hook, [self.visit])
        self.assertEqual((connection.errors, len(connection.results)), ([], 1))
        self.assertEqual(connection.results[0][0], 9)

    async def test_the_hook_runs_before_media_paths_are_signed(self) -> None:
        raw: list[object] = []
        connection = FakeConnection()
        await websocket_module._async_api_call(self.hass, connection, {"id": 9}, "GET", "visits/h1", on_result=raw.append)
        self.assertEqual(raw[0]["audio"]["birdnetDetectionId"], 360)  # type: ignore[index]

    def test_the_hook_is_only_made_for_an_admin_with_a_running_service(self) -> None:
        self.assertIsNotNone(birdnet_review.review_hook(self.hass, FakeConnection(admin=True), "confirm"))
        self.assertIsNone(birdnet_review.review_hook(self.hass, FakeConnection(admin=False), "confirm"))
        self.assertIsNone(birdnet_review.review_hook(self.hass, types.SimpleNamespace(), "confirm"))
        del self.hass.data[DOMAIN]["birdnet_reviews"]
        self.assertIsNone(birdnet_review.review_hook(self.hass, FakeConnection(admin=True), "confirm"))


class DiagnosticsTests(ReviewTestCase):
    async def test_the_log_is_bounded_and_the_counts_keep_counting(self) -> None:
        for number in range(birdnet_review.HISTORY + 5):
            self.service.visit_action("correct", heard(360, f"h{number}"), "unknown")
        info = self.service.diagnostics()
        self.assertEqual(len(info["recent"]), birdnet_review.HISTORY)
        self.assertEqual(info["recent"][-1]["visitId"], f"h{birdnet_review.HISTORY + 4}")
        self.assertEqual(info["counts"], {"sent": 0, "skipped": birdnet_review.HISTORY + 5, "failed": 0, "cancelled": 0, "reverted": 0})

    async def test_an_entry_has_the_documented_fields(self) -> None:
        self.service.visit_action("confirm", heard())
        await self.settle()
        entry = self.last()
        self.assertEqual(set(entry), {"visitId", "detectionId", "action", "outcome", "detail", "at"})
        self.assertEqual(entry["action"], "confirm")
        self.assertRegex(entry["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
        self.assertTrue(entry["at"].endswith("+00:00"))

    async def test_the_config_entry_diagnostics_show_it_and_never_a_token(self) -> None:
        self.service.visit_action("confirm", heard())
        await self.settle()
        entry = types.SimpleNamespace(
            runtime_data=new_coordinator([], self.hass), as_dict=lambda: {"data": {"url": "http://x", "api_key": "plugin-secret"}, "options": {}}
        )
        result = await diagnostics_module.async_get_config_entry_diagnostics(self.hass, entry)
        self.assertEqual(result["birdnet_reviews"]["counts"]["sent"], 1)
        self.assertEqual(result["birdnet_reviews"]["recent"][0]["outcome"], "sent")
        dumped = json.dumps(result)
        for secret in (TOKEN, "csrf=", "plugin-secret"):
            self.assertNotIn(secret, dumped)
        del self.hass.data[DOMAIN]["birdnet_reviews"]
        result = await diagnostics_module.async_get_config_entry_diagnostics(self.hass, entry)
        self.assertEqual(result["birdnet_reviews"], {"configured": False})


if __name__ == "__main__":
    unittest.main()
