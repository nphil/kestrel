"""What a recording shows beside its player: the weather when the bird called, and a picture of its sound.

Runs the real recording_extras.py, birdnet_availability.py, websocket_api.py and media.py with Home Assistant, the Kestrel plugin and
BirdNET-Go faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import json
import types
import unittest
from unittest import mock
from urllib.parse import unquote

import voluptuous as vol
from ha_stubs import (
    FakeResponse,
    FakeSession,
    HomeAssistant,
    KestrelApiError,
    SESSION,
    const_module,
    media_module,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

extras_module = importlib.import_module("kestrel_pkg.recording_extras")

BIRDNET = const_module.BIRDNET_GO_INTERNAL_URL
DOMAIN = const_module.DOMAIN
CLIP = "2026/11/ardea_nycticorax_68p_20261115T031500Z.opus"
PNG = b"\x89PNG\r\n\x1a\n a spectrogram"
NIGHT = {"temp": 8, "unit": "\u00b0C", "conditions": "Clear", "icon": "mdi:weather-night"}


def weather(code: str = "clearsky_night", main: str = "", icon: str = "", temperature: object = 7.8, time_of_day: str = "night") -> dict:
    """BirdNET-Go's /weather/detection answer (checked live: a Yr.no symbol code in weather_desc and "01" as the icon)."""
    return {
        "daily": {"date": "2026-11-15", "sunrise": "2026-11-15T11:41:00Z", "sunset": "2026-11-15T21:36:00Z"},
        "hourly": {
            "time": "2026-11-15T03:00:00Z", "temperature": temperature, "feels_like": 6.0, "pressure": 1015, "humidity": 70,
            "wind_speed": 2.1, "wind_deg": 180, "weather_main": main, "weather_desc": code, "weather_icon": icon,
        },
        "time_of_day": time_of_day,
    }


