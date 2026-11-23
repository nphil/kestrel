"""What a recording can show beside its player: the weather when the bird called, and a picture of its sound.

A visit with a BirdNET-Go recording (a heard visit, or a sighting that has a call linked to it) can come with two extras:

  * **The weather at that time.** BirdNET-Go keeps the hourly weather it fetched and knows which hour is closest to a
    detection (`/api/v2/weather/detection/<id>`). It always keeps temperatures in Celsius; they are given here in Home
    Assistant's own unit system, as whole degrees, with a few words and an icon for the sky. BirdNET-Go answers with empty
    fields when it has no weather for that time (no weather source set up): that is "no weather", not an error.
  * **The spectrogram** (a picture of the sound, time across and pitch up). BirdNET-Go draws it from the saved recording; the
    browser gets a signed link to Kestrel's own proxy (media.py, kind `birdnet_spectrogram`), never BirdNET-Go's address. It is
    offered unless the recording is KNOWN to be missing (the same check the audio link goes through): a check that is merely slow
    must not hold the page up. Whether BirdNET-Go can give the picture yet is up to the proxy, which answers "no content" until it
    can; the panel shows that as a quiet "Picture not ready" and asks again later.

Both are decoration, so the answer is quick: it waits WAIT_S at most for BirdNET-Go. A lookup that is not done by then is not dropped:
it carries on in the background and is remembered, so the next ask finds it. BirdNET-Go not answering at all just means a visit has
no weather this time, and it is asked again next time.
Weather is remembered in memory (a detection's weather does not change; a "no weather" is asked again after a few minutes).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from functools import partial
from typing import Any

from homeassistant.core import HomeAssistant

from . import birdnet_api, birdnet_availability
from .client import KestrelApiError
from .const import DOMAIN
from .recording_keep import detection_id_for_visit

_LOGGER = logging.getLogger(__name__)

_CACHE = "recording_weather"
_KIND = "recording_weather_lookup"  # names the lookups running and the slots they share (see birdnet_availability.start_or_join)
FOUND_TTL_S = 30 * 86400
NONE_TTL_S = 600  # BirdNET-Go may fetch the weather of that hour a little later
MAX_CACHED = 500
WAIT_S = 2.0  # the panel does not wait longer than this for decoration; a slower lookup carries on without it and is there next time
PARALLEL = 8

_DAY_NIGHT = re.compile(r"_(?:day|night|polartwilight)$")
# BirdNET-Go's `weather_main`, when its description is not one of Yr.no's symbol codes: (words, icon) by day and by night.
_MAIN: dict[str, tuple[str, str, str]] = {
    "clear": ("Clear", "weather-sunny", "weather-night"),
    "clouds": ("Cloudy", "weather-cloudy", "weather-cloudy"),
    "drizzle": ("Drizzle", "weather-rainy", "weather-rainy"),
    "rain": ("Rain", "weather-rainy", "weather-rainy"),
    "thunderstorm": ("Thunderstorm", "weather-lightning-rainy", "weather-lightning-rainy"),
    "snow": ("Snow", "weather-snowy", "weather-snowy"),
    "mist": ("Mist", "weather-fog", "weather-fog"),
    "fog": ("Fog", "weather-fog", "weather-fog"),
    "haze": ("Haze", "weather-hazy", "weather-hazy"),
}


@dataclass(frozen=True, slots=True)
class Sky:
    """The weather at a detection, in what BirdNET-Go stores: Celsius."""

    celsius: float
    conditions: str
    icon: str

    def payload(self, fahrenheit: bool) -> dict[str, Any]:
        """What the panel is given: whole degrees in the viewer's unit, the sky in words, and a Material Design icon."""
        degrees = self.celsius * 9 / 5 + 32 if fahrenheit else self.celsius
        return {"temp": round(degrees), "unit": "\u00b0F" if fahrenheit else "\u00b0C", "conditions": self.conditions, "icon": f"mdi:{self.icon}"}


@dataclass(frozen=True, slots=True)
class Extras:
    """`weather` as the panel gets it (None: none); `spectrogram` is the BirdNET-Go detection whose picture may be offered."""

    weather: dict[str, Any] | None
    spectrogram: int | None


NO_EXTRAS = Extras(None, None)


def _sky_words(code: str, night: bool) -> tuple[str, str] | None:
    """(words, icon) for one of Yr.no's symbol codes ("lightrainshowers_day", "fog", "partlycloudy_night"), or None for any other."""
    base = _DAY_NIGHT.sub("", code)
    if base == "clearsky":
        return "Clear", "weather-night" if night else "weather-sunny"
    if base in ("fair", "partlycloudy"):
        return "Partly cloudy" if base == "partlycloudy" else "Mostly clear", "weather-night-partly-cloudy" if night else "weather-partly-cloudy"
    if base == "cloudy":
        return "Cloudy", "weather-cloudy"
    if base == "fog":
        return "Fog", "weather-fog"
    kind = next((word for word in ("sleet", "snow", "rain") if word in base), None)
    if kind is None:
        return None
    heavy = base.startswith("heavy")
    if "thunder" in base:
        return "Thunderstorm", "weather-lightning" if kind == "snow" else "weather-lightning-rainy"
    strength = "Light " if base.startswith("light") else "Heavy " if heavy else ""
    words = f"{strength}{kind}{' showers' if 'showers' in base else ''}".capitalize()
    if kind == "sleet":
        return words, "weather-snowy-rainy"
    if kind == "snow":
        return words, "weather-snowy-heavy" if heavy else "weather-snowy"
    return words, "weather-pouring" if heavy else "weather-rainy"


