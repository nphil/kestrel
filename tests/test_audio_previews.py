"""Bird-call previews: what payloads say, what gets sent to the audio service, and when.

Runs the real audio.py and websocket_api.py with Home Assistant, BirdNET-Go and the audio
service all faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import json
import time
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
    event,
    new_coordinator,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

URL = "http://audio.test:8787"
KEY = "test-audio-key-0123456789"
BIRDNET = "http://db21ed7f-birdnet-go:8080"
DOMAIN = const_module.DOMAIN
SIGNAL = const_module.SIGNAL_EVENTS
PREVIEW = "/api/kestrel/media/birdnet_preview/360?authSig=FAKE"
ORIGINAL = "/api/kestrel/media/birdnet_audio/360?authSig=FAKE"


def call(visit_id: str, detection_id: int, *, species: str = "Carolina Wren", age_ms: int = 1000, **extra: object) -> dict:
    """A heard visit as the plugin returns it."""
    return {
        "id": visit_id, "kind": "heard", "species": species, "grp": "bird",
        "startedAt": int(time.time() * 1000) - age_ms,
        "camera": {"id": "88", "name": "Backyard Camera"},
        "audio": {"birdnetDetectionId": detection_id, "birdnetClip": "clip.wav"},
        **extra,
    }


def info_json(state: str, detection_id: int, *, cleaned: bool = False, method: str = "trim", **extra: object) -> dict:
    ready = state == "ready"
    return {
        "detectionId": detection_id, "state": state,
        "segment": {"start": 2.0, "end": 7.5, "source": "perch"} if ready else None,
        "method": method if ready else None, "cleaned": cleaned and ready,
        "scores": None, "loudnessLufs": -16.0 if ready else None, "durationS": 5.5 if ready else None,
        "createdAt": "2026-10-01T22:00:00Z", "readyAt": None, "queuePosition": None if ready else 1,
        "error": "boom" if state == "failed" else None,
        **extra,
    }


ALTERNATIVES = [
    {"species": "Barred Owl", "scientific": "Strix varia", "score": 0.4213, "raw": 0.2, "windowsHigh": 3, "window": {"start": 1.0, "end": 6.0}},
    {"species": "Great Horned Owl", "scientific": "Bubo virginianus", "score": 0.2, "raw": 0.1, "windowsHigh": 1, "window": {"start": 4.5, "end": 9.5}},
]
ANNOUNCED = {"species": "Carolina Wren", "scientific": "Thryothorus ludovicianus", "score": 0.1021, "raw": 0.05, "windowsHigh": 2,
             "window": {"start": 2.0, "end": 7.0}, "rank": 4}
BIRDNET_LIST = {
    "species": [
        {"label": "Strix varia_Barred Owl", "scientificName": "Strix varia", "commonName": "Barred Owl"},
        {"label": "Cyanocitta cristata_Blue Jay", "scientificName": "Cyanocitta cristata", "commonName": "Blue Jay"},
        {"label": "_Nameless", "scientificName": "  ", "commonName": "Nameless"},
    ],
    "count": 3, "lastUpdated": "2026-10-03T21:30:39.895374856-04:00", "threshold": 0.03, "genera": ["Strix", "Cyanocitta"],
}


async def settle() -> None:
    for _ in range(25):
        await asyncio.sleep(0)


class AudioTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {"birdnet_species_map": {"carolina wren": "Thryothorus ludovicianus"}}
        self.previews = audio_module.AudioPreviews(self.hass, URL, KEY)
        self.hass.data[DOMAIN]["audio"] = self.previews
        for name, value in (("_ORIGINAL_RETRY_DELAYS", (0, 0, 0, 0)), ("_BACKFILL_WAIT", 0),
                            ("_BACKFILL_PACE", 0), ("_BACKFILL_KNOWN_PACE", 0)):
            patcher = mock.patch.object(audio_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(websocket_module.birdnet_availability, "audio_available_now", lambda hass, detection: True)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asyncTearDown(self) -> None:
        await self.previews.async_stop()

    def info_route(self, detection_id: int, *responses: object) -> None:
        self.session.route("GET", f"{URL}/v1/previews/{detection_id}/info", *responses)

    def original_route(self, detection_id: int, *responses: object) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/{detection_id}", *responses)

    def job_route(self, *responses: object) -> None:
        self.session.route("POST", f"{URL}/v1/jobs", *responses)

    def serve_original(self, detection_id: int = 360) -> None:
        self.original_route(detection_id, FakeResponse(200, body=b"OGGDATA", headers={"Content-Type": "audio/ogg", "Content-Length": "7"}))

    def sign(self, payload: object) -> object:
        return websocket_module._sign_media_paths(self.hass, payload, "token-1")

    def jobs(self) -> list[dict]:
        return self.session.calls_to("POST", f"{URL}/v1/jobs")

    def register_plugin(self, script: list) -> object:
        coordinator = new_coordinator(script, self.hass)
        self.hass.data[DOMAIN]["coordinator"] = coordinator
        return coordinator


class PayloadTests(AudioTestCase):
    async def test_a_ready_preview_becomes_the_audio_and_the_original_stays_available(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360, cleaned=True, method="gate")))
        visit = call("h1", 360)
        await self.previews.async_prefetch(visit)
        signed = self.sign(visit)
        self.assertEqual(signed["audio"], PREVIEW)
        self.assertEqual(signed["audioOriginal"], ORIGINAL)
        self.assertEqual(
            signed["audioInfo"],
            {"state": "ready", "segment": {"start": 2.0, "end": 7.5}, "cleaned": True, "method": "gate"},
        )

    async def test_a_pending_or_failed_preview_keeps_the_original_and_says_why(self) -> None:
        for state in ("pending", "failed"):
            self.info_route(360, FakeResponse(200, info_json(state, 360)))
            self.previews._cache.clear()
            visit = call("h1", 360)
            await self.previews.async_prefetch(visit)
            signed = self.sign(visit)
            self.assertEqual(signed["audio"], ORIGINAL, state)
            self.assertNotIn("audioOriginal", signed, state)
            self.assertEqual(signed["audioInfo"], {"state": state, "segment": None, "cleaned": False, "method": None})

    async def test_a_call_the_service_knows_nothing_about_keeps_todays_payload(self) -> None:
        visit = call("h1", 360)  # the fake service answers 404 for it
        await self.previews.async_prefetch(visit)
        signed = self.sign(visit)
        self.assertEqual(signed["audio"], ORIGINAL)
        self.assertNotIn("audioInfo", signed)
        self.assertNotIn("audioOriginal", signed)

    async def test_without_a_configured_service_nothing_changes_and_nothing_is_asked(self) -> None:
        unconfigured = audio_module.AudioPreviews(self.hass, None, None)
        self.hass.data[DOMAIN]["audio"] = unconfigured
        visit = call("h1", 360)
        await unconfigured.async_prefetch(visit)
        signed = self.sign(visit)
        self.assertEqual(signed["audio"], ORIGINAL)
        self.assertNotIn("audioInfo", signed)
        self.assertEqual(self.session.calls, [])

    async def test_a_seen_visits_heard_call_gets_the_same_treatment(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        seen_visit = {"id": "s1", "kind": "seen", "heard": {
            "visitId": "h1", "species": "Carolina Wren", "hasAudio": True, "birdnetDetectionId": 360, "birdnetClip": "clip.wav"}}
        await self.previews.async_prefetch(seen_visit)
        heard = self.sign(seen_visit)["heard"]
        self.assertEqual(heard["audio_url"], PREVIEW)
        self.assertEqual(heard["audioOriginal"], ORIGINAL)
        self.assertEqual(heard["audioInfo"]["state"], "ready")

    async def test_calls_deep_inside_a_payload_are_looked_up_once_and_in_one_go(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        self.info_route(361, FakeResponse(200, info_json("pending", 361)))
        payload = {"species": "Carolina Wren", "calls": [call("h1", 360), call("h2", 361)]}
        await self.previews.async_prefetch(payload)
        await self.previews.async_prefetch(payload)  # everything is cached now
        self.assertEqual(len(self.session.calls), 2)
        calls = self.sign(payload)["calls"]
        self.assertEqual([c["audioInfo"]["state"] for c in calls], ["ready", "pending"])

    async def test_the_key_goes_in_a_header_on_every_call_to_the_service(self) -> None:
        await self.previews.async_prefetch(call("h1", 360))
        kwargs = self.session.calls[0][2]
        self.assertEqual(kwargs["headers"], {"X-Kestrel-Audio-Key": KEY})
        self.assertNotIn(KEY, self.session.calls[0][1])

    async def test_while_the_service_is_down_payloads_carry_originals_and_the_outage_is_logged_once(self) -> None:
        self.info_route(360, aiohttp.ClientError("connection refused"))
        self.info_route(361, aiohttp.ClientError("connection refused"))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING") as logs:
            await self.previews.async_prefetch(call("h1", 360))
            await self.previews.async_prefetch(call("h2", 361))
        self.assertEqual(len(logs.records), 1)
        self.assertNotIn(KEY, logs.output[0])
        signed = self.sign(call("h1", 360))
        self.assertEqual(signed["audio"], ORIGINAL)
        self.assertNotIn("audioInfo", signed)
        self.assertEqual(len(self.session.calls), 1, "no more calls while it is known to be down")

    async def test_a_ready_preview_is_not_used_while_the_service_is_down(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        await self.previews.async_prefetch(call("h1", 360))
        self.previews._mark_unreachable("test")
        signed = self.sign(call("h1", 360))
        self.assertEqual(signed["audio"], ORIGINAL)
        self.assertNotIn("audioOriginal", signed)

    async def test_a_rejected_key_counts_as_unusable_not_as_a_missing_preview(self) -> None:
        self.info_route(360, FakeResponse(401, {"error": "unauthorized"}))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            await self.previews.async_prefetch(call("h1", 360))
        self.assertNotIn("audioInfo", self.sign(call("h1", 360)))


class SubmissionTests(AudioTestCase):
    async def test_a_new_heard_visit_is_sent_to_the_service_with_its_recording(self) -> None:
        self.serve_original()
        self.job_route(FakeResponse(202, {"detectionId": 360, "state": "pending", "queuePosition": 1}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        [job] = self.jobs()
        self.assertEqual(job["params"], {
            "detection_id": 360, "species": "Carolina Wren",
            "scientific": "Thryothorus ludovicianus", "camera": "Backyard Camera"})
        self.assertEqual(job["data"], b"OGGDATA")
        self.assertEqual(job["headers"], {"X-Kestrel-Audio-Key": KEY, "Content-Type": "audio/ogg"})
        self.assertEqual(self.previews.fields(360).state, "pending")

    async def test_without_a_known_scientific_name_the_job_still_goes_out(self) -> None:
        self.serve_original(361)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h2", 361, species="Mystery Warbler"))])
        await settle()
        self.assertNotIn("scientific", self.jobs()[0]["params"])

    async def test_seen_visits_and_heard_visits_without_a_recording_id_are_ignored(self) -> None:
        self.previews.async_start()
        seen_visit = call("s1", 360)
        seen_visit["kind"] = "seen"
        no_id = call("h9", 360)
        no_id["audio"] = {"birdnetDetectionId": None, "birdnetClip": None}
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", seen_visit), event("visit_new", no_id)])
        await settle()
        self.assertEqual(self.session.calls, [])

    async def test_the_same_recording_is_sent_once(self) -> None:
        self.serve_original()
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360)), event("visit_new", call("h1", 360))])
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        self.assertEqual(len(self.jobs()), 1)

    async def test_a_recording_that_lands_late_is_retried_then_sent(self) -> None:
        self.original_route(
            360,
            FakeResponse(404, {"error": "not_found"}),
            FakeResponse(200, body=b"OGGDATA", headers={"Content-Type": "audio/ogg"}),
        )
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        self.assertEqual(len(self.session.calls_to("GET", f"{BIRDNET}/api/v2/audio/360")), 2)
        self.assertEqual(len(self.jobs()), 1)

    async def test_a_recording_that_never_appears_is_given_up_without_bothering_the_service(self) -> None:
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        self.assertEqual(len(self.session.calls_to("GET", f"{BIRDNET}/api/v2/audio/360")), 5)
        self.assertEqual(self.jobs(), [])
        self.assertIn(360, self.previews._no_original)

    async def test_a_job_the_service_already_finished_is_recorded_as_ready(self) -> None:
        self.serve_original()
        self.job_route(FakeResponse(200, {"detectionId": 360, "state": "ready"}))
        self.info_route(360, FakeResponse(200, info_json("ready", 360, cleaned=True)))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        info = self.previews.fields(360)
        self.assertEqual((info.state, info.cleaned), ("ready", True))
        self.assertEqual(self.previews._pending, {})

    async def test_an_unreachable_service_drops_the_job_and_keeps_playing_originals(self) -> None:
        self.serve_original()
        self.job_route(aiohttp.ClientError("connection refused"))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            self.previews.async_start()
            async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
            await settle()
        self.assertIsNone(self.previews.fields(360))
        self.assertEqual(self.previews._pending, {})


class TrackingTests(AudioTestCase):
    async def start_pending(self, visit: dict) -> list:
        self.serve_original()
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.register_plugin([visit])
        pushed: list[dict] = []
        remove = audio_module.async_dispatcher_connect(self.hass, SIGNAL, lambda events: pushed.extend(events))
        self.addCleanup(remove)
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", visit)])
        await settle()
        pushed.clear()  # drop the visit_new we just sent ourselves
        return pushed

    async def test_when_a_preview_turns_ready_open_dashboards_get_the_fresh_visit(self) -> None:
        visit = call("h1", 360)
        pushed = await self.start_pending(visit)
        self.info_route(360, FakeResponse(200, info_json("pending", 360)), FakeResponse(200, info_json("ready", 360)))
        await self.previews._track_once()
        self.assertEqual(pushed, [], "still pending: nothing to tell anyone")
        await self.previews._track_once()
        self.assertEqual(pushed, [{"type": "visit_updated", "data": visit}])
        self.assertEqual(self.previews._pending, {})
        self.assertEqual(self.previews.fields(360).state, "ready")

    async def test_a_preview_for_an_old_visit_is_not_pushed(self) -> None:
        visit = call("h1", 360, age_ms=7 * 3600 * 1000)
        pushed = await self.start_pending(visit)
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        await self.previews._track_once()
        self.assertEqual(pushed, [])
        self.assertEqual(self.previews.fields(360).state, "ready", "it is still used the next time the visit is fetched")

    async def test_a_failed_job_stops_being_tracked_without_a_push(self) -> None:
        pushed = await self.start_pending(call("h1", 360))
        self.info_route(360, FakeResponse(200, info_json("failed", 360)))
        await self.previews._track_once()
        self.assertEqual((pushed, self.previews._pending), ([], {}))
        self.assertEqual(self.previews.fields(360).state, "failed")


class DeleteTests(AudioTestCase):
    async def test_a_deleted_visits_preview_is_deleted_at_the_service(self) -> None:
        self.serve_original()
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.session.route("DELETE", f"{URL}/v1/previews/360", FakeResponse(200, {"deleted": True}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        async_dispatcher_send(self.hass, SIGNAL, [{"type": "visit_deleted", "data": {"id": "h1"}}])
        await settle()
        self.assertEqual(len(self.session.calls_to("DELETE", f"{URL}/v1/previews/360")), 1)
        self.assertIsNone(self.previews.fields(360))

    async def test_a_visit_seen_in_a_payload_can_be_cleaned_up_after_a_restart(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        visit = call("h1", 360)
        await self.previews.async_prefetch(visit)
        self.sign(visit)  # a dashboard looked at it, which is how its detection id is learned
        self.session.route("DELETE", f"{URL}/v1/previews/360", FakeResponse(200, {"deleted": True}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [{"type": "visit_deleted", "data": {"id": "h1"}}])
        await settle()
        self.assertEqual(len(self.session.calls_to("DELETE", f"{URL}/v1/previews/360")), 1)

    async def test_a_deleted_visit_nobody_knew_the_recording_of_asks_nothing(self) -> None:
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [{"type": "visit_deleted", "data": {"id": "never-seen"}}])
        await settle()
        self.assertEqual(self.session.calls, [])


class BackfillTests(AudioTestCase):
    def pages(self) -> tuple[list, int]:
        now = int(time.time() * 1000)
        month = 31 * 86400 * 1000
        return [
            {"items": [call("h3", 3, age_ms=1000), call("h2", 2, age_ms=2000)], "next": now - 2000},
            {"items": [call("h1", 1, age_ms=month)], "next": None},
        ], now - 2000

    async def test_it_sends_only_calls_without_a_preview_newest_first_and_stops_at_thirty_days(self) -> None:
        pages, cursor = self.pages()
        coordinator = self.register_plugin(pages)
        self.info_route(3, FakeResponse(200, info_json("ready", 3)))  # already done
        self.serve_original(2)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"waiting": 0, "running": 0, "depth": 0}}))
        await self.previews._backfill_once()
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [2])
        self.assertEqual(coordinator.client.calls[0], {"kind": "heard", "limit": 50})
        self.assertEqual(coordinator.client.calls[1]["before"], cursor)
        progress = self.previews._backfill
        self.assertEqual((progress.state, progress.scanned, progress.submitted, progress.already_known), ("done", 2, 1, 1))
        self.assertEqual(self.jobs()[0]["params"]["priority"], "low", "old calls queue behind new ones")

    async def test_it_waits_while_the_service_queue_is_busy(self) -> None:
        pages, _ = self.pages()
        self.register_plugin(pages)
        self.info_route(3, FakeResponse(200, info_json("ready", 3)))
        self.serve_original(2)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        busy = FakeResponse(200, {"queue": {"depth": 9}})
        self.session.route("GET", f"{URL}/v1/stats", busy, busy, FakeResponse(200, {"queue": {"depth": 0}}))
        await self.previews._backfill_once()
        self.assertEqual(len(self.session.calls_to("GET", f"{URL}/v1/stats")), 3)
        self.assertEqual(len(self.jobs()), 1)

    async def test_a_recording_birdnet_never_saved_is_skipped_and_remembered(self) -> None:
        pages, _ = self.pages()
        self.register_plugin(pages)
        self.info_route(3, FakeResponse(200, info_json("ready", 3)))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        await self.previews._backfill_once()  # the original for call 2 answers 404
        self.assertEqual(self.jobs(), [])
        self.assertEqual(self.previews._backfill.no_original, 1)
        self.assertIn(2, self.previews._no_original)

    async def test_it_stops_for_now_when_the_service_goes_away_mid_way(self) -> None:
        pages, _ = self.pages()
        self.register_plugin(pages)
        self.info_route(3, FakeResponse(200, info_json("ready", 3)))
        self.serve_original(2)
        self.job_route(aiohttp.ClientError("connection refused"))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            with self.assertRaises(audio_module.AudioServiceError):
                await self.previews._backfill_once()


class BackfillWindowTests(AudioTestCase):
    DAY = 86400 * 1000

    async def test_the_window_follows_the_setting(self) -> None:
        self.previews = audio_module.AudioPreviews(self.hass, URL, KEY, backfill_days=7)
        recent, old = call("h1", 1, age_ms=3 * self.DAY), call("h2", 2, age_ms=10 * self.DAY)
        self.register_plugin([{"items": [recent, old], "next": None}])
        for detection_id in (1, 2):  # both recordings exist: only the window decides which is sent
            self.serve_original(detection_id)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        await self.previews._backfill_once()
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [1])
        self.assertEqual(self.previews._backfill.state, "done")

    async def test_with_the_backfill_off_only_new_calls_are_sent_and_past_visits_are_never_listed(self) -> None:
        self.previews = audio_module.AudioPreviews(self.hass, URL, KEY, backfill_days=0)
        coordinator = self.register_plugin([{"items": [call("h1", 1)], "next": None}])
        self.serve_original(360)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        with mock.patch.object(audio_module, "_BACKFILL_START_DELAY", 0):
            self.previews.async_start()
            async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h9", 360))])
            await settle()
        self.assertEqual(self.previews._backfill.state, "off")
        self.assertEqual(coordinator.client.calls, [], "the plugin's visit list is never asked for")
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [360])
        self.assertNotIn("priority", self.jobs()[0]["params"], "a newly heard call is never queued behind old ones")
        self.assertEqual((await self.previews.async_diagnostics())["backfill_days"], 0)

    async def test_widening_the_window_later_sends_only_what_is_missing(self) -> None:
        newer, middle, older = call("h1", 1, age_ms=1 * self.DAY), call("h2", 2, age_ms=10 * self.DAY), call("h3", 3, age_ms=20 * self.DAY)
        for detection_id in (1, 2, 3):
            self.serve_original(detection_id)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        pages = {"items": [newer, middle, older], "next": None}

        self.previews = audio_module.AudioPreviews(self.hass, URL, KEY, backfill_days=7)
        self.register_plugin([pages])
        await self.previews._backfill_once()
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [1])

        # Home Assistant reloads with a wider window; the service already has call 1.
        self.info_route(1, FakeResponse(200, info_json("ready", 1)))
        self.previews = audio_module.AudioPreviews(self.hass, URL, KEY, backfill_days=30)
        self.register_plugin([pages])
        await self.previews._backfill_once()
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [1, 2, 3])

    async def test_running_the_same_pass_twice_never_sends_a_call_twice(self) -> None:
        visits = {"items": [call("h1", 1, age_ms=self.DAY), call("h2", 2, age_ms=2 * self.DAY)], "next": None}
        for detection_id in (1, 2):
            self.serve_original(detection_id)
        self.job_route(FakeResponse(202, {"state": "pending"}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        self.register_plugin([visits])
        await self.previews._backfill_once()
        for detection_id in (1, 2):  # the service now reports both as queued
            self.info_route(detection_id, FakeResponse(200, info_json("pending", detection_id)))
        self.previews._cache.clear()
        self.register_plugin([visits])
        await self.previews._backfill_once()
        self.assertEqual([job["params"]["detection_id"] for job in self.jobs()], [1, 2])


class ReliabilityTests(AudioTestCase):
    async def test_a_revoked_key_is_not_mistaken_for_a_healthy_service(self) -> None:
        # /healthz is open and keeps answering 200; only an authenticated call proves the key works.
        self.session.route("GET", f"{URL}/healthz", FakeResponse(200, {"ok": True}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(401, {"error": "unauthorized"}))
        with mock.patch.object(audio_module, "_HEALTH_INTERVAL", 0.01):
            with self.assertLogs("kestrel_pkg.audio", level="WARNING") as logs:
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(self.previews._wait_until_reachable(), 0.1)
        self.assertEqual(self.session.calls_to("GET", f"{URL}/healthz"), [])
        self.assertEqual(len(logs.records), 1, "logged once, not on every check")
        self.assertIs(self.previews._reachable, False)

    async def test_a_huge_answer_from_the_service_is_ignored_not_buffered(self) -> None:
        def huge(detection_id: int) -> bytes:  # a valid, "ready" answer padded far past any real one
            return json.dumps({**info_json("ready", detection_id), "padding": "x" * 300_000}).encode()

        declared = huge(360)
        self.info_route(360, FakeResponse(200, body=declared, headers={"Content-Length": str(len(declared))}))
        self.info_route(361, FakeResponse(200, body=huge(361)))  # no declared length: caught while streaming
        for detection_id in (360, 361):
            visit = call(f"h{detection_id}", detection_id)
            await self.previews.async_prefetch(visit)
            self.assertNotIn("audioInfo", self.sign(visit))

    async def test_an_absurdly_large_recording_is_not_downloaded_or_sent(self) -> None:
        self.original_route(360, FakeResponse(200, body=b"x", headers={"Content-Length": str(9 * 1024 * 1024)}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        self.assertEqual(self.jobs(), [])

    async def test_one_stalled_lookup_marks_the_service_down_so_later_requests_do_not_wait(self) -> None:
        self.info_route(360, FakeResponse(200, hang=True))
        with mock.patch.object(audio_module, "_PREFETCH_TIMEOUT", 0.05):
            with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
                await self.previews.async_prefetch(call("h1", 360))
        self.assertIs(self.previews._reachable, False)
        calls_before = len(self.session.calls)
        await self.previews.async_prefetch(call("h2", 361))
        self.assertEqual(len(self.session.calls), calls_before)

    async def test_an_upload_that_failed_is_sent_again_by_the_next_backfill(self) -> None:
        visit = call("h1", 360)
        self.serve_original()
        self.job_route(aiohttp.ClientError("connection refused"), FakeResponse(202, {"state": "pending"}))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            self.previews.async_start()
            async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", visit)])
            await settle()
        self.assertNotIn(360, self.previews._submitted)
        self.register_plugin([{"items": [visit], "next": None}])
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        await self.previews._backfill_once()
        self.assertEqual(len(self.jobs()), 2)
        self.assertEqual(self.previews.fields(360).state, "pending")

    async def test_a_birdnet_hiccup_is_not_remembered_as_a_recording_that_was_never_saved(self) -> None:
        pages, _ = BackfillTests.pages(self)
        self.register_plugin(pages)
        self.info_route(3, FakeResponse(200, info_json("ready", 3)))
        self.original_route(2, FakeResponse(500, {"error": "busy"}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))
        await self.previews._backfill_once()
        self.assertEqual(self.jobs(), [])
        self.assertNotIn(2, self.previews._no_original)
        self.assertEqual(self.previews._backfill.no_original, 0)

    async def test_deleting_a_visit_stops_its_upload_so_the_preview_is_never_recreated(self) -> None:
        self.original_route(360, FakeResponse(200, hang=True, headers={"Content-Type": "audio/ogg"}))  # download stalls
        self.session.route("DELETE", f"{URL}/v1/previews/360", FakeResponse(200, {"deleted": True}))
        self.previews.async_start()
        async_dispatcher_send(self.hass, SIGNAL, [event("visit_new", call("h1", 360))])
        await settle()
        async_dispatcher_send(self.hass, SIGNAL, [{"type": "visit_deleted", "data": {"id": "h1"}}])
        await settle()
        self.assertEqual(self.jobs(), [])
        self.assertEqual(len(self.session.calls_to("DELETE", f"{URL}/v1/previews/360")), 1)
        self.assertEqual(self.previews._submit_tasks, {})
        self.assertEqual(self.previews._live_inflight, 0)

    async def test_a_pending_job_found_by_the_backfill_is_announced_when_it_is_ready(self) -> None:
        visit = call("h1", 360)
        self.register_plugin([{"items": [visit], "next": None}, visit])  # the page, then the fresh copy for the push
        self.info_route(360, FakeResponse(200, info_json("pending", 360)))
        pushed: list[dict] = []
        remove = audio_module.async_dispatcher_connect(self.hass, SIGNAL, pushed.extend)
        self.addCleanup(remove)
        await self.previews._backfill_once()
        self.assertIn(360, self.previews._pending)
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        await self.previews._track_once()
        self.assertEqual(pushed, [{"type": "visit_updated", "data": visit}])

    async def test_a_pending_call_a_dashboard_looks_at_is_announced_when_it_is_ready(self) -> None:
        visit = call("h1", 360)
        self.register_plugin([visit])
        self.info_route(360, FakeResponse(200, info_json("pending", 360)))
        await self.previews.async_prefetch(visit)
        self.sign(visit)
        self.assertEqual(self.previews._pending[360].visit_id, "h1")
        pushed: list[dict] = []
        remove = audio_module.async_dispatcher_connect(self.hass, SIGNAL, pushed.extend)
        self.addCleanup(remove)
        self.info_route(360, FakeResponse(200, info_json("ready", 360)))
        await self.previews._track_once()
        self.assertEqual([event["type"] for event in pushed], ["visit_updated"])

    async def test_every_pending_job_gets_a_turn_not_just_the_first_ten(self) -> None:
        for number in range(12):
            self.previews.track(100 + number, f"h{number}", None)
            self.info_route(100 + number, FakeResponse(200, info_json("pending", 100 + number)))
        await self.previews._track_once()
        await self.previews._track_once()
        polled = {int(url.split("/")[-2]) for method, url, _ in self.session.calls if url.endswith("/info")}
        self.assertEqual(polled, set(range(100, 112)))


class PerchViewTests(AudioTestCase):
    """What Perch makes of the whole clip (the service's `alternatives`, `announced` and `scores`) reaches the dashboard unchanged in meaning."""

    async def ready_payload(self, **extra: object) -> dict:
        self.info_route(360, FakeResponse(200, info_json("ready", 360, **extra)))
        visit = call("h1", 360)
        await self.previews.async_prefetch(visit)
        return self.sign(visit)["audioInfo"]

    async def test_alternatives_the_announced_species_and_scores_are_passed_on(self) -> None:
        info = await self.ready_payload(scores={"original": 0.31, "preview": 0.33}, alternatives=ALTERNATIVES, announced=ANNOUNCED)
        self.assertEqual(info["scores"], {"original": 0.31, "preview": 0.33})
        self.assertEqual(
            info["alternatives"],
            [
                {"species": "Barred Owl", "scientific": "Strix varia", "score": 0.4213, "windowsHigh": 3, "window": {"start": 1.0, "end": 6.0}},
                {"species": "Great Horned Owl", "scientific": "Bubo virginianus", "score": 0.2, "windowsHigh": 1, "window": {"start": 4.5, "end": 9.5}},
            ],
        )
        self.assertEqual(
            info["announced"],
            {"species": "Carolina Wren", "scientific": "Thryothorus ludovicianus", "score": 0.1021, "windowsHigh": 2,
             "window": {"start": 2.0, "end": 7.0}, "rank": 4},
        )
        self.assertEqual((info["state"], info["method"]), ("ready", "trim"))

    async def test_a_heard_call_of_a_seen_visit_carries_them_too(self) -> None:
        self.info_route(360, FakeResponse(200, info_json("ready", 360, alternatives=ALTERNATIVES)))
        seen_visit = {"id": "s1", "kind": "seen", "heard": {
            "visitId": "h1", "species": "Carolina Wren", "hasAudio": True, "birdnetDetectionId": 360, "birdnetClip": "clip.wav"}}
        await self.previews.async_prefetch(seen_visit)
        heard = self.sign(seen_visit)["heard"]["audioInfo"]
        self.assertEqual([a["species"] for a in heard["alternatives"]], ["Barred Owl", "Great Horned Owl"])

    async def test_a_clip_perch_found_nothing_else_in_says_so_and_one_it_never_looked_at_says_nothing(self) -> None:
        looked = await self.ready_payload(alternatives=[])
        self.assertEqual(looked["alternatives"], [])
        self.previews._cache.clear()
        older = await self.ready_payload()  # a service (or a job) from before alternatives existed
        self.assertNotIn("alternatives", older)
        self.assertNotIn("announced", older)
        self.assertNotIn("scores", older)

    async def test_pending_and_failed_calls_carry_none_of_it(self) -> None:
        for state in ("pending", "failed"):
            self.previews._cache.clear()
            self.info_route(360, FakeResponse(200, info_json(state, 360, alternatives=ALTERNATIVES, announced=ANNOUNCED, scores={"original": 0.3})))
            visit = call("h1", 360)
            await self.previews.async_prefetch(visit)
            self.assertEqual(self.sign(visit)["audioInfo"], {"state": state, "segment": None, "cleaned": False, "method": None}, state)

    async def test_whatever_is_malformed_in_the_answer_is_dropped_instead_of_passed_on(self) -> None:
        bad = [
            {"species": "", "score": 0.5}, {"species": "Over", "score": 1.5}, {"species": "Words", "score": "high"}, {"species": "Flag", "score": True},
            {"score": 0.4}, "Bird", None, 7,
            {"species": " Good Bird ", "score": 0.3, "windowsHigh": -1, "window": {"start": "a", "end": 3}},
        ]
        info = await self.ready_payload(alternatives=bad, scores={"original": "x", "preview": 0.4}, announced={"species": "Wren", "score": 2})
        self.assertEqual(info["alternatives"], [{"species": "Good Bird", "scientific": None, "score": 0.3, "windowsHigh": None, "window": None}])
        self.assertEqual(info["scores"], {"original": None, "preview": 0.4})
        self.assertNotIn("announced", info)
        self.previews._cache.clear()
        for junk in ("x", {"a": 1}, 3):
            self.assertNotIn("alternatives", await self.ready_payload(alternatives=junk, scores=junk, announced=junk))
            self.previews._cache.clear()

    async def test_a_payload_never_carries_more_than_five_alternatives(self) -> None:
        many = [{"species": f"Bird {i}", "score": 0.9 - i / 100} for i in range(9)]
        info = await self.ready_payload(alternatives=many)
        self.assertEqual([a["species"] for a in info["alternatives"]], [f"Bird {i}" for i in range(5)])


class SpeciesListTests(AudioTestCase):
    """The service measures Perch against the species BirdNET-Go lets through here; Home Assistant keeps it told."""

    def serve_list(self, *responses: object) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/range/species/list", *(responses or (FakeResponse(200, BIRDNET_LIST),)))

    def take_list(self, *responses: object) -> None:
        answer = FakeResponse(200, {"count": 2, "matched": 2, "changed": True, "custom": True})
        self.session.route("PUT", f"{URL}/v1/local-species", *(responses or (answer,)))

    def puts(self) -> list[dict]:
        return self.session.calls_to("PUT", f"{URL}/v1/local-species")

    async def test_birdnet_gos_list_goes_to_the_service_as_names_only(self) -> None:
        self.serve_list()
        self.take_list()
        await self.previews._send_species()
        (put,) = self.puts()
        self.assertEqual(
            json.loads(put["data"]),
            {"source": "BirdNET-Go range filter", "updatedAt": "2026-10-03T21:30:39.895374856-04:00",
             "species": [{"scientific": "Strix varia", "common": "Barred Owl"}, {"scientific": "Cyanocitta cristata", "common": "Blue Jay"}]},
        )
        self.assertEqual(put["headers"], {"X-Kestrel-Audio-Key": KEY, "Content-Type": "application/json"})
        self.assertEqual((await self.previews.async_diagnostics())["local_species"], {"count": 2, "matched": 2, "changed": True})

    async def test_an_unchanged_list_is_sent_once_a_changed_one_is_sent_again(self) -> None:
        self.take_list()
        self.serve_list()
        await self.previews._send_species()
        await self.previews._send_species()
        self.assertEqual(len(self.puts()), 1)
        self.serve_list(FakeResponse(200, {**BIRDNET_LIST, "lastUpdated": "2026-10-04T08:00:00-04:00"}))
        await self.previews._send_species()
        self.assertEqual(len(self.puts()), 2)

    async def test_a_service_that_was_away_gets_the_list_again(self) -> None:
        self.take_list()
        self.serve_list()
        await self.previews._send_species()
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            self.previews._mark_unreachable("test")  # it may come back with an empty data folder
        await self.previews._send_species()
        self.assertEqual(len(self.puts()), 2)

    async def test_birdnet_go_being_down_or_confused_sends_nothing(self) -> None:
        for answer in (
            aiohttp.ClientError("refused"), FakeResponse(503), FakeResponse(200, {"species": []}), FakeResponse(200, body=b"not json"),
            FakeResponse(200, {"species": "x"}), FakeResponse(200, ["x"]),
        ):
            self.serve_list(answer)
            await self.previews._send_species()
        self.assertEqual(self.puts(), [])

    async def test_a_service_without_the_call_is_left_alone(self) -> None:
        self.serve_list()  # the fake service answers 404 to the PUT, as a service from before the species list does
        await self.previews._send_species()
        diagnostics = await self.previews.async_diagnostics()
        self.assertIsNone(diagnostics["local_species"])
        self.assertIs(diagnostics["reachable"], True)

    async def test_the_service_being_down_is_an_error_for_the_loop_to_retry_not_a_crash(self) -> None:
        self.serve_list()
        self.take_list(aiohttp.ClientError("connection refused"))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"), self.assertRaises(audio_module.AudioServiceError):
            await self.previews._send_species()
        self.take_list()
        await self.previews._send_species()
        self.assertEqual(len(self.puts()), 2)

    async def test_the_loop_sends_the_list_soon_after_start_and_stops_with_the_integration(self) -> None:
        self.serve_list()
        self.take_list()
        with mock.patch.object(audio_module, "_SPECIES_START_DELAY", 0), mock.patch.object(audio_module, "_SPECIES_INTERVAL", 3600):
            self.previews.async_start()
            await settle()
            await settle()
        self.assertEqual(len(self.puts()), 1)
        await self.previews.async_stop()
        self.assertEqual(self.previews._tasks, set())


class DiagnosticsTests(AudioTestCase):
    async def test_diagnostics_show_the_service_stats_and_never_the_key(self) -> None:
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"service": "kestrel-audio", "queue": {"depth": 2}}))
        diagnostics = await self.previews.async_diagnostics()
        self.assertEqual(diagnostics["stats"]["queue"]["depth"], 2)
        self.assertTrue(diagnostics["configured"])
        self.assertNotIn(KEY, json.dumps(diagnostics))

    async def test_diagnostics_say_so_when_the_service_cannot_be_reached(self) -> None:
        self.session.route("GET", f"{URL}/v1/stats", aiohttp.ClientError("connection refused"))
        with self.assertLogs("kestrel_pkg.audio", level="WARNING"):
            diagnostics = await self.previews.async_diagnostics()
        self.assertIn("error", diagnostics["stats"])
        self.assertIs(diagnostics["reachable"], False)


if __name__ == "__main__":
    unittest.main()
