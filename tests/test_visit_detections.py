"""A visit's detection boxes (`detections`) reach the panel exactly as the plugin sent them.

The plugin puts what the wildlife detector drew around the animal on the answer for ONE visit (see scrypted-plugin/README.md). The
integration never looks inside it: it passes the visit on and signs the media links. This holds that to account: the boxes come through
unchanged and the clip's link is still signed. Runs the real websocket_api.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import types
import unittest

from ha_stubs import HomeAssistant, const_module, new_coordinator, websocket_module

DOMAIN = const_module.DOMAIN
VISIT_ID = "20146777-f0b9-45d3-9641-916a5641ec11"

DETECTIONS = {
    "clipStartAt": 1_793_327_224_437,
    "offsetMs": 330,
    "frames": [
        {"t": 1_793_327_225_199, "boxes": [
            {"x": 0.453, "y": 0.769, "w": 0.064, "h": 0.132, "className": "animal", "score": 0.82, "id": "w1"},
        ]},
        {"t": 1_793_327_226_823, "boxes": [
            {"x": 0.497, "y": 0.872, "w": 0.056, "h": 0.073, "className": "animal", "score": 0.84, "id": "w1", "label": "Virginia Opossum"},
            {"x": 0.1, "y": 0.2, "w": 0.05, "h": 0.05, "className": "animal", "score": 0.6, "label": "Common Raccoon"},
        ]},
    ],
}


def seen_visit() -> dict:
    return {
        "id": VISIT_ID, "camera": {"id": "88", "name": "Backyard"}, "kind": "seen", "startedAt": 1_793_327_224_429,
        "species": "Virginia Opossum", "grp": "mammal", "status": "confirmed", "score": 0.91,
        "clip": {"state": "ready", "expectedReadyAt": 1_793_327_269_429, "url": f"media/clip/{VISIT_ID}.mp4", "source": "events"},
        "suggestions": [], "firstEver": False, "muted": False,
        "detections": copy.deepcopy(DETECTIONS),
    }


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.user = types.SimpleNamespace(is_admin=True)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object = None) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


async def ask(visit: dict) -> tuple[FakeConnection, object]:
    hass = HomeAssistant()
    hass.data.setdefault(DOMAIN, {})["coordinator"] = new_coordinator([visit], hass)
    connection = FakeConnection()
    await websocket_module.ws_visit(hass, connection, {"id": 1, "type": "kestrel/visit", "visit_id": visit["id"]})
    return connection, connection.results[0][1] if connection.results else None


class VisitDetectionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_boxes_come_through_unchanged_and_the_clip_link_is_signed(self) -> None:
        connection, visit = await ask(seen_visit())
        self.assertEqual(connection.errors, [])
        # Nothing in the boxes is a media path, so the track is exactly what the plugin sent.
        self.assertEqual(visit["detections"], DETECTIONS)
        self.assertEqual(visit["clip"]["url"], f"/api/kestrel/media/clip/{VISIT_ID}.mp4?authSig=FAKE")

    async def test_a_visit_without_boxes_stays_without_them(self) -> None:
        old = seen_visit()
        del old["detections"]
        connection, visit = await ask(old)
        self.assertEqual(connection.errors, [])
        self.assertNotIn("detections", visit)


if __name__ == "__main__":
    unittest.main()
