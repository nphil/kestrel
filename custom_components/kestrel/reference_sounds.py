"""Reference sounds: what a species really sounds like, for the panel's "Play reference".

Merlin plays a good recording of the species you are looking at; this gives Kestrel the same. Two sources, both
asked from here so the browser never talks to a third party:

  * Xeno-canto, used FIRST when a (free) API key is set in Kestrel's options. It rates every recording (A best) and
    says whether it is a song or a call, so the panel can offer "Song" and "Call" and pick a clean one.
  * iNaturalist, which needs no key: research-grade observations that carry a sound, for birds, mammals and frogs.

(Cornell's Macaulay Library is not used: its search sits behind a bot-check and its robots.txt disallows everything.)

Looking a species up takes a few requests, so the answer is kept (Home Assistant's storage, 45 days when something was
found, 7 days when nothing was). An answer that could not be had because a source was unreachable is never kept: it
is retried, after a short pause. A clip's sound is fetched the first time it is played, stored under
`.storage/kestrel_reference` (bounded, least recently played goes first) and served from there, with Range support,
by the signed media route `species_sound`. Only clips this service issued can be served, so a media id is never
turned into a URL of anyone's choosing.

The Xeno-canto key is only ever sent to xeno-canto.org and is never put in a log line or an error message.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, INTEGRATION_VERSION

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = "kestrel.reference_sounds"
STORAGE_VERSION = 1
SAVE_DELAY_S = 10
AUDIO_DIR = "kestrel_reference"  # under <config>/.storage

FOUND_TTL_S = 45 * 86400  # a good recording does not change
NONE_TTL_S = 7 * 86400  # a source may get one later
XC_RECHECK_S = 3600  # an answer made without Xeno-canto is asked again after this once a working key is set
XC_DOWN_S = 300  # after Xeno-canto failed, do not wait for it again for this long
FAILURE_BACKOFF_S = 60  # after a lookup could not be done, answer "unavailable" at once for this long
MAX_ENTRIES = 600
MAX_LOOKUPS_AT_ONCE = 2
LOOKUP_TIMEOUT_S = 40
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MIN_AUDIO_BYTES = 1024
AUDIO_CACHE_BYTES = 64 * 1024 * 1024
RECENT_FILE_S = 600  # a file used this recently is never removed to make room

# What makes a good reference: long enough to recognise, short enough to stream at once.
CLIP_SECONDS = (5, 90)
CLIP_IDEAL_SECONDS = (10, 45)
MAX_CLIPS = 3

XC_API = "https://xeno-canto.org/api/3/recordings"
INAT_API = "https://api.inaturalist.org/v1"
USER_AGENT = f"Kestrel/{INTEGRATION_VERSION} (Home Assistant integration; +https://github.com/nphil/kestrel)"
_JSON_TIMEOUT = aiohttp.ClientTimeout(total=15)
_PROBE_TIMEOUT = aiohttp.ClientTimeout(total=10)
_AUDIO_TIMEOUT = aiohttp.ClientTimeout(total=60, connect=10, sock_read=20)

# `source` -> (name shown to the listener, hosts the sound may come from)
SOURCES: dict[str, tuple[str, tuple[str, ...]]] = {
    "xeno-canto": ("Xeno-canto", ("xeno-canto.org",)),
    "inaturalist": ("iNaturalist", ("static.inaturalist.org", "inaturalist-open-data.s3.amazonaws.com")),
}
AUDIO_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
}
_CONTENT_TYPE_EXT = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav",
    "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/flac": "flac",
}
# iNaturalist keeps whatever format was uploaded; its size says how long it is (roughly) for each format.
_INAT_MAX_BYTES = {"mp3": 2_000_000, "m4a": 1_500_000, "wav": 3_000_000, "ogg": 1_500_000, "aac": 1_500_000, "flac": 4_000_000}
_INAT_MIN_BYTES = 20_000

CLIP_ID = re.compile(r"(?:xc|inat)-[0-9]{1,12}")
_PAGE = re.compile(r"https://(?:xeno-canto\.org/[0-9]+|www\.inaturalist\.org/observations/[0-9]+)")  # the only pages the panel links to
_BINOMIAL = re.compile(r"[A-Z][a-z-]+ [a-z-]+")
_KINDS = ("song", "call", "other")
_QUALITY = "ABCDE"


class Unavailable(Exception):
    """A source could not be asked (offline, busy, an answer that is not one). Nothing is learned from it."""


class KeyRejected(Exception):
    """Xeno-canto refused the API key."""


class Gone(Exception):
    """The source no longer has the file."""


class Rejected(Exception):
    """What the source sent is not a usable file."""


@dataclass(frozen=True, slots=True)
class Clip:
    """One reference recording. `audio` is where its bytes come from and never leaves the server."""

    id: str  # "xc-694038" / "inat-1944677": also the media id, so it is validated wherever it is used
    kind: str  # song | call | other
    label: str  # what the panel calls this choice
    source: str  # a key of SOURCES
    credit: str
    licence: str
    quality: str | None
    seconds: int | None
    page: str
    audio: str
    ext: str

    @property
    def mime(self) -> str:
        return AUDIO_TYPES[self.ext]

    def public(self) -> dict[str, Any]:
        """What the panel is told (it gets a signed link instead of `audio`)."""
        return {
            "id": self.id, "kind": self.kind, "label": self.label, "source": self.source,
            "sourceName": SOURCES[self.source][0], "credit": self.credit, "licence": self.licence,
            "quality": self.quality, "seconds": self.seconds, "page": self.page,
        }

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "kind": self.kind, "label": self.label, "source": self.source, "credit": self.credit,
            "licence": self.licence, "quality": self.quality, "seconds": self.seconds, "page": self.page,
            "audio": self.audio, "ext": self.ext,
        }

    @staticmethod
    def from_json(raw: object) -> Clip | None:
        """A stored clip, or None when anything about it is not what this module writes (a damaged file is ignored)."""
        if not isinstance(raw, dict):
            return None
        text = {key: raw.get(key) for key in ("id", "kind", "label", "source", "credit", "licence", "page", "audio", "ext")}
        if not all(isinstance(value, str) for value in text.values()):
            return None
        clip_id, source = text["id"], text["source"]
        quality, seconds = raw.get("quality"), raw.get("seconds")
        if (
            not CLIP_ID.fullmatch(clip_id)
            or source not in SOURCES
            or not clip_id.startswith("xc-" if source == "xeno-canto" else "inat-")
            or text["kind"] not in _KINDS
            or text["ext"] not in AUDIO_TYPES
            or not audio_url_ok(source, text["audio"])
            or not _PAGE.fullmatch(text["page"])
            or len(text["label"]) > 40 or len(text["credit"]) > 200 or len(text["licence"]) > 60
            or not (quality is None or (isinstance(quality, str) and len(quality) == 1 and quality in _QUALITY))
            or not (seconds is None or (isinstance(seconds, int) and not isinstance(seconds, bool) and 0 < seconds < 36000))
        ):
            return None
        return Clip(
            id=clip_id, kind=text["kind"], label=text["label"], source=source, credit=text["credit"],
            licence=text["licence"], quality=quality, seconds=seconds, page=text["page"], audio=text["audio"],
            ext=text["ext"],
        )


@dataclass(slots=True)
class _Entry:
    """What one lookup found for one species name."""

    name: str
    scientific: str | None
    checked: float
    xc: bool  # Xeno-canto answered (even if it had nothing)
    clips: list[Clip]

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name, "scientific": self.scientific, "checked": self.checked, "xc": self.xc,
            "clips": [clip.to_json() for clip in self.clips],
        }

    @staticmethod
    def from_json(raw: object) -> _Entry | None:
        if not isinstance(raw, dict):
            return None
        name, scientific, checked, clips = raw.get("name"), raw.get("scientific"), raw.get("checked"), raw.get("clips")
        if (
            not isinstance(name, str) or not clean_name(name)
            or not (scientific is None or (isinstance(scientific, str) and len(scientific) <= 100))
            or not isinstance(checked, (int, float)) or isinstance(checked, bool)
            or not isinstance(clips, list) or len(clips) > MAX_CLIPS
        ):
            return None
        kept = [Clip.from_json(item) for item in clips]
        if any(clip is None for clip in kept):
            return None
        return _Entry(name=name, scientific=scientific, checked=float(checked), xc=raw.get("xc") is True, clips=kept)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class Taxon:
    """A species as iNaturalist knows it. `photo` is iNaturalist's own default photo of it (a dict), when it has one."""

    id: int
    scientific: str
    photo: dict[str, Any] | None = field(default=None, compare=False)


