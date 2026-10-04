"""Reference photos: a picture of a species when Kestrel has none of its own.

A bird that was only heard, an animal the cameras have not met yet: the panel still shows what it looks like. The first
source that has a picture wins:

  1. BirdNET-Go's own image cache (Wikimedia / Avicommons), as always. Streamed from the add-on; nothing is copied.
  2. iNaturalist: the species' default photo. Found by its scientific name, else by its common name (exact matches only).
  3. Wikipedia: the page image of the species' article (REST summary), with author and licence from Wikimedia Commons.

Looking a species up takes a few requests, so the answer is kept (Home Assistant's storage): 30 days when a fallback photo
was found, a day when BirdNET-Go has it, 7 days when no source has one. An answer that could not be had because a source
was unreachable is never kept as "no photo" (it is asked again after a minute), and an answer made while a better source
was unreachable is asked again after an hour. A fallback photo is downloaded the first time it is shown, stored under
`.storage/kestrel_reference_photos` (bounded, least recently shown goes first) and served from there, with Range and ETag,
by the signed media route `species_ref`; who took it, and under which licence, is `species_ref_info`. The link names a
species, never an address: only the hosts the sources serve photos from are ever fetched.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from . import birdnet_availability
from .const import BIRDNET_GO_INTERNAL_URL, DOMAIN
from .reference_sounds import (
    Gone,
    Rejected,
    Taxon,
    Unavailable,
    clean_name,
    fetch_file,
    get_json,
    inaturalist_taxon,
    licence_name,
    name_key,
    probe_size,
    store_file,
)

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = "kestrel.reference_photos"
STORAGE_VERSION = 1
SAVE_DELAY_S = 10
PHOTO_DIR = "kestrel_reference_photos"  # under <config>/.storage

FOUND_TTL_S = 30 * 86400  # a species' photo does not change
BIRDNET_TTL_S = 86400  # BirdNET-Go's own copy can be purged; asking again is one small request
NONE_TTL_S = 7 * 86400  # a source may get a photo later
RECHECK_S = 3600  # an answer made while a better source was out of reach is asked again after this
FAILURE_BACKOFF_S = 60  # after a lookup or a download failed, answer "no picture right now" at once for this long
MAX_ENTRIES = 900
MAX_LOOKUPS_AT_ONCE = 3
LOOKUP_TIMEOUT_S = 40
BIRDNET_TRIES = 3  # BirdNET-Go answers 202/503 while it is still fetching a species' picture for the first time
BIRDNET_WAIT_S = 1.0
MAX_PHOTO_BYTES = 6 * 1024 * 1024
MIN_PHOTO_BYTES = 2048
PHOTO_CACHE_BYTES = 48 * 1024 * 1024
WIKI_WIDTH = 960  # one of Wikimedia's standard thumbnail widths; plenty for a hero picture on a phone

WIKI_API = "https://en.wikipedia.org/api/rest_v1/page/summary"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"

# `source` -> (name shown to the viewer, hosts a picture may come from)
SOURCES: dict[str, tuple[str, tuple[str, ...]]] = {
    "birdnet-go": ("BirdNET-Go", ()),
    "inaturalist": ("iNaturalist", ("static.inaturalist.org", "inaturalist-open-data.s3.amazonaws.com")),
    "wikipedia": ("Wikipedia", ("upload.wikimedia.org", "thumb.wikimedia.org")),
}
IMAGE_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
_PAGE = re.compile(r"https://(?:www\.inaturalist\.org/photos/[0-9]+|en\.wikipedia\.org/wiki/[^\s\"'<>]+)")  # the only pages the panel links to
_SPECIES_PAGE = re.compile(r"\b(?:species|subspecies|breed|hybrid)\b", re.I)  # what a Wikipedia description of an animal says
_PROVIDERS = {"wikimedia": "Wikimedia Commons", "avicommons": "Avicommons"}


@dataclass(frozen=True, slots=True)
class Photo:
    """Which source a species' picture comes from and who made it. `image` is where its bytes come from and never leaves the
    server; it is empty for BirdNET-Go, whose picture is streamed from the add-on by scientific name."""

    source: str  # a key of SOURCES
    credit: str
    licence: str
    page: str  # an https page about the photo, or ""
    image: str
    ext: str

    @property
    def file_name(self) -> str:
        """The file a fetched photo is kept in: derived from its address, never from anything a request can choose."""
        return f"{hashlib.sha256(self.image.encode()).hexdigest()[:24]}.{self.ext}"

    @property
    def mime(self) -> str:
        return IMAGE_TYPES[self.ext]

    def info(self) -> dict[str, str]:
        """What the panel is told about it (the address of the picture is not part of it)."""
        return {"source": SOURCES[self.source][0], "credit": self.credit, "licence": self.licence, "page": self.page}

    def to_json(self) -> dict[str, str]:
        return {"source": self.source, "credit": self.credit, "licence": self.licence, "page": self.page, "image": self.image, "ext": self.ext}

    @staticmethod
    def from_json(raw: object) -> Photo | None:
        """A stored photo, or None when anything about it is not what this module writes (a damaged file is ignored)."""
        if not isinstance(raw, dict):
            return None
        text = {key: raw.get(key) for key in ("source", "credit", "licence", "page", "image", "ext")}
        if not all(isinstance(value, str) for value in text.values()):
            return None
        source = text["source"]
        if source not in SOURCES or len(text["credit"]) > 200 or len(text["licence"]) > 60:
            return None
        if text["page"] and not _PAGE.fullmatch(text["page"]):
            return None
        if source == "birdnet-go":
            if text["image"] or text["ext"]:
                return None
        elif text["ext"] not in IMAGE_TYPES or not image_url_ok(source, text["image"]):
            return None
        return Photo(**text)


@dataclass(slots=True)
class Entry:
    """What one lookup found for one species name."""

    name: str
    scientific: str | None
    checked: float
    exact: bool  # no better source was out of reach when this was found
    photo: Photo | None

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "scientific": self.scientific, "checked": self.checked, "exact": self.exact,
                "photo": self.photo.to_json() if self.photo else None}

    @staticmethod
    def from_json(raw: object) -> Entry | None:
        if not isinstance(raw, dict):
            return None
        name, scientific, checked, stored = raw.get("name"), raw.get("scientific"), raw.get("checked"), raw.get("photo")
        if (
            not isinstance(name, str) or not clean_name(name)
            or not (scientific is None or (isinstance(scientific, str) and len(scientific) <= 100))
            or not isinstance(checked, (int, float)) or isinstance(checked, bool)
        ):
            return None
        photo = None if stored is None else Photo.from_json(stored)
        if stored is not None and photo is None:
            return None
        if photo is not None and photo.source == "birdnet-go" and not scientific:
            return None  # BirdNET-Go is asked by scientific name
        return Entry(name=name, scientific=scientific, checked=float(checked), exact=raw.get("exact") is True, photo=photo)


@dataclass(frozen=True, slots=True)
class Picture:
    """Where to get a species' picture from: `stream` (BirdNET-Go's address, to be streamed through) or `path` (a file here)."""

    stream: str | None
    path: Path | None
    content_type: str


# ---- small pure helpers --------------------------------------------------------------------------------------------


def image_url_ok(source: str, url: str) -> bool:
    """True for an https address on one of the hosts `source` serves its pictures from (nothing else is ever fetched)."""
    try:
        parts = urlsplit(url)
        return (
            parts.scheme == "https" and parts.hostname in SOURCES[source][1]
            and parts.port is None and not parts.username and not parts.password
        )
    except (ValueError, KeyError):
        return False


def _extension(url: str) -> str | None:
    suffix = Path(urlsplit(url).path).suffix.lower().lstrip(".")
    return suffix if suffix in IMAGE_TYPES else None


def _plain(value: object) -> str:
    """Text out of a bit of HTML (Wikimedia Commons writes the author as a link), tidy and short."""
    if not isinstance(value, str):
        return ""
    return " ".join(html.unescape(re.sub(r"<[^>]*>", " ", value)).split())[:120]


def birdnet_info(data: object) -> dict[str, str]:
    """BirdNET-Go's attribution for a picture, in the shape the panel reads. Field names are matched loosely (case and
    underscores), because BirdNET-Go's own spelling has changed between releases."""
    raw = {str(key).lower().replace("_", ""): value for key, value in data.items()} if isinstance(data, dict) else {}

    def pick(*names: str) -> str:
        return next((_plain(raw[name]) for name in names if isinstance(raw.get(name), str) and _plain(raw[name])), "")

    page = pick("authorurl")
    provider = pick("sourceprovider", "provider").lower()
    return {
        "source": _PROVIDERS.get(provider, "BirdNET-Go"),
        "credit": pick("authorname", "author"),
        "licence": pick("licensename", "license"),
        "page": page if page.startswith("https://") else "",
    }


