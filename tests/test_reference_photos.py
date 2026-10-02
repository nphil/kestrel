"""Reference photos: the add-on may simply not have one, and that is an ordinary answer, not an error.

Runs the real media.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import types
import unittest

from ha_stubs import FakeResponse, FakeSession, HomeAssistant, SESSION, const_module, media_module

JPEG = b"\xff\xd8 a reference photo \xff\xd9"
PHOTO = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2/media/image/Tamias%20striatus"
AUDIO = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2/audio/12"


def browser_request() -> types.SimpleNamespace:
    return types.SimpleNamespace(headers={})


class ReferencePhotoRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.view = media_module.KestrelMediaView(HomeAssistant())

    async def test_a_photo_the_add_on_does_not_have_is_no_content_so_the_browser_logs_no_failed_request(self) -> None:
        for upstream in (404, 202, 503):  # not found, still being fetched, still resolving
            self.session.route("GET", PHOTO, FakeResponse(upstream))
            response = await self.view.get(browser_request(), "species_ref", "Tamias striatus")
            self.assertEqual(response.status, 204, upstream)
            # Short, so a photo that turns up later is not hidden for long.
            self.assertEqual(response.headers["Cache-Control"], "private, max-age=300", upstream)

    async def test_a_photo_that_exists_is_streamed_and_kept_for_a_long_time(self) -> None:
        self.session.route("GET", PHOTO, FakeResponse(200, body=JPEG, headers={"Content-Type": "image/jpeg"}))
        response = await self.view.get(browser_request(), "species_ref", "Tamias striatus")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, JPEG)
        self.assertEqual(response.headers["Cache-Control"], "public, max-age=2592000")

    async def test_a_real_failure_of_the_add_on_is_still_a_bad_gateway(self) -> None:
        self.session.route("GET", PHOTO, FakeResponse(500))
        response = await self.view.get(browser_request(), "species_ref", "Tamias striatus")
        self.assertEqual(response.status, 502)

    async def test_other_media_that_is_missing_is_still_an_error(self) -> None:
        """Only a reference photo is optional decoration: a recording that was never saved is a 404 (the panel's player says so)."""
        self.session.route("GET", AUDIO, FakeResponse(404))
        response = await self.view.get(browser_request(), "birdnet_audio", "12")
        self.assertEqual(response.status, 404)
