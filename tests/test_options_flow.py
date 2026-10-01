"""The options form: event wait plus the optional audio service address and key.

Runs Kestrel's real config_flow.py with Home Assistant's flow classes stubbed (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import types
import unittest

import voluptuous as vol

from ha_stubs import FakeResponse, FakeSession, HomeAssistant, SESSION, config_flow_module

import aiohttp  # the stub installed by ha_stubs

URL = "http://audio.test:8787"
KEY = "test-audio-key-0123456789"


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
        self.assertEqual(result["data"], {"poll_timeout": 25, "audio_url": "", "audio_key": ""})
        self.assertEqual(self.session.calls, [])

    async def test_a_working_address_and_key_are_saved_tidied_and_checked_with_the_key(self) -> None:
        result = await self.flow().async_step_init(
            {"poll_timeout": 10, "audio_url": f"{URL}/", "audio_key": f"  {KEY} "}
        )
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(result["data"], {"poll_timeout": 10, "audio_url": URL, "audio_key": KEY})
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

    async def test_the_audio_fields_are_optional_and_the_event_wait_stays_in_range(self) -> None:
        form = await self.flow().async_step_init()
        schema = form["data_schema"]
        self.assertEqual(schema({"poll_timeout": 25})["poll_timeout"], 25)
        for bad in (0, 99):
            with self.assertRaises(vol.Invalid):
                schema({"poll_timeout": bad})


if __name__ == "__main__":
    unittest.main()