def _resized(url: str, width: int) -> str | None:
    """The same Wikimedia thumbnail at `width` px (a thumbnail's address has its width in it), or None for another kind of address."""
    parts = urlsplit(url)
    path, count = re.subn(r"/\d+px-([^/]+)$", rf"/{width}px-\1", parts.path)
    return urlunsplit((parts.scheme, parts.netloc, path, "", "")) if count else None


def wikipedia_image(summary: dict[str, Any]) -> str | None:
    """The address of the picture of a Wikipedia page summary, at a width that suits the panel, or None."""
    original, thumb = summary.get("originalimage"), summary.get("thumbnail")
    original_url = original.get("source") if isinstance(original, dict) else None
    thumb_url = thumb.get("source") if isinstance(thumb, dict) else None
    width = original.get("width") if isinstance(original, dict) else None
    candidates: list[str] = []
    if isinstance(thumb_url, str) and not (isinstance(width, int) and width <= WIKI_WIDTH):
        candidates.append(_resized(thumb_url, WIKI_WIDTH) or "")  # the original is bigger than needed: a 960 px copy of it
    for url in (original_url, thumb_url):
        if isinstance(url, str):
            candidates.append(urlunsplit(urlsplit(url)._replace(query="", fragment="")))
    return next((url for url in candidates if url and image_url_ok("wikipedia", url) and _extension(url)), None)


