"""A heard visit BirdNET-Go announced with detection id 0 (or none) but with a real clip name still gets its recording.

Found live: about 2.5 % of heard visits (9 of 355 in a day) showed "No recording was kept" although BirdNET-Go had saved
the clip. When the same species is heard on the other camera within a few seconds, BirdNET-Go's de-duplication gives the
database row (the detection id) to the other detection, and announces this one with id 0 -- but with its clip name, and
the clip is served by that name. So a recording is linked by detection id when there is a real one, and otherwise by
clip name, and the clip name is validated strictly because it ends up in a URL sent to BirdNET-Go. Runs the real
websocket_api.py, media.py, birdnet_availability.py and audio.py with Home Assistant, BirdNET-Go and the audio service
faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

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
from test_dead_recordings import RecordingTestCase

BIRDNET = const_module.BIRDNET_GO_INTERNAL_URL
AUDIO_SERVICE = "http://audio.test:8787"
DOMAIN = const_module.DOMAIN
availability = websocket_module.birdnet_availability

CLIP = "2026/10/thryothorus_ludovicianus_82p_20261003T130448Z.opus"
OTHER_CLIP = "2026/10/cyanocitta_cristata_67p_20261003T131112Z.opus"
CLIP_URL = f"{BIRDNET}/api/v2/media/audio/{CLIP}"
OTHER_CLIP_URL = f"{BIRDNET}/api/v2/media/audio/{OTHER_CLIP}"


def clip_link(clip: str) -> str:
    return f"/api/kestrel/media/birdnet_clip/{clip}?authSig=FAKE"


def heard(visit_id: str, detection_id: object, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "heard", "species": "Carolina Wren", "grp": "bird", "startedAt": 1,
        "audio": {"birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


def seen(visit_id: str, detection_id: object, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "seen", "species": "Carolina Wren", "grp": "bird", "clip": {"state": "none"},
        "heard": {"visitId": "h1", "species": "Carolina Wren", "hasAudio": True, "birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


# Names that must never reach a URL, each with the way it would hurt.
HOSTILE = [
    "../../etc/passwd",
    "2026/10/../../../config/secrets.opus",
    "2026/10/..%2f..%2fsecret.opus",
    "2026/10/%2e%2e/secret.opus",
    "2026/10/a..b.opus",
    "/2026/10/x.opus",
    "2026//10/x.opus",
    "2026/10/sub/x.opus",
    "2026/13/x.opus",
    "2026/00/x.opus",
    "26/10/x.opus",
    "2026/10/x.opus?token=1",
    "2026/10/x.opus#frag",
    "2026/10/x y.opus",
    "2026/10/x.opus\n",
    "2026/10/x.opus\x00.png",
    "2026/10/x\\y.opus",
    "2026/10/\u00e9.opus",
    "2026/10/\u0662\u0660.opus",  # Arabic-Indic digits are not digits here
    "2026/10/.hidden.opus",
    "2026/10/x.exe",
    "2026/10/x",
    "2026/10/",
    "http://evil.test/2026/10/x.opus",
    "//evil.test/2026/10/x.opus",
    "2026/10/" + "a" * 300 + ".opus",
    "",
    "   ",
]


class ClipNameTests(unittest.TestCase):
    def test_real_clip_names_are_accepted_as_they_are(self) -> None:
        for clip in (CLIP, OTHER_CLIP, "2025/12/tamias_striatus_46p_20251231T235959Z.opus", "2026/01/x.wav", "2026/10/a-b+c.flac"):
            self.assertEqual(availability.clip_name_of(clip), clip)

    def test_hostile_names_are_refused(self) -> None:
        for clip in HOSTILE:
            self.assertIsNone(availability.clip_name_of(clip), repr(clip))

    def test_only_text_can_be_a_clip_name(self) -> None:
        for value in (None, 0, 12, 1.5, True, [CLIP], {"clip": CLIP}, b"2026/10/x.opus"):
            self.assertIsNone(availability.clip_name_of(value), repr(value))

    def test_a_recording_is_named_by_its_id_when_it_has_one_and_by_its_clip_otherwise(self) -> None:
        part = lambda detection_id, clip=CLIP: {"birdnetDetectionId": detection_id, "birdnetClip": clip}  # noqa: E731
        self.assertEqual(availability.recording_of(part(360)), ("birdnet_audio", "360"))
        self.assertEqual(availability.recording_of(part(0)), ("birdnet_clip", CLIP))
        self.assertEqual(availability.recording_of(part(None)), ("birdnet_clip", CLIP))
        self.assertEqual(availability.recording_of({"birdnetClip": CLIP}), ("birdnet_clip", CLIP))
        self.assertEqual(availability.recording_of(part(-3)), ("birdnet_clip", CLIP))
        # No clip name at all: BirdNET-Go saved nothing, whatever the id says.
        for clip in (None, "", "  "):
            self.assertIsNone(availability.recording_of(part(360, clip)), repr(clip))
            self.assertIsNone(availability.recording_of(part(0, clip)), repr(clip))
        self.assertIsNone(availability.recording_of(part(0, "../../x")))
        self.assertIsNone(availability.recording_of(None))
        self.assertIsNone(availability.recording_of("2026/10/x.opus"))

    def test_recording_urls(self) -> None:
        self.assertEqual(availability.recording_url(CLIP), CLIP_URL)
        self.assertEqual(availability.recording_url("360"), f"{BIRDNET}/api/v2/audio/360")
        for media_id in ("0", "-1", "", "abc", "12/3", "../1", "1.5", "\u0663\u0666\u0660", "2026/10/../x.opus"):
            self.assertIsNone(availability.recording_url(media_id), repr(media_id))


class LinkingTests(RecordingTestCase):
    async def test_id_0_with_a_clip_that_exists_is_linked_by_name_on_the_very_first_request(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(206))
        self.plugin_visits.append(heard("h1", 0))
        [item] = await self.visits()
        self.assertEqual(item["audio"], clip_link(CLIP))
        self.assertEqual(self.asked_birdnet(), [CLIP_URL], "the clip is looked up by its name, never by id 0")
        [(_, _, kwargs)] = self.session.calls
        self.assertEqual(kwargs["headers"], {"Range": "bytes=0-0"}, "one byte is enough to know it is there")

    async def test_a_missing_id_works_the_same(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(200))
        self.plugin_visits.append(heard("h1", None))
        [item] = await self.visits()
        self.assertEqual(item["audio"], clip_link(CLIP))

    async def test_the_sighting_linked_to_such_a_call_can_play_it_too(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(206))
        self.plugin_visits.extend([heard("h1", 0), seen("s1", 0)])
        first, linked = await self.visits()
        self.assertEqual(linked["heard"]["audio_url"], first["audio"])
        self.assertIs(linked["heard"]["hasAudio"], True)
        self.assertEqual(self.asked_birdnet(), [CLIP_URL], "one check, shared by both")

    async def test_a_clip_that_is_there_is_checked_only_once(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(206))
        self.plugin_visits.append(heard("h1", 0))
        await self.visits()
        [again] = await self.visits()
        self.assertEqual(again["audio"], clip_link(CLIP))
        self.assertEqual(len(self.asked_birdnet()), 1)

    async def test_a_clip_that_is_not_there_gets_no_link_and_is_not_asked_again_at_once(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(404))
        self.plugin_visits.extend([heard("h1", 0), seen("s1", 0)])
        first, linked = await self.visits()
        self.assertIsNone(first["audio"])
        self.assertNotIn("audio_url", linked["heard"])
        self.assertIs(linked["heard"]["hasAudio"], False)
        await self.visits()
        self.assertEqual(len(self.asked_birdnet()), 1, "a negative verdict is cached for a while")

    async def test_a_clip_that_lands_late_is_found_once_the_negative_verdict_expires(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(404), FakeResponse(206))
        self.plugin_visits.append(heard("h1", 0))
        await self.visits()
        cache = self.hass.data[DOMAIN]["birdnet_audio_availability"]
        available, checked_at = cache[CLIP]
        cache[CLIP] = (available, checked_at - availability._AUDIO_NEGATIVE_TTL)
        [late] = await self.visits()
        self.assertEqual(late["audio"], clip_link(CLIP))

    async def test_an_unknown_answer_gives_no_link_until_it_is_known(self) -> None:
        import aiohttp

        self.session.route("GET", CLIP_URL, aiohttp.ClientError("BirdNET-Go is restarting"), FakeResponse(206))
        self.plugin_visits.append(heard("h1", 0))
        [first] = await self.visits()
        self.assertIsNone(first["audio"])
        [second] = await self.visits()
        self.assertEqual(second["audio"], clip_link(CLIP))

    async def test_a_real_detection_id_is_still_linked_by_id_even_with_a_clip_name(self) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/360", FakeResponse(206))
        self.plugin_visits.append(heard("h1", 360))
        [item] = await self.visits()
        self.assertEqual(item["audio"], "/api/kestrel/media/birdnet_audio/360?authSig=FAKE")
        self.assertEqual(self.asked_birdnet(), [f"{BIRDNET}/api/v2/audio/360"])

    async def test_without_a_clip_name_id_0_still_gets_nothing(self) -> None:
        self.plugin_visits.extend([heard("a", 0, None), heard("b", 0, ""), heard("c", None, None)])
        items = await self.visits()
        self.assertEqual([item["audio"] for item in items], [None, None, None])
        self.assertEqual(self.session.calls, [])

    async def test_hostile_clip_names_get_no_link_and_nothing_is_asked_of_birdnet_go(self) -> None:
        for number, clip in enumerate(HOSTILE):
            self.plugin_visits.extend([heard(f"h{number}", 0, clip), seen(f"s{number}", None, clip)])
        items = await self.visits()
        for item in items:
            self.assertIsNone(item.get("audio"), item["id"])
            self.assertNotIn("audio_url", item.get("heard", {}), item["id"])
        self.assertEqual(self.session.calls, [])

    async def test_every_such_visit_on_a_page_gains_its_audio_with_no_stored_state_changed(self) -> None:
        """The "backfill": links are made when a page is built, so visits already stored with id 0 gain audio at once."""
        clips = [f"2026/10/thryothorus_ludovicianus_{score}p_20261003T1304{score:02d}Z.opus" for score in range(40, 50)]
        for clip in clips:
            self.session.route("GET", f"{BIRDNET}/api/v2/media/audio/{clip}", FakeResponse(206))
        self.plugin_visits.extend(heard(f"v{number}", 0, clip) for number, clip in enumerate(clips))
        before = [dict(visit["audio"]) for visit in self.plugin_visits]
        items = await self.visits()
        self.assertEqual([item["audio"] for item in items], [clip_link(clip) for clip in clips])
        self.assertEqual([visit["audio"] for visit in self.plugin_visits], before)

    async def test_a_pushed_visit_gets_the_same_treatment(self) -> None:
        from ha_stubs import async_dispatcher_send

        self.session.route("GET", CLIP_URL, FakeResponse(206))
        self.session.route("GET", OTHER_CLIP_URL, FakeResponse(404))
        await websocket_module.ws_subscribe(self.hass, self.connection, {"id": 7, "type": "kestrel/subscribe"})
        async_dispatcher_send(
            self.hass,
            const_module.SIGNAL_EVENTS,
            [
                {"type": "visit_new", "visit": heard("good", 0, CLIP)},
                {"type": "visit_new", "visit": heard("purged", 0, OTHER_CLIP)},
            ],
        )
        await self.hass.async_block_till_done()
        audio = {event["visit"]["id"]: event["visit"]["audio"] for event in self.connection.events}
        self.assertEqual(audio, {"good": clip_link(CLIP), "purged": None})


class NoPreviewTests(RecordingTestCase):
    """kestrel-audio is keyed by detection id: a call with none plays BirdNET-Go's original recording."""

    async def test_such_a_call_plays_the_original_and_is_never_sent_to_the_audio_service(self) -> None:
        previews = audio_module.AudioPreviews(self.hass, AUDIO_SERVICE, "test-audio-key-0123456789")
        self.hass.data[DOMAIN]["audio"] = previews
        self.addAsyncCleanup(previews.async_stop)
        self.session.route("GET", CLIP_URL, FakeResponse(206))
        self.plugin_visits.extend([heard("h1", 0), seen("s1", 0)])
        first, linked = await self.visits()
        self.assertEqual(first["audio"], clip_link(CLIP))
        self.assertEqual(linked["heard"]["audio_url"], clip_link(CLIP))
        for payload in (first, linked["heard"]):
            self.assertNotIn("audioInfo", payload)
            self.assertNotIn("audioOriginal", payload)
        self.assertEqual([url for _, url, _ in self.session.calls if url.startswith(AUDIO_SERVICE)], [])
        self.assertEqual(audio_module.detection_ids([heard("h1", 0), seen("s1", 0)]), [])
        self.assertIsNone(audio_module._visit_detection_id(heard("h1", 0)))


class MediaRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {}
        self.view = media_module.KestrelMediaView(self.hass)

    async def get(self, kind: str, media_id: str, **headers: str) -> object:
        return await self.view.get(types.SimpleNamespace(headers=headers), kind, media_id)

    async def test_a_clip_is_streamed_from_the_media_route_of_birdnet_go(self) -> None:
        self.session.route(
            "GET", CLIP_URL,
            FakeResponse(206, body=b"OPUSDATA", headers={"Content-Type": "audio/ogg", "Content-Range": "bytes 0-7/8"}),
        )
        response = await self.get("birdnet_clip", CLIP, Range="bytes=0-")
        self.assertEqual((response.status, response.body), (206, b"OPUSDATA"))
        self.assertEqual(response.headers["Content-Range"], "bytes 0-7/8")
        [(_, url, kwargs)] = self.session.calls
        self.assertEqual(url, CLIP_URL)
        self.assertEqual(kwargs["headers"], {"Range": "bytes=0-"}, "seeking works")

    async def test_a_clip_birdnet_go_does_not_have_is_a_404(self) -> None:
        self.session.route("GET", CLIP_URL, FakeResponse(404))
        self.assertEqual((await self.get("birdnet_clip", CLIP)).status, 404)

    async def test_hostile_names_are_answered_without_asking_birdnet_go(self) -> None:
        for clip in HOSTILE:
            if clip.strip():
                response = await self.get("birdnet_clip", clip)
                self.assertEqual(response.status, 404, repr(clip))
        self.assertEqual((await self.get("birdnet_clip", "")).status, 404)
        self.assertEqual(self.session.calls, [])

    async def test_only_a_clip_may_have_a_slash_in_its_link(self) -> None:
        for kind in ("birdnet_audio", "birdnet_preview", "snap", "crop", "clip", "audio", "species", "species_ref", "live"):
            self.assertEqual((await self.get(kind, "2026/10/x.opus")).status, 404, kind)
            self.assertEqual((await self.get(kind, "12/3")).status, 404, kind)
        self.assertEqual(self.session.calls, [])

    async def test_a_clip_name_is_no_detection_number(self) -> None:
        self.assertEqual((await self.get("birdnet_audio", CLIP)).status, 404)
        self.assertEqual(self.session.calls, [])


class SigningTests(unittest.TestCase):
    def test_the_link_keeps_the_slashes_of_a_clip_name_and_encodes_everything_else(self) -> None:
        hass = HomeAssistant()
        self.assertEqual(websocket_module._signed_media_url(hass, "birdnet_clip", CLIP, "t"), clip_link(CLIP))
        self.assertEqual(
            websocket_module._signed_media_url(hass, "species_ref", "Tamias striatus", "t"),
            "/api/kestrel/media/species_ref/Tamias%20striatus?authSig=FAKE",
        )
        self.assertEqual(
            websocket_module._signed_media_url(hass, "birdnet_audio", "1/2", "t"),
            "/api/kestrel/media/birdnet_audio/1%2F2?authSig=FAKE",
        )


if __name__ == "__main__":
    unittest.main()