# ---- small pure helpers --------------------------------------------------------------------------------------------


def clean_name(value: object) -> str:
    """A species name as the panel shows it, with plain spaces and apostrophes; "" when it is not a usable name."""
    if not isinstance(value, str):
        return ""
    text = " ".join("".join(ch for ch in value if ch.isprintable() or ch.isspace()).replace("\u2019", "'").split())
    return text if 0 < len(text) <= 100 else ""


def name_key(name: str) -> str:
    return name.lower()


def audio_url_ok(source: str, url: str) -> bool:
    """True for an https address on one of the hosts `source` serves its sounds from (nothing else is ever fetched)."""
    try:
        parts = urlsplit(url)
        return (
            parts.scheme == "https" and parts.hostname in SOURCES[source][1]
            and parts.port is None and not parts.username and not parts.password
        )
    except (ValueError, KeyError):
        return False


def licence_name(value: object) -> str:
    """"CC BY-NC-SA 4.0" from a Creative Commons address (Xeno-canto) or iNaturalist's code ("cc-by-nc"); "" if unknown."""
    if not isinstance(value, str):
        return ""
    text = value.strip().lower()
    if match := re.search(r"creativecommons\.org/licenses/([a-z-]+)/([0-9.]+)", text):
        return f"CC {match.group(1).upper()} {match.group(2).rstrip('.')}"
    if text == "cc0" or "publicdomain/zero" in text:
        return "CC0"
    if match := re.fullmatch(r"cc-([a-z-]+)", text):
        return f"CC {match.group(1).upper()}"
    return ""