def commons_file(url: str) -> tuple[str, str] | None:
    """(wiki, file name) of a Wikimedia upload address, e.g. ("commons", "Carolina wren (14391).jpg"), or None."""
    segments = unquote(urlsplit(url).path).split("/")
    if len(segments) < 6 or segments[1] != "wikipedia":
        return None
    name = segments[6] if segments[3] == "thumb" and len(segments) > 6 else segments[5]
    return (segments[2], name.replace("_", " ")) if name else None


# ---- iNaturalist -----------------------------------------------------------------------------------------------------


async def inaturalist_photo(session: aiohttp.ClientSession, taxon: Taxon) -> Photo | None:
    """iNaturalist's default photo of the species, large if that exists (the taxon answer only names the medium size).
    None when it has none, or the file is gone. Unavailable when iNaturalist cannot be asked."""
    raw = taxon.photo
    if not isinstance(raw, dict) or raw.get("flags"):  # a flagged photo has been hidden by iNaturalist's moderators
        return None
    photo_id, medium = raw.get("id"), raw.get("medium_url")
    if not isinstance(photo_id, int) or isinstance(photo_id, bool) or not isinstance(medium, str):
        return None
    credit = _plain(raw.get("attribution_name"))
    licence = licence_name(raw.get("license_code")) or "All rights reserved"
    for url in dict.fromkeys([medium.replace("/medium.", "/large."), medium]):  # biggest first
        ext = _extension(url)
        if ext is None or not image_url_ok("inaturalist", url):
            continue
        size = await probe_size(session, url)
        if size is not None and MIN_PHOTO_BYTES <= size <= MAX_PHOTO_BYTES:
            return Photo("inaturalist", credit, licence, f"https://www.inaturalist.org/photos/{photo_id}", url, ext)
    return None


# ---- Wikipedia -------------------------------------------------------------------------------------------------------