def heard(visit_id: str, detection_id: int, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "heard", "species": "Black-crowned Night Heron", "grp": "bird", "startedAt": 1,
        "audio": {"birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


def seen(visit_id: str, detection_id: int, clip: object = CLIP) -> dict:
    return {
        "id": visit_id, "kind": "seen", "species": "Black-crowned Night Heron", "grp": "bird", "clip": {"state": "none"},
        "heard": {"visitId": "h0", "species": "Black-crowned Night Heron", "hasAudio": True, "birdnetDetectionId": detection_id, "birdnetClip": clip},
    }


class Stalled(FakeResponse):
    """BirdNET-Go accepted the connection and never answers."""

    async def __aenter__(self) -> "Stalled":
        await asyncio.Event().wait()
        return self


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.results: list[object] = []
        self.errors: list[tuple[str, str]] = []

    def send_result(self, msg_id: int, result: object = None) -> None:
        self.results.append(result)

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((code, message))


class ExtrasTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {}
        self.units("\u00b0C")
        self.clock = 1000.0
        clock = mock.patch.object(extras_module, "_now", lambda: self.clock)
        clock.start()
        self.addCleanup(clock.stop)

    def units(self, unit: str) -> None:
        self.hass.config = types.SimpleNamespace(units=types.SimpleNamespace(temperature_unit=unit))

    def audio(self, detection_id: int, *responses: object) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/{detection_id}", *responses)

    def weather(self, detection_id: int, *responses: object) -> None:
        self.session.route("GET", f"{BIRDNET}/api/v2/weather/detection/{detection_id}", *responses)

    def asked(self, kind: str) -> int:
        return len([url for _, url, _ in self.session.calls if f"/api/v2/{kind}/" in url])

    def recorded(self, detection_id: int, **weather_args: object) -> None:
        """BirdNET-Go has the recording and knows the weather of that hour."""
        self.audio(detection_id, FakeResponse(206))
        self.weather(detection_id, FakeResponse(200, weather(**weather_args)))


# ---- the weather words -----------------------------------------------------------------------------------------------


class SkyTests(unittest.TestCase):
    def test_the_weather_birdnet_go_stored_is_given_in_whole_degrees_with_the_sky_in_words_and_an_icon(self) -> None:
        sky = extras_module.sky_of(weather())
        self.assertEqual(sky.payload(fahrenheit=False), NIGHT)
        self.assertEqual(sky.payload(fahrenheit=True), {**NIGHT, "temp": 46, "unit": "\u00b0F"})
        self.assertEqual(extras_module.sky_of(weather(temperature=-3.4)).payload(False)["temp"], -3)
        self.assertEqual(extras_module.sky_of(weather(temperature=0)).payload(True)["temp"], 32)

    def test_each_of_the_met_no_sky_codes_has_its_words_and_its_icon_by_day_and_by_night(self) -> None:
        expected = {
            "clearsky_day": ("Clear", "weather-sunny"), "clearsky_night": ("Clear", "weather-night"),
            "fair_day": ("Mostly clear", "weather-partly-cloudy"), "fair_night": ("Mostly clear", "weather-night-partly-cloudy"),
            "partlycloudy_day": ("Partly cloudy", "weather-partly-cloudy"), "partlycloudy_night": ("Partly cloudy", "weather-night-partly-cloudy"),
            "cloudy": ("Cloudy", "weather-cloudy"), "fog": ("Fog", "weather-fog"),
            "lightrain": ("Light rain", "weather-rainy"), "rain": ("Rain", "weather-rainy"), "heavyrain": ("Heavy rain", "weather-pouring"),
            "lightrainshowers_day": ("Light rain showers", "weather-rainy"), "rainshowers_night": ("Rain showers", "weather-rainy"),
            "heavyrainshowers_day": ("Heavy rain showers", "weather-pouring"),
            "lightsleet": ("Light sleet", "weather-snowy-rainy"), "sleetshowers_night": ("Sleet showers", "weather-snowy-rainy"),
            "lightsnow": ("Light snow", "weather-snowy"), "snow": ("Snow", "weather-snowy"), "heavysnow": ("Heavy snow", "weather-snowy-heavy"),
            "lightsnowshowers_night": ("Light snow showers", "weather-snowy"),
            "rainandthunder": ("Thunderstorm", "weather-lightning-rainy"), "heavyrainshowersandthunder_day": ("Thunderstorm", "weather-lightning-rainy"),
            "snowandthunder": ("Thunderstorm", "weather-lightning"),
        }
        for code, (words, icon) in expected.items():
            sky = extras_module.sky_of(weather(code))
            self.assertEqual((sky.conditions, sky.icon), (words, icon), code)

    def test_another_weather_source_is_understood_by_its_main_word_and_the_time_of_day(self) -> None:
        by_night = extras_module.sky_of(weather("clear sky", "Clear", "01n"))
        by_day = extras_module.sky_of(weather("clear sky", "Clear", "01d", time_of_day="day"))
        self.assertEqual([(sky.conditions, sky.icon) for sky in (by_night, by_day)], [("Clear", "weather-night"), ("Clear", "weather-sunny")])
        self.assertEqual(extras_module.sky_of(weather("", "Rain", "10d", time_of_day="day")).conditions, "Rain")
        self.assertEqual(extras_module.sky_of(weather("", "Clouds", "", time_of_day="night")).icon, "weather-cloudy")

    def test_a_sky_it_has_no_words_for_still_shows_the_temperature(self) -> None:
        sky = extras_module.sky_of(weather("tornado", "Tornado", "99"))
        self.assertEqual((sky.conditions, sky.icon, sky.celsius), ("Tornado", "thermometer", 7.8))

    def test_no_weather_is_none_and_so_is_anything_that_is_not_a_believable_reading(self) -> None:
        for nothing in (
            None, [], {}, {"hourly": None}, {"hourly": {}},
            weather("", "", ""),  # what BirdNET-Go answers when it has no weather for that time
            weather(temperature=None), weather(temperature="7.8"), weather(temperature=True), weather(temperature=float("nan")),
            weather(temperature=-120), weather(temperature=80),
        ):
            self.assertIsNone(extras_module.sky_of(nothing), nothing)


# ---- asking BirdNET-Go -----------------------------------------------------------------------------------------------


class ExtrasTests(ExtrasTestCase):
    async def test_a_heard_visit_gets_its_weather_and_a_spectrogram_once_its_recording_is_known_to_exist(self) -> None:
        self.recorded(97264)
        found = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(found, {"h1": extras_module.Extras(NIGHT, 97264)})

    async def test_a_sighting_with_a_call_linked_to_it_gets_them_too(self) -> None:
        self.recorded(97264)
        found = await extras_module.async_extras(self.hass, {"s1": seen("s1", 97264)})
        self.assertEqual(found, {"s1": extras_module.Extras(NIGHT, 97264)})

    async def test_the_temperature_is_in_the_unit_home_assistant_is_set_to(self) -> None:
        self.recorded(97264)
        self.units("\u00b0F")
        found = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(found["h1"].weather, {**NIGHT, "temp": 46, "unit": "\u00b0F"})

    async def test_a_recording_that_is_not_there_still_has_its_weather_but_no_picture_is_offered(self) -> None:
        self.audio(97264, FakeResponse(404))
        self.weather(97264, FakeResponse(200, weather()))
        found = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(found["h1"], extras_module.Extras(NIGHT, None))

    async def test_a_detection_without_a_recording_is_not_asked_about_at_all(self) -> None:
        visits = {
            "no clip": heard("no clip", 13761, None), "blank clip": heard("blank clip", 13807, "  "), "id zero": heard("id zero", 0),
            "no call": {"id": "no call", "kind": "seen", "species": "Red Fox", "grp": "mammal"}, "not a number": heard("not a number", "9"),
        }
        found = await extras_module.async_extras(self.hass, visits)
        self.assertEqual(found, {visit_id: extras_module.NO_EXTRAS for visit_id in visits})
        self.assertEqual(self.session.calls, [])

    async def test_every_visit_asked_about_gets_an_answer_and_a_detection_two_visits_share_is_asked_once(self) -> None:
        self.recorded(97264)
        found = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264), "s1": seen("s1", 97264), "h2": heard("h2", 5, None)})
        self.assertEqual(list(found), ["h1", "s1", "h2"])
        self.assertEqual((found["h1"], found["s1"], found["h2"]), (extras_module.Extras(NIGHT, 97264), extras_module.Extras(NIGHT, 97264), extras_module.NO_EXTRAS))
        self.assertEqual((self.asked("weather/detection"), self.asked("audio")), (1, 1))
        self.assertEqual(await extras_module.async_extras(self.hass, {}), {})

    async def test_a_detections_weather_is_asked_once_and_remembered(self) -> None:
        self.recorded(97264)
        await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.clock += 29 * 86400
        again = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual((again["h1"].weather, self.asked("weather/detection")), (NIGHT, 1))
        self.clock += 2 * 86400
        await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(self.asked("weather/detection"), 2, "a month later it is asked again")

    async def test_no_weather_is_an_answer_too_asked_again_after_ten_minutes(self) -> None:
        self.audio(97264, FakeResponse(206))
        self.weather(97264, FakeResponse(200, weather("", "", "")))
        first = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(first["h1"], extras_module.Extras(None, 97264), "the spectrogram does not depend on the weather")
        self.clock += 599
        await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(self.asked("weather/detection"), 1)
        self.weather(97264, FakeResponse(200, weather()))
        self.clock += 2
        found = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual((found["h1"].weather, self.asked("weather/detection")), (NIGHT, 2))

    async def test_a_detection_birdnet_go_no_longer_has_is_not_asked_again_for_a_while_but_an_outage_is_not_remembered(self) -> None:
        self.audio(97264, FakeResponse(206))
        self.weather(97264, FakeResponse(404))
        self.assertIsNone((await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)}))["h1"].weather)
        await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual(self.asked("weather/detection"), 1)

        self.audio(5, FakeResponse(206))
        self.weather(5, FakeResponse(500), aiohttp.ClientError("down"), FakeResponse(200, weather()))
        for _ in range(2):
            found = await extras_module.async_extras(self.hass, {"h2": heard("h2", 5)})
            self.assertEqual(found["h2"], extras_module.Extras(None, 5), "the page still opens")
        self.assertEqual(self.asked("weather/detection") - 1, 2, "an outage is asked about again every time")
        found = await extras_module.async_extras(self.hass, {"h2": heard("h2", 5)})
        self.assertEqual(found["h2"].weather, NIGHT)

    async def test_a_birdnet_go_that_does_not_answer_holds_the_page_up_only_a_few_seconds(self) -> None:
        self.audio(97264, FakeResponse(206))
        self.weather(97264, Stalled())
        with mock.patch.object(extras_module, "WAIT_S", 0.05):
            found = await asyncio.wait_for(extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)}), 5)
        self.assertEqual(found["h1"], extras_module.Extras(None, 97264), "what did not answer is left out, the rest is not")

    async def test_the_remembered_weather_is_kept_to_a_limit_and_the_oldest_is_dropped_first(self) -> None:
        visits = {}
        for number in range(1, 5):
            self.recorded(number)
            visits[f"h{number}"] = heard(f"h{number}", number)
        with mock.patch.object(extras_module, "MAX_CACHED", 2):
            for visit_id, visit in visits.items():
                self.clock += 1
                await extras_module.async_extras(self.hass, {visit_id: visit})
        self.assertEqual(sorted(self.hass.data[DOMAIN][extras_module._CACHE]), [3, 4])