def parse_length(value: object) -> int | None:
    """Seconds from Xeno-canto's "4:08" (or "1:02:10"); None when it is not a length."""
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if not 1 < len(parts) <= 3 or not all(part.isascii() and part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds or None


def _binomial(scientific: str) -> str | None:
    """"Genus species" from a scientific name (a subspecies loses its third word), or None if it is not one."""
    words = scientific.split()
    name = " ".join(words[:2])
    return name if _BINOMIAL.fullmatch(name) else None


def _length_penalty(seconds: int | None) -> int:
    """0 for a length that makes a good reference, growing with the distance from it."""
    if seconds is None:
        return 99
    low, high = CLIP_IDEAL_SECONDS
    return 0 if low <= seconds <= high else (low - seconds if seconds < low else seconds - high)


# ---- fetching JSON ---------------------------------------------------------------------------------------------------


async def get_json(
    session: aiohttp.ClientSession, url: str, params: dict[str, Any], *, follow_host: str | None = None
) -> tuple[int, Any]:
    """(status, parsed body) of a GET; the body is None unless the status is 200. A redirect is followed only when
    `follow_host` is given, and then only to that host. A source that cannot be asked is Unavailable. Nothing here
    puts the address, the query or the key into a message."""
    try:
        for _ in range(4):
            async with session.get(
                url, params=params, headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=_JSON_TIMEOUT, allow_redirects=False,
            ) as response:
                if follow_host and response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, str(response.headers.get("Location") or ""))
                    if urlsplit(url).scheme != "https" or urlsplit(url).hostname != follow_host:
                        raise Unavailable
                    params = {}
                    continue
                if response.status != 200:
                    return response.status, None
                return 200, await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
        _LOGGER.debug("Kestrel reference lookup could not ask a source (%s)", type(err).__name__)
        raise Unavailable from None
    raise Unavailable


# ---- Xeno-canto ------------------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _XcRecording:
    number: int
    quality: int  # 0 = A ... 4 = E, 5 = not rated
    tokens: frozenset[str]  # the sound types, as Xeno-canto spells them
    seconds: int
    lured: bool
    credit: str
    licence: str
    file: str

    def rank(self, kind: str) -> tuple[int, int, int, int, int]:
        """Smaller is better: quality, not lured by playback, the plain word for the kind, a good length, newest."""
        plain = 0 if kind in self.tokens else 1
        return (self.quality, int(self.lured), plain, _length_penalty(self.seconds), -self.number)

    def clip(self, kind: str, label: str) -> Clip:
        quality = _QUALITY[self.quality] if self.quality < len(_QUALITY) else None
        return Clip(
            id=f"xc-{self.number}", kind=kind, label=label, source="xeno-canto", credit=self.credit,
            licence=self.licence, quality=quality, seconds=self.seconds, page=f"https://xeno-canto.org/{self.number}",
            audio=self.file, ext="mp3",
        )


def _is_song(token: str) -> bool:
    return token == "song" or (token.endswith(" song") and token != "subsong")


def _is_call(token: str) -> bool:
    return token == "call" or token.endswith(" call")