async def _wikipedia_summary(session: aiohttp.ClientSession, title: str) -> dict[str, Any] | None:
    """The REST summary of the Wikipedia page called `title` (redirects followed within Wikipedia), or None if there is none."""
    url = f"{WIKI_API}/{quote(title.replace(' ', '_'), safe='')}"
    status, data = await get_json(session, url, {}, follow_host="en.wikipedia.org")
    if status == 404:
        return None
    if status != 200 or not isinstance(data, dict):
        raise Unavailable
    return data


async def _commons_credit(session: aiohttp.ClientSession, image: str) -> tuple[str, str]:
    """(author, licence) of a Wikimedia picture, from the wiki it is kept on; ("", "") when that is not known."""
    found = commons_file(image)
    if found is None:
        return "", ""
    wiki, name = found
    status, data = await get_json(
        session, COMMONS_API if wiki == "commons" else WIKIPEDIA_API,
        {"action": "query", "titles": f"File:{name}", "prop": "imageinfo", "iiprop": "extmetadata",
         "iiextmetadatafilter": "Artist|LicenseShortName", "format": "json", "formatversion": 2},
    )
    if status != 200 or not isinstance(data, dict):
        raise Unavailable
    try:
        meta = data["query"]["pages"][0]["imageinfo"][0]["extmetadata"]
        return _plain(meta["Artist"]["value"]), _plain(meta["LicenseShortName"]["value"])[:60]
    except (KeyError, IndexError, TypeError):
        return "", ""


async def wikipedia_photo(session: aiohttp.ClientSession, name: str, scientific: str | None) -> Photo | None:
    """The page image of the species' Wikipedia article. The scientific name is tried first (Wikipedia redirects it to the
    article); a page found by common name must say it is about a species. None when there is no article or it has no
    picture. Unavailable when Wikipedia cannot be asked."""
    for title, exact in ([(scientific, True)] if scientific else []) + [(name, False)]:
        summary = await _wikipedia_summary(session, title)
        if summary is None or summary.get("type") != "standard":
            continue
        if not exact and not _SPECIES_PAGE.search(str(summary.get("description") or "")):
            continue  # "Cardinal" is a church office, not a bird
        image = wikipedia_image(summary)
        if image is None:
            continue
        credit, licence = await _commons_credit(session, image)
        desktop = (summary.get("content_urls") or {}).get("desktop") if isinstance(summary.get("content_urls"), dict) else None
        page = desktop.get("page") if isinstance(desktop, dict) else None
        return Photo("wikipedia", credit, licence, page if isinstance(page, str) and _PAGE.fullmatch(page) else "", image, _extension(image) or "jpg")
    return None


# ---- the service -----------------------------------------------------------------------------------------------------


def _now() -> float:
    return dt_util.utcnow().timestamp()


