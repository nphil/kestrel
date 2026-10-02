"""Live camera pictures: the `picture` link on cameras and the no-store media route.

Runs the real media.py and websocket_api.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import types
import unittest

from ha_stubs import FakeResponse, FakeSession, HomeAssistant, const_module, media_module, websocket_module

DOMAIN = const_module.DOMAIN
JPEG = b"\xff\xd8 a live picture \xff\xd9"
VALIDATORS = {"ETag": '"abc123"', "Last-Modified": "Thu, 01 Oct 2026 12:00:00 GMT"}


def view_with_plugin(session: FakeSession) -> tuple:
    hass = HomeAssistant()
    client = types.SimpleNamespace(
        session=session,
        headers={"X-Kestrel-Key": "plugin-key"},
        media_url=lambda kind, media_id: f"http://plugin/media/{kind}/{media_id}",
    )
    hass.data.setdefault(DOMAIN, {})["coordinator"] = types.SimpleNamespace(client=client)
    return media_module.KestrelMediaView(hass)


def browser_request(**headers: str) -> types.SimpleNamespace:
    return types.SimpleNamespace(headers=headers)


class LiveMediaRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_live_picture_is_never_cached_and_keeps_the_plugins_validators(self) -> None:
        session = FakeSession()
        session.route(
            "GET", "http://plugin/media/live/108.jpg",
            FakeResponse(200, body=JPEG, headers={"Content-Type": "image/jpeg", "Cache-Control": "no-store", **VALIDATORS}),
        )
        response = await view_with_plugin(session).get(browser_request(), "live", "108.jpg")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, JPEG)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual({name: response.headers[name] for name in VALIDATORS}, VALIDATORS)

    async def test_a_plugin_reply_without_cache_headers_is_still_not_cached(self) -> None:
        session = FakeSession()
        session.route("GET", "http://plugin/media/live/108.jpg", FakeResponse(200, body=JPEG))
        response = await view_with_plugin(session).get(browser_request(), "live", "108.jpg")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_an_unchanged_picture_answers_304_without_a_body(self) -> None:
        session = FakeSession()
        session.route("GET", "http://plugin/media/live/108.jpg", FakeResponse(304, headers=VALIDATORS))
        response = await view_with_plugin(session).get(
            browser_request(**{"If-None-Match": '"abc123"', "If-Modified-Since": VALIDATORS["Last-Modified"]}),
            "live", "108.jpg",
        )
        sent = session.calls_to("GET", "http://plugin/media/live/108.jpg")[0]["headers"]
        self.assertEqual((sent["If-None-Match"], sent["If-Modified-Since"]), ('"abc123"', VALIDATORS["Last-Modified"]))
        self.assertEqual(sent["X-Kestrel-Key"], "plugin-key")
        self.assertEqual(response.status, 304)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["ETag"], '"abc123"')
        self.assertFalse(hasattr(response, "body"))

    async def test_other_media_keeps_its_five_minute_cache_and_ignores_conditional_requests(self) -> None:
        session = FakeSession()
        session.route("GET", "http://plugin/media/snap/abc.jpg", FakeResponse(200, body=JPEG))
        response = await view_with_plugin(session).get(browser_request(**{"If-None-Match": '"x"'}), "snap", "abc.jpg")
        self.assertEqual(response.headers["Cache-Control"], "private, max-age=300")
        self.assertNotIn("If-None-Match", session.calls_to("GET", "http://plugin/media/snap/abc.jpg")[0]["headers"])
        session.route("GET", "http://plugin/media/snap/abc.jpg", FakeResponse(304))
        again = await view_with_plugin(session).get(browser_request(), "snap", "abc.jpg")
        self.assertEqual(again.status, 502, "only live pictures understand 304")

    async def test_no_picture_at_all_is_a_plain_404(self) -> None:
        session = FakeSession()  # the plugin answers 404 for an unknown route
        response = await view_with_plugin(session).get(browser_request(), "live", "999.jpg")
        self.assertEqual(response.status, 404)


class CameraPictureLinkTests(unittest.TestCase):
    def test_every_camera_gets_a_signed_picture_and_latest_visit_photos_stay_separate(self) -> None:
        cameras = [
            {"id": "108", "name": "Tool Room", "nvrCardId": None, "picture": "media/live/108.jpg"},
            {"id": "88", "name": "Backyard", "nvrCardId": "x", "picture": "media/live/88.jpg",
             "lastDetection": {"visitId": "v1"}, "latest": "media/camera/88.jpg"},
        ]
        signed = websocket_module._sign_media_paths(HomeAssistant(), cameras, "token-1")
        self.assertEqual(signed[0]["picture"], "/api/kestrel/media/live/108.jpg?authSig=FAKE")
        self.assertEqual(signed[1]["picture"], "/api/kestrel/media/live/88.jpg?authSig=FAKE")
        self.assertEqual(signed[1]["latest"], "/api/kestrel/media/camera/88.jpg?authSig=FAKE")


if __name__ == "__main__":
    unittest.main()
