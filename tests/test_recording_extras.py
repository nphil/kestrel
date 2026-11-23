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

import voluptuous as vol
from ha_stubs import (
    FakeResponse,
    FakeSession,
    FakeWebResponse,
    HomeAssistant,
    KestrelApiError,
    SESSION,
    const_module,
    media_module,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

extras_module = importlib.import_module("kestrel_pkg.recording_extras")
availability_module = importlib.import_module("kestrel_pkg.birdnet_availability")

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


class Gate(asyncio.Event):
    """A door the test opens: the requests held at it are answered only after `set()`. Counts how many are held at the same moment."""

    def __init__(self) -> None:
        super().__init__()
        self.waiting = 0
        self.most = 0


class Gated(FakeResponse):
    """BirdNET-Go is slow: its answer comes only once the test has opened the gate."""

    def __init__(self, gate: Gate, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.gate = gate

    async def __aenter__(self) -> "Gated":
        self.gate.waiting += 1
        self.gate.most = max(self.gate.most, self.gate.waiting)
        try:
            await self.gate.wait()
        finally:
            self.gate.waiting -= 1
        return self


class Cut(FakeResponse):
    """BirdNET-Go sends the start of a body and then the connection breaks."""

    def __init__(self, status: int = 200, first: bytes = PNG[:8], headers: dict | None = None) -> None:
        super().__init__(status, headers=headers)
        self.first = first
        self.content = self

    async def iter_chunked(self, size: int):
        yield self.first
        raise aiohttp.ClientError("connection reset by peer")


class Bounded:
    """BirdNET-Go's answer as aiohttp hands it over, keeping to the timeout the request was given: `total` limits the whole exchange (headers and body),
    `sock_read` the silence while waiting for the headers or for the next piece of the body. Going over either fails with TimeoutError."""

    def __init__(self, response: FakeResponse, timeout: object) -> None:
        self.response = response
        self.total = getattr(timeout, "total", None)
        self.silence = getattr(timeout, "sock_read", None)
        self.deadline: float | None = None

    async def within(self, awaitable: object) -> object:
        limits = [self.silence]
        if self.deadline is not None:
            limits.append(max(0.0, self.deadline - asyncio.get_running_loop().time()))
        limits = [limit for limit in limits if limit is not None]
        return await asyncio.wait_for(awaitable, min(limits) if limits else None)

    async def __aenter__(self) -> "Bounded":
        if self.total is not None:
            self.deadline = asyncio.get_running_loop().time() + self.total
        await self.within(self.response.__aenter__())
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return await self.response.__aexit__(*exc)

    @property
    def status(self) -> int:
        return self.response.status

    @property
    def headers(self) -> dict:
        return self.response.headers

    @property
    def content(self) -> "Bounded":
        return self

    async def json(self, content_type: str | None = None) -> object:
        return await self.within(self.response.json(content_type=content_type))

    async def iter_chunked(self, size: int):
        chunks = self.response.content.iter_chunked(size)
        while True:
            try:
                chunk = await self.within(anext(chunks))
            except StopAsyncIteration:
                return
            yield chunk


class PatientSession(FakeSession):
    """A session whose requests keep to the timeout they are given, as aiohttp's do."""

    def request(self, method: str, url: str, **kwargs: object) -> Bounded:
        return Bounded(super().request(method, url, **kwargs), kwargs.get("timeout"))


class PictureResponse(FakeWebResponse):
    """aiohttp.web.Response with a body (the stub's one only knows text)."""

    def __init__(self, *, status: int = 200, headers: dict | None = None, text: str | None = None, body: bytes | None = None) -> None:
        super().__init__(status=status, headers=headers, text=text)
        self.body = body


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

    def patient(self, **limits: float) -> None:
        """BirdNET-Go behind a session that keeps to the timeouts it is given, and the proxy's own waits (`limits`) made short so the test is quick."""
        self.session = PatientSession()
        SESSION["session"] = self.session
        patches = [mock.patch.object(media_module, name, value) for name, value in limits.items()]
        patches.append(mock.patch.object(media_module.aiohttp, "ClientTimeout", lambda **kwargs: types.SimpleNamespace(**kwargs)))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)


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

    async def test_a_slow_weather_does_not_hold_the_page_up_and_is_not_given_up_on(self) -> None:
        gate = Gate()
        self.audio(97264, FakeResponse(206))
        self.weather(97264, Gated(gate, 200, weather()))
        with mock.patch.object(extras_module, "WAIT_S", 0.05):
            found = await asyncio.wait_for(extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)}), 5)
        self.assertEqual(found["h1"], extras_module.Extras(None, 97264), "what did not answer is left out, the rest is not")
        (lookup,) = self.hass.data[DOMAIN][f"{extras_module._KIND}_running"].values()
        self.assertFalse(lookup.done(), "the lookup carries on after the answer has gone")
        gate.set()
        await asyncio.wait_for(lookup, 5)
        again = await extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)})
        self.assertEqual((again["h1"].weather, self.asked("weather/detection")), (NIGHT, 1), "the next ask finds what it learned, without asking BirdNET-Go again")
        self.assertEqual(self.hass.data[DOMAIN][f"{extras_module._KIND}_running"], {}, "and nothing is left running")

    async def test_a_slow_recording_check_does_not_hold_the_page_up_either_and_the_picture_is_still_offered(self) -> None:
        gate = Gate()
        self.audio(97264, Gated(gate, 206))
        self.weather(97264, FakeResponse(200, weather()))
        with mock.patch.object(availability_module, "_AUDIO_CHECK_WAIT_S", 0.05):
            found = await asyncio.wait_for(extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)}), 5)
        self.assertEqual(found["h1"], extras_module.Extras(NIGHT, 97264), "not known to be missing, so the picture is offered, and the weather did not wait for the check")
        (check,) = self.hass.data[DOMAIN][f"{availability_module._AUDIO_KIND}_running"].values()
        gate.set()
        await asyncio.wait_for(check, 5)
        self.assertTrue(self.hass.data[DOMAIN][availability_module._AUDIO_CACHE]["97264"][0], "the check was not cancelled: it filled the cache for the next ask")

    async def test_pages_asking_about_the_same_recording_at_the_same_moment_share_one_lookup(self) -> None:
        gate = Gate()
        self.audio(97264, Gated(gate, 206))
        self.weather(97264, Gated(gate, 200, weather()))
        both = asyncio.gather(*(extras_module.async_extras(self.hass, {"h1": heard("h1", 97264)}) for _ in range(2)))
        for _ in range(10):
            await asyncio.sleep(0)
        gate.set()
        first, second = await asyncio.wait_for(both, 5)
        self.assertEqual((first, second), ({"h1": extras_module.Extras(NIGHT, 97264)},) * 2)
        self.assertEqual((self.asked("weather/detection"), self.asked("audio")), (1, 1))

    async def test_only_a_few_weather_lookups_run_at_the_same_moment(self) -> None:
        gate = Gate()
        visits = {}
        for number in range(1, 7):
            self.audio(number, FakeResponse(206))
            self.weather(number, Gated(gate, 200, weather()))
            visits[f"h{number}"] = heard(f"h{number}", number)
        with mock.patch.object(extras_module, "PARALLEL", 2):
            asking = asyncio.ensure_future(extras_module.async_extras(self.hass, visits))
            for _ in range(20):
                await asyncio.sleep(0)
            self.assertEqual(gate.waiting, 2, "the other four wait their turn")
            gate.set()
            found = await asyncio.wait_for(asking, 5)
        self.assertEqual(gate.most, 2)
        self.assertEqual([extra.weather for extra in found.values()], [NIGHT] * 6)

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
        self.plugin_visits: dict[str, object] = {}  # visit id -> the visit the plugin has
        self.plugin_error: Exception | None = None  # set: the plugin fails like this instead of answering
        self.plugin_calls: list[tuple[str, str, object]] = []

        async def async_request(method: str, path: str, params: object = None, json: object = None) -> object:
            self.plugin_calls.append((method, path, copy.deepcopy(json)))
            if self.plugin_error is not None:
                raise self.plugin_error
            if (method, path) != ("POST", "visits/lookup"):
                raise KestrelApiError("Not found", status=404)
            # like the plugin: an id it has no visit for is left out of the answer
            return {"items": copy.deepcopy({visit_id: self.plugin_visits[visit_id] for visit_id in json["ids"] if visit_id in self.plugin_visits})}

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
        self.assertEqual(self.plugin_calls, [("POST", "visits/lookup", {"ids": ["h1", "s1", "plain", "gone"]})], "ONE question to the plugin for all of them, a repeated id once")
        self.assertEqual(self.connection.errors, [])

    async def test_an_answer_from_the_plugin_with_nothing_usable_in_it_just_means_no_extras(self) -> None:
        stranger = {"other": heard("other", 5)}  # a visit nobody asked about is not shown either
        for answer in (None, [], {}, {"items": None}, {"items": []}, {"items": {"h1": None}}, {"items": stranger}):
            async def lookup(method: str, path: str, params: object = None, json: object = None, answer: object = answer) -> object:
                return answer

            self.hass.data[DOMAIN]["coordinator"].client.async_request = lookup
            self.assertEqual(await self.ask("h1"), {"items": {"h1": {"weather": None, "spectrogram": None}}}, answer)
        self.assertEqual(self.connection.errors, [])

    async def test_the_browser_is_given_kestrels_own_link_and_never_birdnet_gos_address(self) -> None:
        self.recorded(97264)
        self.plugin_visits["h1"] = heard("h1", 97264)
        text = json.dumps(await self.ask("h1"))
        self.assertNotIn(BIRDNET, text)
        self.assertNotIn("birdnet-go", text.lower())
        self.assertIn("/api/kestrel/media/birdnet_spectrogram/97264", text)

    async def test_a_birdnet_go_that_is_down_just_means_no_weather_but_a_plugin_that_is_down_is_an_error(self) -> None:
        self.plugin_visits["h1"] = heard("h1", 97264)
        self.audio(97264, aiohttp.ClientError("down"))
        self.weather(97264, aiohttp.ClientError("down"))
        link = "/api/kestrel/media/birdnet_spectrogram/97264?authSig=FAKE"
        self.assertEqual(
            await self.ask("h1"), {"items": {"h1": {"weather": None, "spectrogram": link}}},
            "the recording is not known to be missing, so the picture is offered; the proxy says when it is not ready",
        )

        self.plugin_error = KestrelApiError("The Kestrel plugin is not answering", status=502)
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
    GENERATE = f"{BIRDNET}/api/v2/spectrogram/97264/generate?size=md&raw=true"
    CONFIG = f"{BIRDNET}/api/v2/app/config"
    NONE_YET = (204, {"Cache-Control": "no-store"})

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        patch = mock.patch.object(media_module.web, "Response", PictureResponse)
        patch.start()
        self.addCleanup(patch.stop)
        self.drawing: list[asyncio.Future] = []  # the background tasks the proxy started

        def background(coro: object, name: str | None = None) -> asyncio.Future:
            task = asyncio.ensure_future(coro)
            self.drawing.append(task)
            return task

        self.hass.async_create_background_task = background

    def request(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(headers={})

    async def get(self, media_id: str = "97264") -> object:
        return await media_module.KestrelMediaView(self.hass).get(self.request(), "birdnet_spectrogram", media_id)

    async def finish(self) -> None:
        await asyncio.gather(*self.drawing)

    def draws_on_request(self) -> None:
        """BirdNET-Go set to draw only when asked says so in its "not found", and takes the order once it has handed out its security token."""
        self.session.route("GET", self.URL, FakeResponse(404, {"error": "spectrogram not found", "data": {"mode": "user-requested"}}))
        self.session.route("GET", self.CONFIG, FakeResponse(200, {"csrfToken": "token-1234567890"}))

    async def test_the_picture_is_sent_to_the_browser_and_kept_by_it_for_a_long_time(self) -> None:
        headers = {"Content-Type": "image/png", "Content-Length": str(len(PNG)), "ETag": '"abc"'}
        self.session.route("GET", self.URL, FakeResponse(200, body=PNG, headers=headers))
        response = await self.get()
        self.assertEqual((response.status, response.body), (200, PNG))
        self.assertEqual(response.headers, {"Content-Type": "image/png", "ETag": '"abc"', "Cache-Control": "private, max-age=2592000"}, "no Content-Length: it is the body's own")

    async def test_a_picture_that_is_not_there_yet_is_never_an_error_and_never_kept(self) -> None:
        for upstream in (404, 202, 400, 403, 408, 425, 429, 500, 502, 503, 504):
            self.session.route("GET", self.URL, FakeResponse(upstream))
            response = await self.get()
            self.assertEqual((response.status, response.headers), self.NONE_YET, upstream)
        for broken in (aiohttp.ClientError("down"), TimeoutError(), ConnectionResetError("reset"), Cut(), Cut(206)):
            self.session.route("GET", self.URL, broken)
            response = await self.get()
            self.assertEqual((response.status, response.headers, response.body), (*self.NONE_YET, None), broken)

    async def test_a_birdnet_go_that_never_answers_is_given_up_on_and_the_browser_is_told_it_is_not_ready(self) -> None:
        self.patient(SPECTROGRAM_WAIT_S=0.05)
        self.session.route("GET", self.URL, Stalled())  # accepted the connection, never answers
        response = await asyncio.wait_for(self.get(), 5)
        self.assertEqual((response.status, response.headers), self.NONE_YET)
        self.session.route("GET", self.URL, FakeResponse(200, body=PNG, hang=True))  # the start of an answer, then silence: no half a picture goes out
        response = await asyncio.wait_for(self.get(), 5)
        self.assertEqual((response.status, response.headers, response.body), (*self.NONE_YET, None))
        self.assertEqual([kwargs["timeout"].total for _, _, kwargs in self.session.calls], [0.05, 0.05], "the whole picture is on one clock")

    async def test_a_birdnet_go_that_draws_only_on_request_is_told_to_draw_once_and_the_browser_is_not_kept_waiting(self) -> None:
        self.draws_on_request()
        gate = Gate()
        self.session.route("POST", self.GENERATE, Gated(gate, 200, {"status": "generating"}))
        for _ in range(3):  # the same recording asked for again while the first order is on its way
            response = await self.get()
            self.assertEqual((response.status, response.headers), self.NONE_YET)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual((len(self.drawing), len(self.session.calls_to("POST", self.GENERATE))), (1, 1), "one order, not three")
        gate.set()
        await self.finish()
        [order] = self.session.calls_to("POST", self.GENERATE)
        self.assertEqual(order["headers"], {"X-CSRF-Token": "token-1234567890", "Cookie": "csrf=token-1234567890"})
        self.assertEqual(self.hass.data[DOMAIN]["spectrograms_requested"], set())
        await self.get()
        await self.finish()
        self.assertEqual(len(self.session.calls_to("POST", self.GENERATE)), 2, "once the first order is done, a later ask may give another")

    async def test_a_birdnet_go_that_has_no_clip_or_draws_by_itself_is_not_told_to_draw(self) -> None:
        nothing = (
            FakeResponse(404, {"error": "no clip"}), FakeResponse(404, {"data": {"mode": "auto"}}), FakeResponse(404, body=b"<html>nope</html>"),
            FakeResponse(404, {"data": None}), FakeResponse(404, {"data": []}), FakeResponse(404, []), FakeResponse(404),
        )
        for answer in nothing:
            self.session.route("GET", self.URL, answer)
            response = await self.get()
            self.assertEqual((response.status, response.headers), self.NONE_YET)
        await self.finish()
        self.assertEqual(self.drawing, [])
        self.assertEqual({url for _, url, _ in self.session.calls}, {self.URL}, "no order, and no security token fetched for one")

    async def test_an_order_to_draw_that_does_not_work_is_forgotten_quietly_and_may_be_given_again(self) -> None:
        self.draws_on_request()
        for failure in (FakeResponse(500), FakeResponse(202), aiohttp.ClientError("down")):
            self.session.route("POST", self.GENERATE, failure)
            response = await self.get()
            self.assertEqual((response.status, response.headers), self.NONE_YET)
            await self.finish()
        self.assertEqual(len(self.session.calls_to("POST", self.GENERATE)), 3)
        self.assertEqual(self.hass.data[DOMAIN]["spectrograms_requested"], set())

    async def test_an_id_that_is_not_a_detection_is_not_found_and_never_sent_to_birdnet_go(self) -> None:
        for media_id in ("abc", "0", "-5", "1e3", "12/3", "9 9", "\u0663", "97264.png", ""):
            self.assertEqual((await self.get(media_id)).status, 404, media_id)
        self.assertEqual(self.session.calls, [])

    def test_the_kind_is_one_the_signing_accepts(self) -> None:
        self.assertIn("birdnet_spectrogram", const_module.MEDIA_KINDS)


# ---- the recordings ----------------------------------------------------------------------------------------------------


class RecordingRouteTests(ExtrasTestCase):
    """A recording that BirdNET-Go is slow to give or busy with is "try again in a moment" for the browser: not a failure, and not a wait without end."""

    AUDIO = f"{BIRDNET}/api/v2/audio/12"
    BUSY = (202, 408, 425, 429, 499, 502, 503, 504)

    def request(self, transport: object = None) -> types.SimpleNamespace:
        return types.SimpleNamespace(headers={}, transport=transport)

    async def get(self, kind: str = "birdnet_audio", media_id: str = "12", transport: object = None) -> object:
        return await media_module.KestrelMediaView(self.hass).get(self.request(transport), kind, media_id)

    def assert_try_again(self, response: object, note: object) -> None:
        self.assertEqual((response.status, response.headers, response.text), (503, {"Retry-After": "5"}, "Recording not ready yet"), note)

    async def test_a_recording_birdnet_go_is_busy_with_or_cannot_reach_is_try_again_in_a_moment(self) -> None:
        for kind, media_id, url in (("birdnet_audio", "12", self.AUDIO), ("birdnet_clip", CLIP, availability_module.recording_url(CLIP))):
            for upstream in self.BUSY:
                self.session.route("GET", url, FakeResponse(upstream))
                self.assert_try_again(await self.get(kind, media_id), (kind, upstream))
            for failure in (aiohttp.ClientError("down"), TimeoutError(), ConnectionResetError("reset")):
                self.session.route("GET", url, failure)
                self.assert_try_again(await self.get(kind, media_id), (kind, failure))

    async def test_a_recording_that_is_not_there_is_still_not_found_and_a_real_failure_is_still_an_error(self) -> None:
        with self.assertLogs("kestrel_pkg.media", "WARNING"):  # a real failure is worth a line in the log
            for upstream, answer in ((404, 404), (400, 502), (401, 502), (403, 502), (500, 502)):
                self.session.route("GET", self.AUDIO, FakeResponse(upstream))
                self.assertEqual((await self.get()).status, answer, upstream)

    async def test_a_preview_that_is_still_being_made_is_try_again_in_a_moment_too(self) -> None:
        url = "http://audio.test:8787/v1/previews/12/audio"
        self.hass.data[DOMAIN]["audio"] = types.SimpleNamespace(enabled=True, headers={"X-Api-Key": "k"}, preview_url=lambda media_id: url)
        self.session.route("GET", url, FakeResponse(202))
        self.assert_try_again(await self.get("birdnet_preview"), 202)
        self.session.route("GET", url, FakeResponse(404))
        self.assertEqual((await self.get("birdnet_preview")).status, 404)

    async def test_a_stalled_recording_is_given_up_on_after_a_short_silence_but_a_long_one_may_take_as_long_as_it_needs(self) -> None:
        self.patient(RECORDING_STALL_S=0.05)
        self.session.route("GET", self.AUDIO, Stalled())
        self.assert_try_again(await asyncio.wait_for(self.get(), 5), "no answer at all")
        timeout = self.session.calls[-1][2]["timeout"]
        self.assertEqual((timeout.total, timeout.sock_read), (None, 0.05), "no limit on the whole recording, only on silence")

    async def test_a_recording_that_breaks_off_midway_is_cut_short_not_answered_a_second_time(self) -> None:
        self.patient(RECORDING_STALL_S=0.05)
        for broken, sent in ((Cut(first=b"OGG"), b"OGG"), (FakeResponse(200, body=b"OGGDATA", hang=True), b"")):
            self.session.route("GET", self.AUDIO, broken)
            transport = types.SimpleNamespace(closed=False)
            transport.close = lambda: setattr(transport, "closed", True)
            response = await asyncio.wait_for(self.get(transport=transport), 5)
            self.assertEqual((response.status, response.body), (200, sent), "what was already sent stays sent, and nothing else follows it")
            self.assertTrue(transport.closed, "the connection is closed, so the browser learns that the file is short")
        self.session.route("GET", self.AUDIO, Cut(first=b"OGG"))
        response = await self.get(transport=None)  # the browser is gone already: nothing to close
        self.assertEqual((response.status, response.body), (200, b"OGG"))


if __name__ == "__main__":
    unittest.main()