class ReferencePhotos:
    """Finds, remembers and serves species pictures. One per config entry (`hass.data[DOMAIN]["reference_photos"]`)."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._entries: dict[str, Entry] = {}
        self._failed_until: dict[str, float] = {}
        self._played: dict[str, float] = {}  # file name -> when it was last shown (decides what goes when space is needed)
        self._lookups: dict[str, asyncio.Future[Entry | None]] = {}
        self._downloads: dict[str, asyncio.Future[bool]] = {}
        self._limit = asyncio.Semaphore(MAX_LOOKUPS_AT_ONCE)
        self._dirty = False

    @property
    def photo_dir(self) -> Path:
        return Path(self._hass.config.path(".storage", PHOTO_DIR))

    async def async_load(self) -> None:
        """Reads what earlier runs found. Anything in the file that is not what this module writes is ignored."""
        data = await self._store.async_load()
        stored = data.get("entries") if isinstance(data, dict) else None
        if isinstance(stored, dict):
            for key, raw in stored.items():
                entry = Entry.from_json(raw)
                if entry is not None and key == name_key(clean_name(entry.name)):
                    self._entries[key] = entry
            self._trim()

    async def async_stop(self) -> None:
        """Stops work in progress and writes what is not written yet."""
        for job in [*self._lookups.values(), *self._downloads.values()]:
            job.cancel()
        if self._dirty:
            await self._store.async_save(self._data_to_save())

    async def async_remove(self) -> None:
        """Forgets everything, on disk too (the config entry is being removed)."""
        await self._store.async_remove()
        await self._hass.async_add_executor_job(shutil.rmtree, self.photo_dir, True)

    def diagnostics(self) -> dict[str, Any]:
        sources: dict[str, int] = {}
        for entry in self._entries.values():
            key = entry.photo.source if entry.photo else "none"
            sources[key] = sources.get(key, 0) + 1
        return {"species_remembered": len(self._entries), "by_source": sources}

    # ---- lookup ----

    def offer(self, species: str) -> bool:
        """False when no source is known to have a picture of this species, so a link would only fail. It never asks anyone."""
        name = clean_name(species)
        if not name:
            return False
        entry = self._entries.get(name_key(name))
        return not (entry is not None and entry.photo is None and self._fresh(entry, _now()))

    async def async_resolve(self, species: str) -> Entry | None:
        """What is known about this species' picture, looked up (once, however many ask) when it is not kept yet. None when
        the sources could not be asked just now; that is not remembered."""
        name = clean_name(species)
        if not name:
            return None
        key = name_key(name)
        now = _now()
        entry = self._entries.get(key)
        if entry is not None and self._fresh(entry, now):
            return entry
        if self._failed_until.get(key, 0.0) > now:
            return None
        job = self._lookups.get(key)
        if job is None:
            job = self._hass.async_create_background_task(self._search(name, key), f"kestrel reference photo lookup {key}")
            self._lookups[key] = job
            job.add_done_callback(lambda _: self._lookups.pop(key, None))
        return await asyncio.shield(job)

    @staticmethod
    def _fresh(entry: Entry, now: float) -> bool:
        age = now - entry.checked
        if entry.photo is None:
            lifetime = NONE_TTL_S
        else:
            lifetime = BIRDNET_TTL_S if entry.photo.source == "birdnet-go" else FOUND_TTL_S
        return age < lifetime and (entry.exact or age < RECHECK_S)

    async def _search(self, name: str, key: str) -> Entry | None:
        try:
            async with self._limit:
                entry = await asyncio.wait_for(self._find(name), LOOKUP_TIMEOUT_S)
        except (Unavailable, TimeoutError):
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return None
        except Exception:  # a bug must not reach the panel as a crash; there is simply no picture right now
            _LOGGER.exception("Kestrel reference photo lookup failed")
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return None
        self._failed_until.pop(key, None)
        self._entries[key] = entry
        self._trim()
        self._save_later()
        return entry

    async def _find(self, name: str) -> Entry:
        session = async_get_clientsession(self._hass)
        mapping = self._hass.data.get(DOMAIN, {}).get("birdnet_species_map")
        known = mapping.get(name.lower()) if isinstance(mapping, dict) else None
        scientific = known if isinstance(known, str) and known else None
        taxon: Taxon | None = None
        asked = False  # iNaturalist has been asked who this is (taxon None then means: nobody)
        degraded = False  # a source that might have had a better answer could not be asked
        # 1. BirdNET-Go can only be asked by scientific name. For a name it does not list, iNaturalist says who it is.
        if scientific is None:
            try:
                taxon, asked = await inaturalist_taxon(session, name, None), True
                scientific = taxon.scientific if taxon else None
            except Unavailable:
                degraded = True
        if scientific:
            verdict = await self._birdnet_has(scientific)
            if verdict:
                return Entry(name, scientific, _now(), not degraded, Photo("birdnet-go", "", "", "", "", ""))
            degraded = degraded or verdict is None
        # 2. iNaturalist
        photo: Photo | None = None
        try:
            if not asked:
                taxon = await inaturalist_taxon(session, name, scientific)
            if taxon is not None:
                scientific = scientific or taxon.scientific
                photo = await inaturalist_photo(session, taxon)
        except Unavailable:
            degraded = True
        # 3. Wikipedia
        if photo is None:
            try:
                photo = await wikipedia_photo(session, name, scientific)
            except Unavailable:
                degraded = True
        if photo is None and degraded:
            raise Unavailable
        return Entry(name, scientific, _now(), not degraded, photo)

    async def _birdnet_has(self, scientific: str) -> bool | None:
        """Whether BirdNET-Go has a picture of this species; None when it could not say. It answers 202/503 while it is still
        fetching one for the first time, so a few tries are made."""
        for attempt in range(BIRDNET_TRIES):
            status = await birdnet_availability.image_status(self._hass, scientific)
            if status in (200, 404):
                return status == 200
            if status not in (202, 503):
                return None
            if attempt + 1 < BIRDNET_TRIES:
                await asyncio.sleep(BIRDNET_WAIT_S)
        return None

    # ---- the remembered answers ----

    def _trim(self) -> None:
        for key in sorted(self._entries, key=lambda k: self._entries[k].checked)[: max(0, len(self._entries) - MAX_ENTRIES)]:
            del self._entries[key]
        offered = {entry.photo.file_name for entry in self._entries.values() if entry.photo and entry.photo.image}
        self._played = {file: when for file, when in self._played.items() if file in offered}

    def _data_to_save(self) -> dict[str, Any]:
        self._dirty = False
        return {"entries": {key: entry.to_json() for key, entry in self._entries.items()}}

    def _save_later(self) -> None:
        self._dirty = True
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_S)

    def _forget(self, key: str) -> None:
        """Drops an answer whose picture has gone, so the next look asks the sources again."""
        if self._entries.pop(key, None) is not None:
            self._trim()
            self._save_later()

    # ---- the picture itself, and who made it ----

    async def async_image(self, species: str) -> Picture | None:
        """Where to get the species' picture: BirdNET-Go's address to stream, or a file here (fetched on first use). None when
        no source has one or it cannot be had right now."""
        entry = await self.async_resolve(species)
        if entry is None or entry.photo is None:
            return None
        photo = entry.photo
        if photo.source == "birdnet-go":
            return Picture(f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/image/{quote(entry.scientific or '', safe='')}", None, "")
        path = self.photo_dir / photo.file_name
        self._played[path.name] = _now()
        if await self._hass.async_add_executor_job(path.is_file):
            return Picture(None, path, photo.mime)
        key = name_key(entry.name)
        job = self._downloads.get(path.name)
        if job is None:
            job = self._hass.async_create_background_task(self._download(key, photo, path), f"kestrel reference photo {path.name}")
            self._downloads[path.name] = job
            job.add_done_callback(lambda _: self._downloads.pop(path.name, None))
        return Picture(None, path, photo.mime) if await asyncio.shield(job) else None

    async def _download(self, key: str, photo: Photo, path: Path) -> bool:
        try:
            body = await fetch_file(
                async_get_clientsession(self._hass), photo.image, host_ok=lambda url: image_url_ok(photo.source, url),
                type_ok=lambda kind: kind.startswith("image/"), max_bytes=MAX_PHOTO_BYTES, min_bytes=MIN_PHOTO_BYTES, accept="image/*",
            )
        except (Gone, Rejected):
            _LOGGER.debug("Kestrel reference photo %s is gone from its source", path.name)
            self._forget(key)
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return False
        except Unavailable:
            _LOGGER.debug("Kestrel reference photo %s could not be fetched", path.name)
            return False
        try:
            await self._hass.async_add_executor_job(store_file, path, body, PHOTO_CACHE_BYTES, _now(), dict(self._played))
        except OSError as err:
            _LOGGER.warning("Kestrel could not keep a reference photo on disk (%s)", type(err).__name__)
            return False
        return True

    async def async_info(self, species: str) -> dict[str, str] | None:
        """Who took the species' picture and under which licence (source, credit, licence, page), or None when that is not known."""
        entry = await self.async_resolve(species)
        if entry is None or entry.photo is None:
            return None
        if entry.photo.source != "birdnet-go":
            return entry.photo.info()
        try:
            status, data = await get_json(
                async_get_clientsession(self._hass), f"{BIRDNET_GO_INTERNAL_URL}/api/v2/media/species-image/info", {"name": entry.scientific}
            )
        except Unavailable:
            return None
        return birdnet_info(data) if status == 200 else None
