"""Keeping a recording: lock a visit's BirdNET-Go detection so its clean-up never deletes the audio.

Runs the real recording_keep.py, birdnet_api.py and websocket_api.py against a fake BirdNET-Go with Home Assistant
stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib
import types
import unittest

from ha_stubs import SESSION, FakeResponse, FakeSession, HomeAssistant, KestrelApiError, const_module, websocket_module

recording_keep = importlib.import_module("kestrel_pkg.recording_keep")
DOMAIN = const_module.DOMAIN
API = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2"
TOKEN = "tok3n-AbCdEfGh12345678=="
CLIP = "2026/10/cyanocitta_cristata_36p_20261002T133155Z.opus"


class FakeBirdNetGo(FakeSession):
    """BirdNET-Go's detection and lock endpoints with their real behaviour: a lock needs the CSRF token in a header
    AND a cookie, locking a locked detection is a 409, and the answer to the lock is an empty 204."""

    def __init__(self) -> None:
        super().__init__()
        self.detections: dict[int, dict] = {}
        self.ignore_locks = False

    def add(self, detection_id: int, *, clip: object = CLIP, locked: bool = False) -> None:
        self.detections[detection_id] = {"id": detection_id, "commonName": "Blue Jay", "clipName": clip, "locked": locked}

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        if (method, url) == ("GET", f"{API}/app/config"):
            return FakeResponse(200, {"csrfToken": TOKEN, "version": "20261014"})
        prefix = f"{API}/detections/"
        if url.startswith(prefix):
            rest = url[len(prefix):]
            number, _, action = rest.partition("/")
            detection = self.detections.get(int(number))
            if detection is None:
                return FakeResponse(404, {"error": "Detection not found"})
            if method == "GET" and not action:
                return FakeResponse(200, dict(detection))
            if method == "POST" and action == "lock":
                headers = kwargs["headers"] or {}
                if headers.get("X-CSRF-Token") != TOKEN or headers.get("Cookie") != f"csrf={TOKEN}":
                    return FakeResponse(403, {"error": "forbidden"})
                wanted = kwargs["json"]["locked"]
                if wanted and detection["locked"]:
                    return FakeResponse(409, {"error": "Detection is locked and status cannot be changed"})
                if not self.ignore_locks:
                    detection["locked"] = wanted
                return FakeResponse(204)
        return FakeResponse(404, {"error": "not_found"})

    def locks(self) -> list[dict]:
        return [kwargs for method, url, kwargs in self.calls if method == "POST" and url.endswith("/lock")]


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


def heard(detection_id: object = 360, clip: object = CLIP) -> dict:
    return {"id": "h1", "kind": "heard", "species": "Blue Jay", "audio": {"birdnetDetectionId": detection_id, "birdnetClip": clip}}


def seen_with_call(detection_id: object = 360, clip: object = CLIP) -> dict:
    return {
        "id": "s1", "kind": "seen", "species": "Blue Jay",
        "heard": {"visitId": "h1", "species": "Blue Jay", "hasAudio": True, "birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


class KeepRecordingTests(unittest.IsolatedAsyncioTestCase):
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

        self.hass.data[DOMAIN] = {"coordinator": types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request))}

    async def get(self, *, admin: bool = True, visit_id: str = "h1") -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await websocket_module.ws_recording_keep_get(
            self.hass, connection, {"id": 4, "type": "kestrel/recording/keep/get", "visit_id": visit_id}
        )
        return connection

    async def set(self, keep: bool, *, admin: bool = True, visit_id: str = "h1") -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await websocket_module.ws_recording_keep_set(
            self.hass, connection, {"id": 5, "type": "kestrel/recording/keep/set", "visit_id": visit_id, "keep": keep}
        )
        return connection

    async def test_a_recording_that_is_not_kept_says_so_and_can_be_kept(self) -> None:
        self.birdnet.add(360)
        connection = await self.get()
        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(4, {"keepable": True, "kept": False, "canChange": True})])
        self.assertEqual(self.plugin_calls, [("GET", "visits/h1")])

    async def test_a_kept_recording_reads_as_kept(self) -> None:
        self.birdnet.add(360, locked=True)
        connection = await self.get()
        self.assertEqual(connection.results[0][1], {"keepable": True, "kept": True, "canChange": True})

    async def test_anyone_signed_in_may_look_but_is_told_they_cannot_change_it(self) -> None:
        self.birdnet.add(360)
        connection = await self.get(admin=False)
        self.assertEqual(connection.results[0][1]["canChange"], False)

    async def test_keeping_locks_the_detection_with_the_security_token_in_header_and_cookie(self) -> None:
        self.birdnet.add(360)
        connection = await self.set(True)
        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(5, {"keepable": True, "kept": True, "canChange": True})])
        self.assertTrue(self.birdnet.detections[360]["locked"])
        [write] = self.birdnet.locks()
        self.assertEqual(write["json"], {"locked": True})
        self.assertEqual(write["headers"], {"X-CSRF-Token": TOKEN, "Cookie": f"csrf={TOKEN}"})

    async def test_releasing_unlocks_it_again(self) -> None:
        self.birdnet.add(360, locked=True)
        connection = await self.set(False)
        self.assertEqual(connection.results[0][1], {"keepable": True, "kept": False, "canChange": True})
        self.assertFalse(self.birdnet.detections[360]["locked"])
        self.assertEqual(self.birdnet.locks()[0]["json"], {"locked": False})

    async def test_asking_for_what_is_already_true_writes_nothing(self) -> None:
        self.birdnet.add(360, locked=True)
        await self.set(True)
        self.birdnet.add(361)
        self.visit = heard(361)
        await self.set(False)
        self.assertEqual(self.birdnet.locks(), [])

    async def test_a_lock_made_a_moment_earlier_by_someone_else_is_not_an_error(self) -> None:
        self.birdnet.add(360)
        real_request = self.birdnet.request
        state = {"reads": 0}

        def request(method: str, url: str, **kwargs: object) -> FakeResponse:
            if method == "GET" and url == f"{API}/detections/360":
                state["reads"] += 1
                if state["reads"] == 1:
                    return FakeResponse(200, {"id": 360, "clipName": CLIP, "locked": False})  # the read before ...
                self.birdnet.detections[360]["locked"] = True  # ... somebody else locks it before ours arrives
            return real_request(method, url, **kwargs)

        self.birdnet.request = request  # type: ignore[method-assign]
        connection = await self.set(True)
        self.assertEqual(connection.errors, [])
        self.assertTrue(connection.results[0][1]["kept"])

    async def test_only_an_administrator_may_change_it(self) -> None:
        self.birdnet.add(360)
        connection = await self.set(True, admin=False)
        self.assertEqual([code for _, code, _ in connection.errors], ["unauthorized"])
        self.assertEqual(self.birdnet.calls, [], "BirdNET-Go is not even asked")
        self.assertEqual(self.plugin_calls, [])

    async def test_a_sighting_with_a_call_linked_keeps_that_calls_recording(self) -> None:
        self.birdnet.add(360)
        self.visit = seen_with_call()
        connection = await self.set(True, visit_id="s1")
        self.assertEqual(connection.errors, [])
        self.assertTrue(self.birdnet.detections[360]["locked"])

    async def test_a_detection_with_no_clip_has_nothing_to_keep(self) -> None:
        self.birdnet.add(13761, clip=None)
        self.visit = heard(13761, None)
        read = await self.get()
        self.assertEqual(read.results[0][1], {"keepable": False, "kept": False, "canChange": True})
        self.assertEqual(self.birdnet.calls, [], "a part announced without a clip name is known not to have one")
        write = await self.set(True)
        self.assertEqual([code for _, code, _ in write.errors], ["not_found"])
        self.assertEqual(self.birdnet.locks(), [])

    async def test_a_detection_that_has_no_clip_name_in_birdnet_go_either_is_not_keepable(self) -> None:
        self.birdnet.add(362, clip="")
        self.visit = heard(362)
        read = await self.get()
        self.assertEqual(read.results[0][1]["keepable"], False)
        write = await self.set(True)
        self.assertEqual([code for _, code, _ in write.errors], ["not_found"])
        self.assertEqual(self.birdnet.locks(), [])

    async def test_a_recording_announced_with_id_0_cannot_be_locked_because_it_has_no_row(self) -> None:
        self.visit = heard(0)
        read = await self.get()
        self.assertEqual(read.results[0][1], {"keepable": False, "kept": False, "canChange": True})
        write = await self.set(True)
        self.assertEqual([code for _, code, _ in write.errors], ["not_found"])
        self.assertEqual(self.birdnet.calls, [])

    async def test_a_detection_birdnet_go_has_forgotten_is_not_keepable(self) -> None:
        read = await self.get()  # 360 was never added: BirdNET-Go answers 404
        self.assertEqual(read.errors, [])
        self.assertEqual(read.results[0][1], {"keepable": False, "kept": False, "canChange": True})
        write = await self.set(True)
        self.assertEqual([code for _, code, _ in write.errors], ["not_found"])

    async def test_birdnet_go_ignoring_the_lock_is_reported_not_pretended(self) -> None:
        self.birdnet.add(360)
        self.birdnet.ignore_locks = True
        connection = await self.set(True)
        self.assertEqual(connection.results, [])
        self.assertEqual(len(connection.errors), 1)

    async def test_birdnet_go_refusing_the_write_is_an_error(self) -> None:
        self.birdnet.add(360)
        real_request = self.birdnet.request

        def request(method: str, url: str, **kwargs: object) -> FakeResponse:
            if method == "POST":
                return FakeResponse(403, {"error": "forbidden"})
            return real_request(method, url, **kwargs)

        self.birdnet.request = request  # type: ignore[method-assign]
        connection = await self.set(True)
        self.assertEqual(connection.results, [])
        self.assertEqual([code for _, code, _ in connection.errors], ["api_error"])

    async def test_a_visit_the_plugin_does_not_know_is_its_own_error(self) -> None:
        self.visit = KestrelApiError("nope", status=404)
        connection = await self.get()
        self.assertEqual([code for _, code, _ in connection.errors], ["not_found"])
        self.assertEqual(self.birdnet.calls, [])

    async def test_a_visit_without_any_recording_is_not_keepable(self) -> None:
        self.visit = {"id": "s2", "kind": "seen", "species": "Raccoon", "audio": None, "heard": None}
        read = await self.get(visit_id="s2")
        self.assertEqual(read.results[0][1], {"keepable": False, "kept": False, "canChange": True})

    async def test_the_command_schemas_demand_a_visit_and_a_real_boolean(self) -> None:
        schema = websocket_module.ws_recording_keep_set.ws_schema
        schema({"id": 1, "type": "kestrel/recording/keep/set", "visit_id": "h1", "keep": True})
        for bad in ({"visit_id": "h1"}, {"keep": True}, {"visit_id": "h1", "keep": "yes"}):
            with self.assertRaises(Exception):
                schema({"id": 1, "type": "kestrel/recording/keep/set", **bad})
        websocket_module.ws_recording_keep_get.ws_schema({"id": 1, "type": "kestrel/recording/keep/get", "visit_id": "h1"})


if __name__ == "__main__":
    unittest.main()
