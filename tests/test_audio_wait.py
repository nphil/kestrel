"""A slow BirdNET-Go check holds a request up once, and the two lookups behind a visit answer run side by side.

Before, a recording whose check had not answered (BirdNET-Go slow or stuck) made EVERY request that showed it wait the full
1.5 seconds again (the running check was joined but never aged), and the audio preview prefetch and the availability check were
waited for one after the other, so opening a species could wait for the sum of both. Runs the real websocket_api.py and
birdnet_availability.py with Home Assistant faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest import mock

from ha_stubs import FakeSession, HomeAssistant, SESSION, audio_module, const_module, websocket_module

DOMAIN = const_module.DOMAIN
availability = websocket_module.birdnet_availability
WAIT = 0.5  # stands in for _AUDIO_CHECK_WAIT_S: long enough to measure, short enough for a test


def heard_visit(detection_id: int = 360) -> dict:
    clip = "2026/10/cyanocitta_cristata_36p_20261002T133155Z.opus"
    return {"id": "h1", "kind": "heard", "species": "Blue Jay", "grp": "bird", "audio": {"birdnetDetectionId": detection_id, "birdnetClip": clip}}


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class Clocked(unittest.IsolatedAsyncioTestCase):
    async def took(self, work: object) -> float:
        loop = asyncio.get_running_loop()
        began = loop.time()
        await work  # type: ignore[misc]
        return loop.time() - began


class CheckWaitTests(Clocked):
    async def asyncSetUp(self) -> None:
        SESSION["session"] = FakeSession()
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {}
        self.finished: dict[str, asyncio.Event] = {}
        self.asked: list[str] = []

        async def stuck_check(hass: object, media_id: str) -> bool:
            self.asked.append(media_id)
            await self.finished.setdefault(media_id, asyncio.Event()).wait()
            return True

        for patcher in (
            mock.patch.object(availability, "_check_audio", stuck_check),
            mock.patch.object(availability, "_AUDIO_CHECK_WAIT_S", WAIT),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_a_stuck_check_holds_up_the_request_that_started_it_and_no_other(self) -> None:
        first = await self.took(availability.async_confirm_audio(self.hass, heard_visit()))
        self.assertGreaterEqual(first, WAIT * 0.9, "the request that started the check waits for it, up to the limit")
        second = await self.took(availability.async_confirm_audio(self.hass, heard_visit()))
        self.assertLess(second, WAIT * 0.4, "the check has run for the limit already: nothing is left to wait for")
        self.assertEqual(len(self.asked), 1, "and the second request joined the running check instead of starting another")

        self.finished[self.asked[0]].set()  # BirdNET-Go answers at last: the verdict is remembered
        for _ in range(25):
            await asyncio.sleep(0)
        third = await self.took(availability.async_confirm_audio(self.hass, heard_visit()))
        self.assertLess(third, WAIT * 0.4)
        self.assertEqual(len(self.asked), 1, "a recording with a verdict is not checked again")

    async def test_a_request_that_comes_part_way_waits_only_for_what_is_left(self) -> None:
        starter = asyncio.ensure_future(availability.async_confirm_audio(self.hass, heard_visit()))
        await asyncio.sleep(WAIT * 0.6)
        rest = await self.took(availability.async_confirm_audio(self.hass, heard_visit()))
        self.assertLess(rest, WAIT * 0.8, "not a whole new wait")
        await starter

    async def test_a_check_that_ends_without_a_verdict_is_forgotten_so_the_next_request_starts_a_fresh_one(self) -> None:
        async def no_verdict(hass: object, media_id: str) -> None:
            self.asked.append(media_id)

        with mock.patch.object(availability, "_check_audio", no_verdict):
            await availability.async_confirm_audio(self.hass, heard_visit())
            await availability.async_confirm_audio(self.hass, heard_visit())
        self.assertEqual(len(self.asked), 2, "no verdict leaves the cache empty, so it is asked again")
        self.assertEqual(self.hass.data[DOMAIN][availability._AUDIO_STARTED], {}, "and no stale start time is left to shorten the next wait")


class SideBySideTests(Clocked):
    async def test_the_preview_prefetch_and_the_availability_check_wait_side_by_side(self) -> None:
        SESSION["session"] = FakeSession()

        async def async_request(method: str, path: str, **kwargs: object) -> object:
            return heard_visit()

        async def slow(*args: object) -> None:
            await asyncio.sleep(WAIT)

        hass = HomeAssistant()
        previews = audio_module.AudioPreviews(hass, "http://audio.test:8787", "test-audio-key-0123456789")
        hass.data[DOMAIN] = {
            "coordinator": types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request)),
            "audio": previews,
        }
        connection = FakeConnection()
        previews.async_prefetch = slow  # type: ignore[method-assign]
        with mock.patch.object(availability, "async_confirm_audio", slow):
            took = await self.took(websocket_module._async_api_call(hass, connection, {"id": 9}, "GET", "visits/h1"))
        self.assertEqual((connection.errors, len(connection.results)), ([], 1))
        self.assertGreaterEqual(took, WAIT * 0.9)
        self.assertLess(took, WAIT * 1.6, "one wait for both lookups, not the two of them added up")


if __name__ == "__main__":
    unittest.main()