def _xc_recordings(items: object, scientific: str) -> list[_XcRecording]:
    """The usable recordings of `scientific` among Xeno-canto's: identified, not withheld, a length worth playing."""
    found: list[_XcRecording] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        number, file = item.get("id"), item.get("file")
        number = int(number) if isinstance(number, str) and number.isascii() and number.isdigit() else number
        redacted = (item.get("_meta") or {}).get("redacted_fields") if isinstance(item.get("_meta"), dict) else None
        seconds = parse_length(item.get("length"))
        if (
            not isinstance(number, int) or isinstance(number, bool) or not 0 < number < 10**12
            or f"{item.get('gen')} {item.get('sp')}".lower() != scientific.lower()
            or item.get("status") not in (None, "", "identified")
            or not isinstance(file, str) or not audio_url_ok("xeno-canto", file)
            or (isinstance(redacted, dict) and "file" in redacted)
            or seconds is None or not CLIP_SECONDS[0] <= seconds <= CLIP_SECONDS[1]
        ):
            continue
        rating = item.get("q")
        credit = " ".join(str(item.get("rec") or "").split())[:120]
        raw_types = item.get("type")
        found.append(
            _XcRecording(
                number=number,
                quality=_QUALITY.index(rating) if isinstance(rating, str) and len(rating) == 1 and rating in _QUALITY else len(_QUALITY),
                tokens=frozenset(t.strip().lower() for t in re.split(r"[,;/]", raw_types) if t.strip()) if isinstance(raw_types, str) else frozenset(),
                seconds=seconds,
                lured=str(item.get("playback-used") or "").lower() == "yes",
                credit=credit,
                licence=licence_name(item.get("lic")),
                file=file,
            )
        )
    return found


def _pick_xc(recordings: list[_XcRecording]) -> list[Clip]:
    """The best song and the best call (never the same recording twice); failing both, the best recording of any kind."""
    chosen: list[Clip] = []
    used: set[int] = set()
    for kind, label, matches in (("song", "Song", _is_song), ("call", "Call", _is_call)):
        pool = [r for r in recordings if r.number not in used and any(matches(t) for t in r.tokens)]
        if pool:
            best = min(pool, key=lambda r: r.rank(kind))
            used.add(best.number)
            chosen.append(best.clip(kind, label))
    if not chosen and recordings:
        chosen.append(min(recordings, key=lambda r: r.rank("other")).clip("other", "Recording"))
    return chosen


async def _xc_page(session: aiohttp.ClientSession, key: str, query: str) -> tuple[list[Any], bool]:
    """(recordings, more pages exist) for one Xeno-canto query. A refused key is KeyRejected; anything else odd, Unavailable."""
    status, data = await get_json(session, XC_API, {"query": query, "key": key, "per_page": 50})
    if status in (401, 403):
        raise KeyRejected
    if status != 200 or not isinstance(data, dict) or not isinstance(data.get("recordings"), list):
        _LOGGER.debug("Kestrel reference lookup: Xeno-canto answered HTTP %s", status)
        raise Unavailable
    pages = data.get("numPages")
    more = (int(pages) > 1) if isinstance(pages, (int, str)) and str(pages).isascii() and str(pages).isdigit() else False
    return data["recordings"], more


async def xeno_canto_clips(session: aiohttp.ClientSession, key: str, scientific: str) -> list[Clip]:
    """Reference clips for `scientific` ("Genus species") from Xeno-canto: its best song and best call, A-quality first.

    Two passes: only A-rated, 10-60 s, never lured by playback; then, if that gave nothing, A-C and 5-90 s. A pass
    that came back full (more pages than the one asked for) is asked again for a missing song or call, once each.
    """
    name = _binomial(scientific)
    if name is None:
        return []
    for filters in ("q:A len:10-60 playback:no", 'q:">D" len:5-90'):
        base = f'sp:"{name}" {filters}'
        items, more = await _xc_page(session, key, base)
        recordings = _xc_recordings(items, name)
        for kind in ("song", "call"):
            has = _is_song if kind == "song" else _is_call
            if more and not any(has(t) for r in recordings for t in r.tokens):
                extra, _ = await _xc_page(session, key, f"{base} type:{kind}")
                known = {r.number for r in recordings}
                recordings += [r for r in _xc_recordings(extra, name) if r.number not in known]
        if clips := _pick_xc(recordings):
            return clips
    return []


async def check_xeno_canto_key(hass: HomeAssistant, key: str) -> str | None:
    """Ask Xeno-canto about one known recording with this key: None when it is accepted, "invalid_key" when it is
    refused, "cannot_connect" when Xeno-canto could not be asked."""
    try:
        async with async_get_clientsession(hass).get(
            XC_API, params={"query": "nr:76967", "key": key}, headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=_JSON_TIMEOUT, allow_redirects=False,
        ) as response:
            status = response.status
    except (aiohttp.ClientError, TimeoutError, OSError):
        return "cannot_connect"
    if status in (401, 403):
        return "invalid_key"
    return None if status == 200 else "cannot_connect"


# ---- iNaturalist -----------------------------------------------------------------------------------------------------


