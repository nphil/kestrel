"""The options form: event wait plus the optional audio service address and key.

Runs Kestrel's real config_flow.py with Home Assistant's flow classes stubbed (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import types
import unittest

import voluptuous as vol

from ha_stubs import FakeResponse, FakeSession, HomeAssistant, SESSION, config_flow_module, reference_module

import aiohttp  # the stub installed by ha_stubs

URL = "http://audio.test:8787"
KEY = "test-audio-key-0123456789"
XC = reference_module.XC_API
XC_KEY = "xc-test-key-0123456789"


class OptionsFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.session.route("GET", f"{URL}/healthz", FakeResponse(200, {"ok": True}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(200, {"queue": {"depth": 0}}))

    def flow(self, options: dict | None = None) -> config_flow_module.KestrelOptionsFlow:
        flow = config_flow_module.KestrelOptionsFlow(types.SimpleNamespace(options=options or {}))
        flow.hass = HomeAssistant()
        return flow

    async def test_leaving_the_audio_fields_empty_turns_previews_off_without_contacting_anything(self) -> None:
        result = await self.flow().async_step_init({"poll_timeout": 25})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(
            result["data"],
            {"poll_timeout": 25, "audio_url": "", "audio_key": "", "audio_backfill_days": 30, "xeno_canto_key": ""},
        )
        self.assertEqual(self.session.calls, [])

    async def test_a_working_address_and_key_are_saved_tidied_and_checked_with_the_key(self) -> None:
        result = await self.flow().async_step_init(
            {"poll_timeout": 10, "audio_url": f"{URL}/", "audio_key": f"  {KEY} ", "audio_backfill_days": 7}
        )
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(
            result["data"],
            {"poll_timeout": 10, "audio_url": URL, "audio_key": KEY, "audio_backfill_days": 7, "xeno_canto_key": ""},
        )
        [stats] = self.session.calls_to("GET", f"{URL}/v1/stats")
        self.assertEqual(stats["headers"], {"X-Kestrel-Audio-Key": KEY})
        [health] = self.session.calls_to("GET", f"{URL}/healthz")
        self.assertNotIn("headers", health, "the open health check never carries the key")

    async def test_an_address_without_a_key_or_a_key_without_an_address_is_refused(self) -> None:
        for user_input in ({"audio_url": URL}, {"audio_key": KEY}, {"audio_url": "audio.test:8787", "audio_key": KEY}):
            result = await self.flow().async_step_init({"poll_timeout": 25, **user_input})
            self.assertEqual(result["type"], "form", user_input)
            self.assertEqual(result["errors"], {"base": "audio_incomplete"}, user_input)
        self.assertEqual(self.session.calls, [])

    async def test_a_rejected_key_is_reported_as_such(self) -> None:
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(401, {"error": "unauthorized"}))
        result = await self.flow().async_step_init({"poll_timeout": 25, "audio_url": URL, "audio_key": KEY})
        self.assertEqual(result["errors"], {"base": "audio_invalid_auth"})

    async def test_an_address_that_does_not_answer_is_reported_as_unreachable(self) -> None:
        for health in (FakeResponse(500), aiohttp.ClientError("connection refused")):
            self.session.route("GET", f"{URL}/healthz", health)
            result = await self.flow().async_step_init({"poll_timeout": 25, "audio_url": URL, "audio_key": KEY})
            self.assertEqual(result["errors"], {"base": "audio_cannot_connect"})
        self.session.route("GET", f"{URL}/healthz", FakeResponse(200, {"ok": True}))
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(503))
        result = await self.flow().async_step_init({"poll_timeout": 25, "audio_url": URL, "audio_key": KEY})
        self.assertEqual(result["errors"], {"base": "audio_cannot_connect"})

    async def test_the_form_keeps_what_was_typed_after_an_error_and_shows_saved_values_at_first(self) -> None:
        failed = await self.flow().async_step_init({"poll_timeout": 12, "audio_url": URL})
        suggested = {marker.schema: marker.description for marker in failed["data_schema"].schema}
        self.assertEqual(suggested["audio_url"], {"suggested_value": URL})

        saved = {"poll_timeout": 7, "audio_url": URL, "audio_key": KEY}
        form = await self.flow(saved).async_step_init()
        self.assertEqual(form["type"], "form")
        markers = {marker.schema: marker for marker in form["data_schema"].schema}
        self.assertEqual(markers["poll_timeout"].default(), 7)
        self.assertEqual(markers["audio_url"].description, {"suggested_value": URL})
        self.assertEqual(markers["audio_key"].description, {"suggested_value": KEY})
        self.assertEqual(markers["audio_backfill_days"].default(), 30, "30 when never set")

    async def test_the_backfill_setting_defaults_to_thirty_is_remembered_and_stays_between_zero_and_thirty(self) -> None:
        saved = await self.flow({"audio_backfill_days": 0}).async_step_init()
        markers = {marker.schema: marker for marker in saved["data_schema"].schema}
        self.assertEqual(markers["audio_backfill_days"].default(), 0, "0 means new calls only, and is kept")
        schema = saved["data_schema"]
        for good in (0, 1, 30):
            self.assertEqual(schema({"poll_timeout": 25, "audio_backfill_days": good})["audio_backfill_days"], good)
        for bad in (-1, 31):
            with self.assertRaises(vol.Invalid):
                schema({"poll_timeout": 25, "audio_backfill_days": bad})
        result = await self.flow().async_step_init({"poll_timeout": 25, "audio_backfill_days": 0})
        self.assertEqual(result["data"]["audio_backfill_days"], 0)

    async def test_the_audio_fields_are_optional_and_the_event_wait_stays_in_range(self) -> None:
        form = await self.flow().async_step_init()
        schema = form["data_schema"]
        self.assertEqual(schema({"poll_timeout": 25})["poll_timeout"], 25)
        for bad in (0, 99):
            with self.assertRaises(vol.Invalid):
                schema({"poll_timeout": bad})

    async def test_a_xeno_canto_key_is_saved_tidied_and_checked_with_xeno_canto(self) -> None:
        self.session.route("GET", XC, FakeResponse(200, {"numRecordings": "1", "recordings": []}))
        result = await self.flow().async_step_init({"poll_timeout": 25, "xeno_canto_key": f"  {XC_KEY} "})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(result["data"]["xeno_canto_key"], XC_KEY)
        [check] = self.session.calls_to("GET", XC)
        self.assertEqual(check["params"]["key"], XC_KEY)
        self.assertEqual(self.session.calls_to("GET", f"{URL}/healthz"), [], "the audio service was not involved")

    async def test_a_key_xeno_canto_refuses_or_cannot_check_is_reported_on_its_own_field(self) -> None:
        for answer, error in (
            (FakeResponse(401, {"error": "client_error"}), "xeno_canto_invalid_key"),
            (FakeResponse(403), "xeno_canto_invalid_key"),
            (FakeResponse(500), "xeno_canto_cannot_connect"),
            (aiohttp.ClientError("offline"), "xeno_canto_cannot_connect"),
        ):
            self.session.route("GET", XC, answer)
            result = await self.flow().async_step_init({"poll_timeout": 25, "xeno_canto_key": XC_KEY})
            self.assertEqual(result["type"], "form", error)
            self.assertEqual(result["errors"], {"xeno_canto_key": error})
            suggested = {marker.schema: marker.description for marker in result["data_schema"].schema}
            self.assertEqual(suggested["xeno_canto_key"], {"suggested_value": XC_KEY}, "what was typed stays in the form")

    async def test_a_bad_audio_service_and_a_bad_key_are_both_reported(self) -> None:
        self.session.route("GET", f"{URL}/v1/stats", FakeResponse(401, {"error": "unauthorized"}))
        self.session.route("GET", XC, FakeResponse(401, {"error": "client_error"}))
        result = await self.flow().async_step_init(
            {"poll_timeout": 25, "audio_url": URL, "audio_key": KEY, "xeno_canto_key": XC_KEY}
        )
        self.assertEqual(result["errors"], {"base": "audio_invalid_auth", "xeno_canto_key": "xeno_canto_invalid_key"})

    async def test_the_saved_xeno_canto_key_is_offered_again_and_the_field_is_optional(self) -> None:
        form = await self.flow({"poll_timeout": 7, "xeno_canto_key": XC_KEY}).async_step_init()
        markers = {marker.schema: marker for marker in form["data_schema"].schema}
        self.assertEqual(markers["xeno_canto_key"].description, {"suggested_value": XC_KEY})
        self.assertEqual(form["data_schema"]({"poll_timeout": 25}).get("xeno_canto_key"), None)


if __name__ == "__main__":
    unittest.main()
