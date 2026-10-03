"""BirdNET-Go's detection numbers start at 1, but some detections reach Kestrel announced with id 0 and a real clip name.

BirdNET-Go answers 404 for the recording of id 0, always. A link signed for it while its availability was still unknown
was requested by the panel (a failed request in the browser's console) once every ten minutes per such call, so a 0 gets
no link, no availability check and no preview job. Runs the real websocket_api.py, media.py and audio.py with Home
Assistant, BirdNET-Go and the audio service faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import types
import unittest

from ha_stubs import (
    FakeResponse,
    FakeSession,
    HomeAssistant,
    SESSION,
    audio_module,
    const_module,
    media_module,
    websocket_module,
)

BIRDNET = const_module.BIRDNET_GO_INTERNAL_URL
AUDIO_SERVICE = "http://audio.test:8787"
DOMAIN = const_module.DOMAIN


async def settle() -> None:
    for _ in range(25):
        await asyncio.sleep(0)


def heard_visit(detection_id: object) -> dict:
    return {
        "id": "h1", "kind": "heard", "species": "Blue Jay", "grp": "bird",
        "audio": {"birdnetDetectionId": detection_id, "birdnetClip": "2026/10/cyanocitta_cristata_36p_20261002T133155Z.opus"},
    }


def seen_visit(detection_id: object) -> dict:
    return {
        "id": "s1", "kind": "seen", "species": "Blue Jay", "grp": "bird", "clip": {"state": "none"},
        "heard": {"visitId": "h1", "species": "Blue Jay", "hasAudio": True, "birdnetDetectionId": detection_id, "birdnetClip": "x.opus"},
    }


class SigningTests(unittest.IsolatedAsyncioTestCase):
    """The availability of BirdNET-Go's recordings is checked (async_confirm_audio) before the real command signs links."""

    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {}

    def sign(self, payload: object) -> object:
        return websocket_module._sign_media_paths(self.hass, payload, "token-1")

    async def test_a_call_announced_with_id_0_gets_no_recording_link_and_no_check(self) -> None:
        signed = self.sign(heard_visit(0))
        await settle()
        self.assertIsNone(signed["audio"])
        self.assertEqual(self.session.calls, [], "nothing may be asked of BirdNET-Go about a recording that cannot exist")

    async def test_a_sighting_linked_to_such_a_call_gets_no_link_either(self) -> None:
        signed = self.sign(seen_visit(0))
        await settle()
        self.assertNotIn("audio_url", signed["heard"])
        self.assertEqual(self.session.calls, [])

    async def test_a_real_detection_still_gets_its_link_and_is_checked(self) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/360", FakeResponse(206))
        await websocket_module.birdnet_availability.async_confirm_audio(self.hass, heard_visit(360))
        signed = self.sign(heard_visit(360))
        await settle()
        self.assertEqual(signed["audio"], "/api/kestrel/media/birdnet_audio/360?authSig=FAKE")
        self.assertEqual([call[1] for call in self.session.calls], [f"{BIRDNET}/api/v2/audio/360"])

        linked = self.sign(seen_visit(360))
        self.assertEqual(linked["heard"]["audio_url"], "/api/kestrel/media/birdnet_audio/360?authSig=FAKE")

    async def test_a_negative_number_is_no_detection_either(self) -> None:
        self.assertIsNone(self.sign(heard_visit(-3))["audio"])


class MediaRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {"audio": audio_module.AudioPreviews(self.hass, AUDIO_SERVICE, "test-audio-key-0123456789")}
        self.view = media_module.KestrelMediaView(self.hass)

    async def get(self, kind: str, media_id: str) -> object:
        return await self.view.get(types.SimpleNamespace(headers={}), kind, media_id)

    async def test_a_link_for_id_0_is_answered_without_asking_the_add_on(self) -> None:
        for kind in ("birdnet_audio", "birdnet_preview"):
            response = await self.get(kind, "0")
            self.assertEqual(response.status, 404, kind)
        self.assertEqual(self.session.calls, [])

    async def test_a_real_recording_is_still_streamed(self) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/12", FakeResponse(200, body=b"OGGDATA", headers={"Content-Type": "audio/ogg"}))
        response = await self.get("birdnet_audio", "12")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, b"OGGDATA")


class AudioServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_call_with_id_0_is_not_looked_up_at_the_audio_service(self) -> None:
        session = FakeSession()
        SESSION["session"] = session
        hass = HomeAssistant()
        previews = audio_module.AudioPreviews(hass, AUDIO_SERVICE, "test-audio-key-0123456789")
        hass.data[DOMAIN] = {"audio": previews}
        self.addAsyncCleanup(previews.async_stop)
        await previews.async_prefetch([heard_visit(0), seen_visit(0)])
        self.assertEqual(session.calls, [])
        self.assertEqual(audio_module.detection_ids([heard_visit(0), heard_visit(7)]), [7])


if __name__ == "__main__":
    unittest.main()