async def inaturalist_taxon(session: aiohttp.ClientSession, name: str, scientific: str | None) -> Taxon | None:
    """The iNaturalist species (or subspecies) called `name`; `scientific`, when known, is tried first. None when there is
    no exact match: a near match would play the wrong animal."""
    attempts = ([(scientific, True)] if scientific else []) + [(name, False)]
    for query, is_scientific in attempts:
        status, data = await get_json(session, f"{INAT_API}/taxa", {"q": query, "per_page": 10, "is_active": "true", "locale": "en"})
        results = data.get("results") if isinstance(data, dict) else None
        if status != 200 or not isinstance(results, list):
            raise Unavailable
        wanted = query.lower()
        for item in results:
            if not isinstance(item, dict) or item.get("rank") not in ("species", "subspecies"):
                continue
            taxon_id, latin = item.get("id"), item.get("name")
            if not isinstance(taxon_id, int) or isinstance(taxon_id, bool) or not isinstance(latin, str):
                continue
            names = {latin.lower()}
            if not is_scientific:
                names |= {str(item.get(attr) or "").lower() for attr in ("preferred_common_name", "matched_term")}
            if wanted in names:
                return Taxon(taxon_id, latin, item["default_photo"] if isinstance(item.get("default_photo"), dict) else None)
    return None


@dataclass(frozen=True, slots=True)
class _InatSound:
    sound_id: int
    observation: int
    score: int
    url: str
    ext: str
    credit: str
    licence: str


def _count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _inat_sounds(results: list[Any]) -> list[_InatSound]:
    """Every usable sound of the observations, best first (faves and agreeing identifications), one per observation."""
    found: list[_InatSound] = []
    seen: set[int] = set()
    for item in results:
        if not isinstance(item, dict):
            continue
        observation = item.get("id")
        if not isinstance(observation, int) or isinstance(observation, bool) or observation in seen:
            continue
        user = item.get("user") if isinstance(item.get("user"), dict) else {}
        credit = " ".join(str(user.get("name") or user.get("login") or "").split())[:120]
        score = 3 * _count(item.get("faves_count")) + _count(item.get("num_identification_agreements"))
        for sound in item.get("sounds") if isinstance(item.get("sounds"), list) else []:
            if not isinstance(sound, dict) or sound.get("hidden") or sound.get("flags") or sound.get("moderator_actions"):
                continue
            sound_id, url = sound.get("id"), sound.get("file_url")
            if not isinstance(sound_id, int) or isinstance(sound_id, bool) or not isinstance(url, str) or not audio_url_ok("inaturalist", url):
                continue
            ext = Path(urlsplit(url).path).suffix.lower().lstrip(".")
            if ext not in AUDIO_TYPES:
                ext = _CONTENT_TYPE_EXT.get(str(sound.get("file_content_type") or "").lower(), "")
            if ext not in AUDIO_TYPES:
                continue
            licence = licence_name(sound.get("license_code")) or "All rights reserved"
            found.append(_InatSound(sound_id, observation, score, url, ext, credit, licence))
            seen.add(observation)
            break
    return sorted(found, key=lambda sound: -sound.score)  # stable: ties keep the order iNaturalist gave


async def probe_size(session: aiohttp.ClientSession, url: str) -> int | None:
    """How many bytes the file at `url` has, asking for one byte of it; None when it is gone."""
    try:
        async with session.get(
            url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"}, timeout=_PROBE_TIMEOUT, allow_redirects=False,
        ) as response:
            if response.status == 206:
                match = re.fullmatch(r"bytes 0-0/([0-9]+)", str(response.headers.get("Content-Range") or ""))
                return int(match.group(1)) if match else None
            if response.status == 200:
                length = str(response.headers.get("Content-Length") or "")
                return int(length) if length.isascii() and length.isdigit() else None
            if response.status == 429 or response.status >= 500:
                raise Unavailable
            return None
    except (aiohttp.ClientError, TimeoutError, OSError):
        raise Unavailable from None


