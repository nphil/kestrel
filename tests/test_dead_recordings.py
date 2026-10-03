"""A heard visit whose recording BirdNET-Go never kept must not get a playable-looking link.

Found live: 28 of 664 heard visits had no playable audio, 9 of them with a signed link that answered 404 (BirdNET-Go
announced those detections with no clip name and saved no file). The link was signed while the clip's existence was
still unknown, and only a confirmed 404 hid it. Runs the real websocket_api.py, birdnet_availability.py and audio.py
with Home Assistant, BirdNET-Go and the audio service faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest import mock

from ha_stubs import (
    FakeResponse,
    FakeSession,
    HomeAssistant,
    SESSION,
    async_dispatcher_send,
    audio_module,
    const_module,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

BIRDNET = const_module.BIRDNET_GO_INTERNAL_URL
AUDIO_SERVICE = "http://audio.test:8787"
DOMAIN = const_module.DOMAIN
SIGNAL = const_module.SIGNAL_EVENTS
CLIP = "2026/10/cyanocitta_cristata_36p_20261002T133155Z.opus"


def link(kind: str, detection_id: int) -> str:
    return f"/api/kestrel/media/{kind}/{detection_id}?authSig=FAKE"


def heard(visit_id: str, detection_id: int, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "heard", "species": "Blue Jay", "grp": "bird", "startedAt": 1,
        "audio": {"birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


def seen(visit_id: str, detection_id: int, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "seen", "species": "Blue Jay", "grp": "bird", "clip": {"state": "none"},
        "heard": {"visitId": "h1", "species": "Blue Jay", "hasAudio": True, "birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


class Stalled(FakeResponse):
    """BirdNET-Go accepted the connection and never answers."""

    async def __aenter__(self) -> "Stalled":
        await asyncio.Event().wait()
        return self


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.subscriptions: dict = {}
        self.events: list[dict] = []
        self.results: list[object] = []
        self.errors: list[tuple[str, str]] = []

    def send_event(self, msg_id: int, event_payload: dict) -> None:
        self.events.append(event_payload)

    def send_result(self, msg_id: int, result: object = None) -> None:
        self.results.append(result)

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((code, message))


class RecordingTestCase(unittest.IsolatedAsyncioTestCase):
    """Every request starts with an empty verdict cache, as the first one after a restart does."""

    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {}
        self.plugin_visits: list[dict] = []

        async def async_request(method: str, path: str, **kwargs: object) -> object:
            return {"items": [dict(visit) for visit in self.plugin_visits]}

        self.hass.data[DOMAIN]["coordinator"] = types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request))
        self.connection = FakeConnection()

    def birdnet(self, detection_id: int, *responses: object) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/{detection_id}", *responses)

    def asked_birdnet(self) -> list[str]:
        return [url for _, url, _ in self.session.calls if url.startswith(BIRDNET)]

    async def visits(self) -> list[dict]:
        """What the panel gets from kestrel/visits."""
        self.connection.results.clear()
        await websocket_module.ws_visits(self.hass, self.connection, {"id": 1, "type": "kestrel/visits"})
        self.assertEqual(self.connection.errors, [])
        return self.connection.results[-1]["items"]


class WithoutAClipTests(RecordingTestCase):
    async def test_a_detection_announced_without_a_clip_name_gets_no_link_and_is_not_even_asked_about(self) -> None:
        for number, clip in ((13761, None), (13807, ""), (13974, "  ")):
            self.birdnet(number, FakeResponse(404))
            self.plugin_visits.append(heard(f"h{number}", number, clip))
        items = await self.visits()
        self.assertEqual([item["audio"] for item in items], [None, None, None])
        self.assertEqual(self.asked_birdnet(), [], "BirdNET-Go saved no clip: nothing to look for")

    async def test_the_call_linked_to_a_sighting_is_not_offered_either(self) -> None:
        self.plugin_visits.append(seen("s1", 13761, None))
        [item] = await self.visits()
        self.assertNotIn("audio_url", item["heard"])
        self.assertIs(item["heard"]["hasAudio"], False, "the panel would offer a 'Play call' button that finds nothing")
        self.assertEqual(self.asked_birdnet(), [])

    async def test_no_preview_job_is_attempted_for_it(self) -> None:
        self.assertEqual(audio_module.detection_ids([heard("h1", 13761, None), seen("s1", 13761, None)]), [])
        self.assertEqual(audio_module.detection_ids([heard("h2", 14146), seen("s2", 14553)]), [14146, 14553])
        self.assertIsNone(audio_module._visit_detection_id(heard("h1", 13761, None)))
        self.assertEqual(audio_module._visit_detection_id(heard("h2", 14146)), 14146)


class AvailabilityIsCheckedBeforeSigningTests(RecordingTestCase):
    async def test_a_named_clip_that_is_not_there_gets_no_link_on_the_very_first_request(self) -> None:
        self.birdnet(14711, FakeResponse(404))
        self.plugin_visits.extend([heard("h1", 14711), seen("s1", 14711)])
        first, linked = await self.visits()
        self.assertIsNone(first["audio"])
        self.assertNotIn("audio_url", linked["heard"])
        self.assertIs(linked["heard"]["hasAudio"], False)
        self.assertEqual(self.asked_birdnet(), [f"{BIRDNET}/api/v2/audio/14711"], "one check, shared by both")

    async def test_a_clip_that_is_there_is_linked_at_once_and_checked_only_once(self) -> None:
        self.birdnet(360, FakeResponse(206))
        self.plugin_visits.extend([heard("h1", 360), seen("s1", 360)])
        first, linked = await self.visits()
        self.assertEqual(first["audio"], link("birdnet_audio", 360))
        self.assertEqual(linked["heard"]["audio_url"], link("birdnet_audio", 360))
        self.assertIs(linked["heard"]["hasAudio"], True)
        await self.visits()
        self.assertEqual(len(self.asked_birdnet()), 1, "a clip that exists is not looked for again")

    async def test_a_mixed_page_links_exactly_the_clips_that_exist(self) -> None:
        self.birdnet(1, FakeResponse(200))
        self.birdnet(2, FakeResponse(404))
        self.birdnet(3, FakeResponse(206))
        self.plugin_visits.extend([heard("a", 1), heard("b", 2), heard("c", 3), heard("d", 4, None)])
        items = await self.visits()
        self.assertEqual([item["audio"] for item in items], [link("birdnet_audio", 1), None, link("birdnet_audio", 3), None])

    async def test_a_recording_whose_existence_is_unknown_gets_no_link_until_it_is_known(self) -> None:
        self.birdnet(360, aiohttp.ClientError("BirdNET-Go is restarting"), FakeResponse(206))
        self.plugin_visits.append(heard("h1", 360))
        [first] = await self.visits()
        self.assertIsNone(first["audio"])
        [second] = await self.visits()
        self.assertEqual(second["audio"], link("birdnet_audio", 360))

    async def test_a_slow_birdnet_go_delays_the_answer_by_a_bounded_time(self) -> None:
        self.birdnet(360, Stalled(206))
        self.plugin_visits.append(heard("h1", 360))
        self.addCleanup(lambda: [task.cancel() for task in self.hass._tasks])  # the background retry the real probe times out itself
        with mock.patch.object(websocket_module.birdnet_availability, "_AUDIO_CHECK_WAIT_S", 0.05):
            [item] = await asyncio.wait_for(self.visits(), 2)
        self.assertIsNone(item["audio"])

    async def test_a_negative_verdict_is_asked_again_after_it_expires(self) -> None:
        self.birdnet(360, FakeResponse(404), FakeResponse(206))
        self.plugin_visits.append(heard("h1", 360))
        [first] = await self.visits()
        self.assertIsNone(first["audio"])
        [again] = await self.visits()
        self.assertIsNone(again["audio"])
        self.assertEqual(len(self.asked_birdnet()), 1, "the verdict is cached")
        cache = self.hass.data[DOMAIN]["birdnet_audio_availability"]
        available, checked_at = cache["360"]
        cache["360"] = (available, checked_at - websocket_module.birdnet_availability._AUDIO_NEGATIVE_TTL)  # a clip that landed late
        [late] = await self.visits()
        self.assertEqual(late["audio"], link("birdnet_audio", 360))


class LiveEventTests(RecordingTestCase):
    async def test_a_pushed_visit_gets_the_same_treatment(self) -> None:
        self.birdnet(360, FakeResponse(206))
        self.birdnet(14711, FakeResponse(404))
        await websocket_module.ws_subscribe(self.hass, self.connection, {"id": 7, "type": "kestrel/subscribe"})
        batch = [
            {"type": "visit_new", "visit": heard("good", 360)},
            {"type": "visit_new", "visit": heard("purged", 14711)},
            {"type": "visit_new", "visit": heard("nothing-kept", 13761, None)},
        ]
        async_dispatcher_send(self.hass, SIGNAL, batch)
        await self.hass.async_block_till_done()
        audio = {event["visit"]["id"]: event["visit"]["audio"] for event in self.connection.events}
        self.assertEqual(audio, {"good": link("birdnet_audio", 360), "purged": None, "nothing-kept": None})


class PreviewsStillPlayTests(RecordingTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.previews = audio_module.AudioPreviews(self.hass, AUDIO_SERVICE, "test-audio-key-0123456789")
        self.hass.data[DOMAIN]["audio"] = self.previews
        self.addAsyncCleanup(self.previews.async_stop)

    def ready(self, detection_id: int) -> None:
        self.session.route("GET", f"{AUDIO_SERVICE}/v1/previews/{detection_id}/info", FakeResponse(200, {
            "detectionId": detection_id, "state": "ready", "segment": {"start": 2.0, "end": 7.5, "source": "perch"},
            "method": "trim", "cleaned": False, "scores": None, "loudnessLufs": -16.0, "durationS": 5.5,
            "createdAt": "2026-10-01T22:00:00Z", "readyAt": None, "queuePosition": None, "error": None}))

    async def test_a_visit_with_a_clip_plays_its_preview_and_keeps_the_original_to_fall_back_to(self) -> None:
        self.birdnet(360, FakeResponse(206))
        self.ready(360)
        self.plugin_visits.extend([heard("h1", 360), seen("s1", 360)])
        first, linked = await self.visits()
        self.assertEqual(first["audio"], link("birdnet_preview", 360))
        self.assertEqual(first["audioOriginal"], link("birdnet_audio", 360))
        self.assertEqual(first["audioInfo"]["state"], "ready")
        self.assertEqual(linked["heard"]["audio_url"], link("birdnet_preview", 360))
        self.assertEqual(linked["heard"]["audioOriginal"], link("birdnet_audio", 360))
        self.assertIs(linked["heard"]["hasAudio"], True)

    async def test_a_ready_preview_is_not_lost_when_the_original_file_is_gone(self) -> None:
        self.birdnet(360, FakeResponse(404))
        self.ready(360)
        self.plugin_visits.append(heard("h1", 360))
        [item] = await self.visits()
        self.assertEqual(item["audio"], link("birdnet_preview", 360))
        self.assertNotIn("audioOriginal", item)

    async def test_a_visit_without_a_clip_asks_the_audio_service_for_nothing(self) -> None:
        self.plugin_visits.append(heard("h1", 13761, None))
        [item] = await self.visits()
        self.assertIsNone(item["audio"])
        self.assertNotIn("audioInfo", item)
        self.assertEqual(self.session.calls, [])


if __name__ == "__main__":
    unittest.main()
