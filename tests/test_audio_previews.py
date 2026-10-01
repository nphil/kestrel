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


def info_json(state: str, detection_id: int, *, cleaned: bool = False, method: str = "trim") -> dict:
    ready = state == "ready"
    return {
        "detectionId": detection_id, "state": state,
        "segment": {"start": 2.0, "end": 7.5, "source": "perch"} if ready else None,
        "method": method if ready else None, "cleaned": cleaned and ready,
        "scores": None, "loudnessLufs": -16.0 if ready else None, "durationS": 5.5 if ready else None,
        "createdAt": "2026-10-01T22:00:00Z", "readyAt": None, "queuePosition": None if ready else 1,
        "error": "boom" if state == "failed" else None,
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
            "visitId": "h1", "species": "Carolina Wren", "hasAudio": True, "birdnetDetectionId": 360, "birdnetClip": None}}
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