async def inaturalist_clips(session: aiohttp.ClientSession, taxon: Taxon) -> list[Clip]:
    """Up to three research-grade sound observations of the species, the best-liked first, each a size worth streaming."""
    status, data = await get_json(
        session, f"{INAT_API}/observations",
        {"taxon_id": taxon.id, "sounds": "true", "quality_grade": "research", "order_by": "votes", "order": "desc", "per_page": 30, "locale": "en"},
    )
    results = data.get("results") if isinstance(data, dict) else None
    if status != 200 or not isinstance(results, list):
        raise Unavailable
    candidates = _inat_sounds(results)[:9]
    chosen: list[_InatSound] = []
    for start in range(0, len(candidates), MAX_CLIPS):
        group = candidates[start : start + MAX_CLIPS]
        sizes = await asyncio.gather(*(probe_size(session, sound.url) for sound in group))
        for sound, size in zip(group, sizes):
            if size is not None and _INAT_MIN_BYTES <= size <= _INAT_MAX_BYTES[sound.ext] and len(chosen) < MAX_CLIPS:
                chosen.append(sound)
        if len(chosen) >= MAX_CLIPS:
            break
    # "Clip 2" is short enough for a three-way switch on a 360 px phone; "Recording 2" is cut off there.
    return [
        Clip(
            id=f"inat-{sound.sound_id}", kind="other", label="Recording" if len(chosen) == 1 else f"Clip {number}",
            source="inaturalist", credit=sound.credit, licence=sound.licence, quality=None, seconds=None,
            page=f"https://www.inaturalist.org/observations/{sound.observation}", audio=sound.url, ext=sound.ext,
        )
        for number, sound in enumerate(chosen, 1)
    ]


# ---- the audio files -------------------------------------------------------------------------------------------------


def _exists(path: Path) -> bool:
    return path.is_file()


def prune_files(directory: Path, cap_bytes: int, now: float, played: Mapping[str, float] | None = None) -> None:
    """Keeps the folder within `cap_bytes`, removing the least recently played files first. `played` says when each file
    (by name) was last served; a file's own time only says when it was fetched, and is left alone so its ETag stays the
    same. A file played in the last RECENT_FILE_S seconds stays, and so does a download still being written; a download
    abandoned long ago goes."""
    files: list[tuple[float, int, Path]] = []
    total = 0
    try:
        listing = list(os.scandir(directory))
    except OSError:
        return
    for entry in listing:
        try:
            info = entry.stat()
        except OSError:
            continue
        path = Path(entry.path)
        if path.suffix == ".part":
            if now - info.st_mtime > RECENT_FILE_S:
                path.unlink(missing_ok=True)
            continue
        files.append((max(info.st_mtime, (played or {}).get(entry.name, 0.0)), info.st_size, path))
        total += info.st_size
    for used, size, path in sorted(files):
        if total <= cap_bytes:
            break
        if now - used > RECENT_FILE_S:
            path.unlink(missing_ok=True)
            total -= size


def store_file(path: Path, body: bytes, cap_bytes: int, now: float, played: Mapping[str, float]) -> None:
    """Writes the file whole or not at all, then makes room for it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    partial.write_bytes(body)
    os.replace(partial, path)
    prune_files(path.parent, cap_bytes, now, played)


async def fetch_file(
    session: aiohttp.ClientSession, url: str, *, host_ok: Callable[[str], bool], type_ok: Callable[[str], bool], max_bytes: int,
    min_bytes: int, accept: str,
) -> bytes:
    """The bytes at `url`, if they are a file of the right kind and size. Redirects are followed only to addresses `host_ok`
    accepts. Gone: the source no longer has it. Rejected: it is not what it should be. Unavailable: it could not be fetched now."""
    for _ in range(4):
        try:
            async with session.get(
                url, headers={"User-Agent": USER_AGENT, "Accept": accept}, timeout=_AUDIO_TIMEOUT, allow_redirects=False,
            ) as response:
                status = response.status
                if status in (301, 302, 303, 307, 308):
                    url = urljoin(url, str(response.headers.get("Location") or ""))
                    if not host_ok(url):
                        raise Rejected
                    continue
                if status in (404, 410):
                    raise Gone
                if status != 200:
                    raise Unavailable
                kind = str(response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                length = str(response.headers.get("Content-Length") or "")
                if not (type_ok(kind) or kind in ("application/octet-stream", "binary/octet-stream")):
                    raise Rejected
                if length.isascii() and length.isdigit() and int(length) > max_bytes:
                    raise Rejected
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body += chunk
                    if len(body) > max_bytes:
                        raise Rejected
        except (aiohttp.ClientError, TimeoutError, OSError):
            raise Unavailable from None
        if len(body) < min_bytes:
            raise Rejected
        return bytes(body)
    raise Rejected


async def _fetch_audio(session: aiohttp.ClientSession, clip: Clip) -> bytes:
    """The sound of `clip`, from its own source's hosts only."""
    return await fetch_file(
        session, clip.audio, host_ok=lambda url: audio_url_ok(clip.source, url), type_ok=lambda kind: kind.startswith("audio/"),
        max_bytes=MAX_AUDIO_BYTES, min_bytes=MIN_AUDIO_BYTES, accept="audio/*",
    )


# ---- the service -----------------------------------------------------------------------------------------------------