# ---- the command the panel asks ----------------------------------------------------------------------------------------


class RecordingsCommandTests(ExtrasTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.plugin_visits: dict[str, object] = {}  # visit id -> the visit, or an exception to raise
        self.plugin_asked: list[str] = []

        async def async_request(method: str, path: str, params: object = None, json: object = None) -> object:
            self.plugin_asked.append(unquote(path))
            answer = self.plugin_visits.get(unquote(path.removeprefix("visits/")))
            if isinstance(answer, Exception):
                raise answer
            if answer is None:
                raise KestrelApiError("Not found", status=404)
            return copy.deepcopy(answer)

        self.hass.data[DOMAIN]["coordinator"] = types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request))
        self.connection = FakeConnection()

    async def ask(self, *visit_ids: str) -> object:
        self.connection.results.clear()
        await websocket_module.ws_recordings(self.hass, self.connection, {"id": 9, "type": "kestrel/recordings", "visit_ids": list(visit_ids)})
        return self.connection.results[-1] if self.connection.results else None

    async def test_every_id_asked_about_gets_an_entry_with_a_signed_picture_link_where_there_is_one(self) -> None:
        self.recorded(97264)
        self.plugin_visits.update({
            "h1": heard("h1", 97264), "s1": seen("s1", 97264), "plain": {"id": "plain", "kind": "seen", "species": "Red Fox", "grp": "mammal"},
        })
        result = await self.ask("h1", "s1", "plain", "gone", "h1")
        link = "/api/kestrel/media/birdnet_spectrogram/97264?authSig=FAKE"
        self.assertEqual(result, {"items": {
            "h1": {"weather": NIGHT, "spectrogram": link}, "s1": {"weather": NIGHT, "spectrogram": link},
            "plain": {"weather": None, "spectrogram": None}, "gone": {"weather": None, "spectrogram": None},
        }})
        self.assertEqual(list(result["items"]), ["h1", "s1", "plain", "gone"])
        self.assertEqual(self.plugin_asked, ["visits/h1", "visits/s1", "visits/plain", "visits/gone"], "a repeated id is asked once")
        self.assertEqual(self.connection.errors, [])

    async def test_the_browser_is_given_kestrels_own_link_and_never_birdnet_gos_address(self) -> None:
        self.recorded(97264)
        self.plugin_visits["h1"] = heard("h1", 97264)
        text = json.dumps(await self.ask("h1"))
        self.assertNotIn(BIRDNET, text)
        self.assertNotIn("birdnet-go", text.lower())
        self.assertIn("/api/kestrel/media/birdnet_spectrogram/97264", text)

    async def test_a_birdnet_go_that_is_down_just_means_no_extras_but_a_plugin_that_is_down_is_an_error(self) -> None:
        self.plugin_visits["h1"] = heard("h1", 97264)
        self.audio(97264, aiohttp.ClientError("down"))
        self.weather(97264, aiohttp.ClientError("down"))
        self.assertEqual(await self.ask("h1"), {"items": {"h1": {"weather": None, "spectrogram": None}}})

        self.plugin_visits["h1"] = KestrelApiError("The Kestrel plugin is not answering", status=502)
        await self.ask("h1")
        self.assertEqual(self.connection.errors, [("api_error", "The Kestrel plugin is not answering")])

    async def test_a_bug_is_an_error_to_the_panel_not_a_crash(self) -> None:
        self.plugin_visits["h1"] = heard("h1", 97264)
        with mock.patch.object(extras_module, "async_extras", side_effect=RuntimeError("boom")), self.assertLogs("kestrel_pkg.websocket_api", "ERROR"):
            await self.ask("h1")
        self.assertEqual(self.connection.errors, [("unknown_error", "Kestrel request failed")])

    def test_one_to_twenty_ids_are_accepted_and_nothing_else(self) -> None:
        schema = websocket_module.ws_recordings.ws_schema

        def ask(ids: object) -> object:
            return schema({"id": 1, "type": "kestrel/recordings", "visit_ids": ids})

        ask(["a"])
        ask([f"v{number}" for number in range(20)])
        for bad in ([], [f"v{number}" for number in range(21)], [""], ["x" * 101], [5], "h1", None):
            with self.assertRaises(vol.Invalid, msg=bad):
                ask(bad)
        with self.assertRaises(vol.Invalid):
            schema({"id": 1, "type": "kestrel/recordings"})