def sky_of(data: object) -> Sky | None:
    """The weather in a BirdNET-Go `/weather/detection/<id>` answer, or None when BirdNET-Go had none for that time."""
    hourly = data.get("hourly") if isinstance(data, dict) else None
    if not isinstance(hourly, dict):
        return None
    fields = {key: hourly.get(key) for key in ("weather_desc", "weather_main", "weather_icon")}
    code, main, icon = (value.strip() if isinstance(value, str) else "" for value in fields.values())
    temperature = hourly.get("temperature")
    if not (code or main or icon) or not isinstance(temperature, (int, float)) or isinstance(temperature, bool) or not -90 <= temperature <= 60:
        return None
    night = code.endswith("_night") if _DAY_NIGHT.search(code) else data.get("time_of_day") == "night"
    found = _sky_words(code.lower(), night)
    if found is None and (known := _MAIN.get(main.lower())) is not None:
        found = known[0], known[2] if night else known[1]
    if found is None:  # a sky it has no words for: the temperature is still worth showing
        found = "".join(ch for ch in main if ch.isprintable())[:40], "thermometer"
    return Sky(float(temperature), *found)


# ---- BirdNET-Go's weather, remembered ----------------------------------------------------------------------------------


def _now() -> float:
    return time.monotonic()


def _remembered(hass: HomeAssistant, detection_id: int) -> tuple[bool, Sky | None]:
    """(known, weather): whether the weather of a detection is remembered and still fresh, and what it is (None: BirdNET-Go has none)."""
    cache: dict[int, tuple[float, Sky | None]] = hass.data.setdefault(DOMAIN, {}).setdefault(_CACHE, {})
    cached = cache.get(detection_id)
    if cached is not None and _now() - cached[0] < (FOUND_TTL_S if cached[1] is not None else NONE_TTL_S):
        return True, cached[1]
    return False, None


async def _async_sky(hass: HomeAssistant, detection_id: int) -> None:
    """Ask BirdNET-Go for the weather of one detection and remember what it says. Not being able to ask at all is not remembered."""
    cache: dict[int, tuple[float, Sky | None]] = hass.data.setdefault(DOMAIN, {}).setdefault(_CACHE, {})
    now = _now()
    try:
        sky = sky_of(await birdnet_api.async_request(hass, "GET", f"/weather/detection/{detection_id}"))
    except KestrelApiError as err:
        if err.status != 404:  # it could not be asked: no verdict, ask again next time
            _LOGGER.debug("Kestrel could not get the weather of detection %s: %s", detection_id, err)
            return
        sky = None  # BirdNET-Go no longer has that detection
    cache[detection_id] = (now, sky)
    for stale in sorted(cache, key=lambda key: cache[key][0])[: max(0, len(cache) - MAX_CACHED)]:
        del cache[stale]


async def _wait_for_skies(hass: HomeAssistant, numbers: list[int]) -> None:
    """Start (or join) the lookup of every weather not remembered yet, and wait for them, at most WAIT_S. They are not cancelled when the wait ends."""
    lookups = [
        birdnet_availability.start_or_join(hass, _KIND, number, partial(_async_sky, hass, number), parallel=PARALLEL)
        for number in numbers
        if not _remembered(hass, number)[0]
    ]
    if lookups:
        await asyncio.wait(lookups, timeout=WAIT_S)


async def async_extras(hass: HomeAssistant, visits: dict[str, Any]) -> dict[str, Extras]:
    """The extras of each visit (`visits`: visit id -> the visit as the plugin sent it); every id gets an answer. Waits at most
    WAIT_S for BirdNET-Go; what did not answer in time is left out this time, while its lookup carries on in the background and is
    remembered for the next ask."""
    detections = {visit_id: detection_id_for_visit(visit) for visit_id, visit in visits.items()}
    recorded = [visit for visit_id, visit in visits.items() if detections[visit_id] is not None]
    wanted = list(dict.fromkeys(number for number in detections.values() if number is not None))
    # the recordings are confirmed while the weather is asked, so the two waits overlap
    await asyncio.gather(
        birdnet_availability.async_confirm_audio(hass, recorded), _wait_for_skies(hass, wanted), return_exceptions=True
    )
    fahrenheit = hass.config.units.temperature_unit == "\u00b0F"
    extras: dict[str, Extras] = {}
    for visit_id, number in detections.items():
        if number is None:
            extras[visit_id] = NO_EXTRAS
            continue
        _, sky = _remembered(hass, number)
        # The picture is offered unless the recording is known to be missing. A recording whose check has not finished is offered it too:
        # waiting for a slow BirdNET-Go here would hold up the weather and the page, and the proxy says "not ready" until the picture can be given.
        missing = birdnet_availability.audio_available_now(hass, str(number)) is False
        extras[visit_id] = Extras(sky.payload(fahrenheit) if sky is not None else None, None if missing else number)
    return extras