def _now() -> float:
    return dt_util.utcnow().timestamp()


class ReferenceSounds:
    """Finds, remembers and serves reference recordings. One per config entry (`hass.data[DOMAIN]["reference_sounds"]`)."""

    def __init__(self, hass: HomeAssistant, xeno_canto_key: str | None = None) -> None:
        self._hass = hass
        self._xc_key = (xeno_canto_key or "").strip()
        self._xc_rejected = False
        self._xc_down_until = 0.0
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._entries: dict[str, _Entry] = {}
        self._clips: dict[str, tuple[Clip, str]] = {}  # clip id -> (clip, key of the entry that holds it)
        self._failed_until: dict[str, float] = {}
        self._played: dict[str, float] = {}  # file name -> when it was last served (decides what goes when space is needed)
        self._lookups: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._downloads: dict[str, asyncio.Future[bool]] = {}
        self._limit = asyncio.Semaphore(MAX_LOOKUPS_AT_ONCE)
        self._dirty = False

    @property
    def audio_dir(self) -> Path:
        return Path(self._hass.config.path(".storage", AUDIO_DIR))

    @property
    def xeno_canto_usable(self) -> bool:
        return bool(self._xc_key) and not self._xc_rejected

    async def async_load(self) -> None:
        """Reads what earlier runs found. Anything in the file that is not what this module writes is ignored."""
        data = await self._store.async_load()
        stored = data.get("entries") if isinstance(data, dict) else None
        if isinstance(stored, dict):
            for key, raw in stored.items():
                entry = _Entry.from_json(raw)
                if entry is not None and key == name_key(clean_name(entry.name)):
                    self._entries[key] = entry
            self._trim()
        self._reindex()

    async def async_stop(self) -> None:
        """Stops work in progress and writes what is not written yet."""
        for job in [*self._lookups.values(), *self._downloads.values()]:
            job.cancel()
        if self._dirty:
            await self._store.async_save(self._data_to_save())

    async def async_remove(self) -> None:
        """Forgets everything, on disk too (the config entry is being removed)."""
        await self._store.async_remove()
        await self._hass.async_add_executor_job(shutil.rmtree, self.audio_dir, True)

    def diagnostics(self) -> dict[str, Any]:
        return {
            "xeno_canto": "rejected" if self._xc_rejected else "key set" if self._xc_key else "no key",
            "species_remembered": len(self._entries),
            "species_with_recordings": sum(1 for entry in self._entries.values() if entry.clips),
        }

    # ---- lookup ----

    async def async_lookup(self, species: str) -> dict[str, Any]:
        """{"species", "scientific", "state", "clips"} for a species name. `state` is "ready" (clips found), "none"
        (nothing exists; remembered a week) or "unavailable" (a source could not be asked; not remembered)."""
        name = clean_name(species)
        if not name:
            return self._payload(str(species)[:100], None, "none", [])
        key = name_key(name)
        now = _now()
        entry = self._entries.get(key)
        if entry is not None and self._fresh(entry, now):
            return self._entry_payload(entry, name)
        if self._failed_until.get(key, 0.0) > now:
            return self._payload(name, None, "unavailable", [])
        job = self._lookups.get(key)
        if job is None:
            job = self._hass.async_create_background_task(self._search(name, key), f"kestrel reference lookup {key}")
            self._lookups[key] = job
            job.add_done_callback(lambda _: self._lookups.pop(key, None))
        return {**await asyncio.shield(job), "species": name}

    def _fresh(self, entry: _Entry, now: float) -> bool:
        age = now - entry.checked
        if age >= (FOUND_TTL_S if entry.clips else NONE_TTL_S):
            return False
        # Made before a working Xeno-canto key was set (or while Xeno-canto was down): ask again after an hour.
        return not (self.xeno_canto_usable and not entry.xc and age >= XC_RECHECK_S)

    async def _search(self, name: str, key: str) -> dict[str, Any]:
        try:
            async with self._limit:
                entry = await asyncio.wait_for(self._find(name), LOOKUP_TIMEOUT_S)
        except (Unavailable, TimeoutError):
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return self._payload(name, None, "unavailable", [])
        except Exception:  # a bug must not reach the panel as a crash; the lookup simply is not available
            _LOGGER.exception("Kestrel reference lookup failed")
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return self._payload(name, None, "unavailable", [])
        self._failed_until.pop(key, None)
        self._entries[key] = entry
        self._trim()
        self._reindex()
        self._dirty = True
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_S)
        return self._entry_payload(entry)

    async def _find(self, name: str) -> _Entry:
        session = async_get_clientsession(self._hass)
        known = self._hass.data.get(DOMAIN, {}).get("birdnet_species_map", {}).get(name.lower())
        scientific = known if isinstance(known, str) and known else None
        taxon: Taxon | None = None
        resolved = False  # iNaturalist has been asked who this is (taxon None then means: nobody)
        clips: list[Clip] = []
        answered = False
        if self.xeno_canto_usable and _now() >= self._xc_down_until:
            if scientific is None:
                taxon = await inaturalist_taxon(session, name, None)
                resolved = True
                scientific = taxon.scientific if taxon else None
            if scientific is not None:
                try:
                    clips = await xeno_canto_clips(session, self._xc_key, scientific)
                    answered = True
                except KeyRejected:
                    self._xc_rejected = True
                    _LOGGER.warning("Xeno-canto did not accept the API key in Kestrel's settings; using iNaturalist only")
                except Unavailable:
                    self._xc_down_until = _now() + XC_DOWN_S
        if not clips:
            if not resolved:
                taxon = await inaturalist_taxon(session, name, scientific)
            if taxon is not None:
                scientific = scientific or taxon.scientific
                clips = await inaturalist_clips(session, taxon)
        return _Entry(name=name, scientific=scientific, checked=_now(), xc=answered, clips=clips)

    def _entry_payload(self, entry: _Entry, name: str | None = None) -> dict[str, Any]:
        return self._payload(name or entry.name, entry.scientific, "ready" if entry.clips else "none", entry.clips)

    @staticmethod
    def _payload(name: str, scientific: str | None, state: str, clips: list[Clip]) -> dict[str, Any]:
        return {"species": name, "scientific": scientific, "state": state, "clips": [clip.public() for clip in clips]}

    # ---- the remembered answers ----

    def _trim(self) -> None:
        for key in sorted(self._entries, key=lambda k: self._entries[k].checked)[: max(0, len(self._entries) - MAX_ENTRIES)]:
            del self._entries[key]

    def _reindex(self) -> None:
        self._clips = {clip.id: (clip, key) for key, entry in self._entries.items() for clip in entry.clips}
        offered = {f"{clip.id}.{clip.ext}" for clip, _ in self._clips.values()}
        self._played = {name: when for name, when in self._played.items() if name in offered}

    def _data_to_save(self) -> dict[str, Any]:
        self._dirty = False
        return {"entries": {key: entry.to_json() for key, entry in self._entries.items()}}

    def _forget(self, key: str) -> None:
        """Drops an answer whose recording has gone, so the next look asks the source again."""
        if self._entries.pop(key, None) is not None:
            self._reindex()
            self._dirty = True
            self._store.async_delay_save(self._data_to_save, SAVE_DELAY_S)

    # ---- the sound of a clip ----

    def clip(self, clip_id: str) -> Clip | None:
        known = self._clips.get(clip_id) if isinstance(clip_id, str) else None
        return known[0] if known else None

    async def async_audio(self, clip_id: str) -> tuple[Path, str] | None:
        """(file, content type) of a clip this service has issued, fetched on first use; None for anything else or when
        the sound cannot be had. `clip_id` comes from a URL, so it must be exactly a clip id before it names a file."""
        if not isinstance(clip_id, str) or not CLIP_ID.fullmatch(clip_id):
            return None
        known = self._clips.get(clip_id)
        if known is None:
            return None
        clip = known[0]
        path = self.audio_dir / f"{clip.id}.{clip.ext}"
        self._played[path.name] = _now()
        if await self._hass.async_add_executor_job(_exists, path):
            return path, clip.mime
        job = self._downloads.get(clip.id)
        if job is None:
            job = self._hass.async_create_background_task(self._download(clip, path), f"kestrel reference audio {clip.id}")
            self._downloads[clip.id] = job
            job.add_done_callback(lambda _: self._downloads.pop(clip.id, None))
        return (path, clip.mime) if await asyncio.shield(job) else None

    async def _download(self, clip: Clip, path: Path) -> bool:
        try:
            body = await _fetch_audio(async_get_clientsession(self._hass), clip)
        except Gone:
            _LOGGER.debug("Kestrel reference recording %s is gone from its source", clip.id)
            known = self._clips.get(clip.id)
            if known is not None:
                self._forget(known[1])
            return False
        except (Rejected, Unavailable):
            _LOGGER.debug("Kestrel reference recording %s could not be fetched", clip.id)
            return False
        try:
            await self._hass.async_add_executor_job(store_file, path, body, AUDIO_CACHE_BYTES, _now(), dict(self._played))
        except OSError as err:
            _LOGGER.warning("Kestrel could not keep a reference recording on disk (%s)", type(err).__name__)
            return False
        return True