# ---- the picture itself ------------------------------------------------------------------------------------------------


class SpectrogramRouteTests(ExtrasTestCase):
    URL = f"{BIRDNET}/api/v2/spectrogram/97264?size=md&raw=true"

    def request(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(headers={})

    async def get(self, media_id: str) -> object:
        return await media_module.KestrelMediaView(self.hass).get(self.request(), "birdnet_spectrogram", media_id)

    async def test_the_picture_is_streamed_from_birdnet_go_and_kept_by_the_browser_for_a_long_time(self) -> None:
        self.session.route("GET", self.URL, FakeResponse(200, body=PNG, headers={"Content-Type": "image/png"}))
        response = await self.get("97264")
        self.assertEqual((response.status, response.body), (200, PNG))
        self.assertEqual((response.headers["Content-Type"], response.headers["Cache-Control"]), ("image/png", "private, max-age=2592000"))

    async def test_a_picture_birdnet_go_has_not_drawn_yet_or_cannot_is_no_content_so_the_browser_logs_no_failed_request(self) -> None:
        for upstream in (404, 202, 503):
            self.session.route("GET", self.URL, FakeResponse(upstream))
            response = await self.get("97264")
            self.assertEqual((response.status, response.headers["Cache-Control"]), (204, "private, max-age=300"), upstream)
        self.session.route("GET", self.URL, FakeResponse(500))
        self.assertEqual((await self.get("97264")).status, 502, "a real failure stays an error")
        self.session.route("GET", self.URL, aiohttp.ClientError("down"))
        self.assertEqual((await self.get("97264")).status, 502)

    async def test_an_id_that_is_not_a_detection_is_not_found_and_never_sent_to_birdnet_go(self) -> None:
        for media_id in ("abc", "0", "-5", "1e3", "12/3", "9 9", "\u0663", "97264.png", ""):
            self.assertEqual((await self.get(media_id)).status, 404, media_id)
        self.assertEqual(self.session.calls, [])

    def test_the_kind_is_one_the_signing_accepts(self) -> None:
        self.assertIn("birdnet_spectrogram", const_module.MEDIA_KINDS)


if __name__ == "__main__":
    unittest.main()
