"""Species descriptions: a few plain sentences about a species, from its Wikipedia article, for the species sheet.

Kestrel's own pages say how often a species came; this says what it is. The words come from the lead of the species'
Wikipedia article (the REST summary), trimmed to at most three whole sentences. The scientific name is tried first (Wikipedia
redirects it to the article); a page found by common name has to say it is about a species, so "Cardinal" (a church office)
is never taken for a bird. Wikipedia's text is licensed CC BY-SA 4.0, so every description comes with the link to its article
and the licence, for the panel to show under it.

It is the Home Assistant host that asks Wikipedia, never the browser: the browser only ever receives the finished words.
The answer is kept (Home Assistant's storage): 30 days when there is a description, 7 days when there is none. An answer that
could not be had because Wikipedia (or iNaturalist, which names the mammals BirdNET-Go has no name for) was unreachable is
never kept as "no description"; it is asked again after a minute. The sheet waits a few seconds for a new lookup and shows
the page without a description if it is not back in time; the lookup finishes in the background and is there next time.

The scientific name found on the way is remembered with it, which is what `scientific_name` serves (the species list shows
it), together with the names BirdNET-Go and the reference photos already know.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .reference_photos import SPECIES_PAGE, wikipedia_summary
from .reference_sounds import Unavailable, clean_name, inaturalist_taxon, name_key

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = "kestrel.species_descriptions"
STORAGE_VERSION = 1
SAVE_DELAY_S = 10

FOUND_TTL_S = 30 * 86400  # an article's first paragraph hardly changes
NONE_TTL_S = 7 * 86400  # an article may be written later
FAILURE_BACKOFF_S = 60  # after a lookup failed, answer "none right now" at once for this long
MAX_ENTRIES = 900
MAX_LOOKUPS_AT_ONCE = 3
LOOKUP_TIMEOUT_S = 40
ASK_WAIT_S = 5.0  # how long a species sheet waits for a description that has to be looked up first
MAX_SENTENCES = 3
MAX_CHARS = 480
MIN_CHARS = 30
ANIMALS = 1  # iNaturalist's number for every animal: a name that is also a plant's (Merlin, a falcon) must not describe the plant

LICENCE = "CC BY-SA 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
_PAGE = re.compile(r"https://en\.wikipedia\.org/wiki/[^\s\"'<>]{1,300}")  # the only page the panel links to
_NOT_AN_ARTICLE = re.compile(r"\bmay (?:also )?refer to\b", re.I)
_INVISIBLE = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u00ad\ufeff"))  # zero-width characters and soft hyphens
# Words that end in a full stop without ending a sentence ("approx. 15 cm", "Mt. Pleasant", "sp. nov."). A single letter ("J. Smith")
# and anything with a full stop inside ("U.S.", "e.g.") is never the end of a sentence either.
_ABBREVIATIONS = frozenset(
    "mr mrs ms dr st jr sr vs no nos approx ca c cf sp spp ssp subsp var fig figs inc ltd co mt ft lb oz etc al".split()
)
_SENTENCE_END = re.compile(r"([.!?][\"')\]]?)\s+(?=[A-Z0-9\"'(\[])")


@dataclass(slots=True)
class Entry:
    """What one lookup found for one species name: its scientific name (if that was found) and the article's first words."""

    name: str
    scientific: str | None
    checked: float
    text: str | None  # None: no article, or one that is not about this species
    page: str  # the article's address ("" exactly when there is no text)

    def source(self) -> dict[str, str] | None:
        """Where the words come from, for the panel to credit: the article, and the licence it is shared under."""
        if self.text is None:
            return None
        return {"name": "Wikipedia", "url": self.page, "licence": LICENCE, "licenceUrl": LICENCE_URL}

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "scientific": self.scientific, "checked": self.checked, "text": self.text, "page": self.page}

    @staticmethod
    def from_json(raw: object) -> Entry | None:
        """A stored answer, or None when anything about it is not what this module writes (a damaged file is ignored)."""
        if not isinstance(raw, dict):
            return None
        name, scientific, checked = raw.get("name"), raw.get("scientific"), raw.get("checked")
        text, page = raw.get("text"), raw.get("page")
        if (
            not isinstance(name, str) or not clean_name(name)
            or not (scientific is None or (isinstance(scientific, str) and 0 < len(scientific) <= 100))
            or not isinstance(checked, (int, float)) or isinstance(checked, bool)
            or not (text is None or (isinstance(text, str) and MIN_CHARS <= len(text) <= MAX_CHARS + 2))
            or not isinstance(page, str) or (text is None) != (page == "")
            or (page and not _PAGE.fullmatch(page))
        ):
            return None
        return Entry(name=name, scientific=scientific, checked=float(checked), text=text, page=page)


# ---- small pure helpers --------------------------------------------------------------------------------------------


def _sentences(text: str) -> list[str]:
    """`text` cut into sentences. A full stop only ends one when what follows starts a new one and what precedes is not an
    abbreviation, an initial or a dotted acronym: wrongly joining two sentences is harmless, cutting "U.S." in half is not."""
    found: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(text):
        if match.group(1)[0] == ".":
            words = text[start : match.start(1)].split()
            last = words[-1].lstrip("(\"'[") if words else ""
            if len(last) == 1 or "." in last or last.lower() in _ABBREVIATIONS:
                continue
        found.append(text[start : match.end(1)])
        start = match.end()
    found.append(text[start:])
    return [sentence.strip() for sentence in found if sentence.strip()]


def lead(extract: object) -> str | None:
    """The first sentences of a Wikipedia extract that fit (at most MAX_SENTENCES and MAX_CHARS), as one plain line; a first
    sentence that is too long on its own is cut at a word and ends in "…". None when there is nothing worth showing."""
    if not isinstance(extract, str):
        return None
    text = " ".join("".join(ch for ch in extract.translate(_INVISIBLE) if ch.isprintable() or ch.isspace()).split())
    if len(text) < MIN_CHARS or _NOT_AN_ARTICLE.search(text):
        return None
    chosen = ""
    for sentence in _sentences(text)[:MAX_SENTENCES]:
        joined = f"{chosen} {sentence}".strip()
        if len(joined) > MAX_CHARS:
            break
        chosen = joined
    if not chosen:  # even the first sentence is too long
        cut = text[: MAX_CHARS - 1].rsplit(" ", 1)[0].rstrip(" ,;:(-\u2013")
        chosen = f"{cut}\u2026"
    return chosen if len(chosen) >= MIN_CHARS else None


def article_page(summary: dict[str, Any]) -> str | None:
    """The address of the page a Wikipedia summary is about (only ever an en.wikipedia.org article), or None. Wikipedia writes an
    apostrophe in an address as it is (Cooper's_hawk); it is kept as %27, the same page, so that no address ever holds a quote."""
    urls = summary.get("content_urls")
    desktop = urls.get("desktop") if isinstance(urls, dict) else None
    page = desktop.get("page") if isinstance(desktop, dict) else None
    if not isinstance(page, str):
        return None
    page = page.replace("'", "%27")
    return page if _PAGE.fullmatch(page) else None


def scientific_name(hass: HomeAssistant, species: str) -> str | None:
    """The scientific name of `species` when it is known without asking anyone: from BirdNET-Go's names (every bird it
    lists), else from what the description and reference photo lookups found out earlier (iNaturalist names the mammals)."""
    name = clean_name(species)
    if not name:
        return None
    key = name_key(name)
    data = hass.data.get(DOMAIN, {})
    mapping = data.get("birdnet_species_map")
    known = mapping.get(key) if isinstance(mapping, dict) else None
    if isinstance(known, str) and known:
        return known
    for service in (data.get("species_descriptions"), data.get("reference_photos")):
        if service is not None and (found := service.scientific(name)):
            return found
    return None


# ---- the service -----------------------------------------------------------------------------------------------------


def _now() -> float:
    return dt_util.utcnow().timestamp()


class SpeciesDescriptions:
    """Finds and remembers the descriptions. One per config entry (`hass.data[DOMAIN]["species_descriptions"]`)."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._entries: dict[str, Entry] = {}
        self._failed_until: dict[str, float] = {}
        self._lookups: dict[str, asyncio.Future[Entry | None]] = {}
        self._limit = asyncio.Semaphore(MAX_LOOKUPS_AT_ONCE)
        self._dirty = False

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
        for job in self._lookups.values():
            job.cancel()
        if self._dirty:
            await self._store.async_save(self._data_to_save())

    async def async_remove(self) -> None:
        """Forgets everything, on disk too (the config entry is being removed)."""
        await self._store.async_remove()

    def diagnostics(self) -> dict[str, Any]:
        described = sum(1 for entry in self._entries.values() if entry.text is not None)
        return {"species_remembered": len(self._entries), "with_description": described}

    def scientific(self, species: str) -> str | None:
        """The scientific name a lookup found for this species, or None. Never asks anyone."""
        entry = self._entries.get(name_key(clean_name(species)))
        return entry.scientific if entry is not None else None

    # ---- lookup ----

    async def async_describe(self, species: str) -> Entry | None:
        """What is known about this species, looked up (once, however many ask) when it is not kept yet. None when the answer
        is not there in time (the lookup carries on and is kept) or Wikipedia could not be asked just now (not kept)."""
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
            job = self._hass.async_create_background_task(self._search(name, key), f"kestrel species description {key}")
            self._lookups[key] = job
            job.add_done_callback(lambda _: self._lookups.pop(key, None))
        try:
            return await asyncio.wait_for(asyncio.shield(job), ASK_WAIT_S)
        except TimeoutError:
            return None

    @staticmethod
    def _fresh(entry: Entry, now: float) -> bool:
        return now - entry.checked < (FOUND_TTL_S if entry.text is not None else NONE_TTL_S)

    async def _search(self, name: str, key: str) -> Entry | None:
        try:
            async with self._limit:
                entry = await asyncio.wait_for(self._find(name), LOOKUP_TIMEOUT_S)
        except (Unavailable, TimeoutError):
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return None
        except Exception:  # a bug must not reach the panel as a crash; there is simply no description right now
            _LOGGER.exception("Kestrel species description lookup failed")
            self._failed_until[key] = _now() + FAILURE_BACKOFF_S
            return None
        self._failed_until.pop(key, None)
        self._entries[key] = entry
        self._trim()
        self._save_later()
        return entry

    async def _find(self, name: str) -> Entry:
        session = async_get_clientsession(self._hass)
        scientific = scientific_name(self._hass, name)
        degraded = False  # a source that might have had the answer could not be asked
        if scientific is None:  # BirdNET-Go does not list it (a mammal, say): iNaturalist says who it is
            try:
                taxon = await inaturalist_taxon(session, name, None, within=ANIMALS)
                scientific = taxon.scientific if taxon else None
            except Unavailable:
                degraded = True
        for title, exact in ([(scientific, True)] if scientific else []) + [(name, False)]:
            try:
                summary = await wikipedia_summary(session, title)
            except Unavailable:
                degraded = True
                continue
            if summary is None or summary.get("type") != "standard":
                continue
            if not exact and not SPECIES_PAGE.search(str(summary.get("description") or "")):
                continue  # "Cardinal" is a church office, not a bird
            text, page = lead(summary.get("extract")), article_page(summary)
            if text is not None and page is not None:
                return Entry(name, scientific, _now(), text, page)
        if degraded:
            raise Unavailable
        return Entry(name, scientific, _now(), None, "")

    # ---- the remembered answers ----

    def _trim(self) -> None:
        for key in sorted(self._entries, key=lambda k: self._entries[k].checked)[: max(0, len(self._entries) - MAX_ENTRIES)]:
            del self._entries[key]

    def _data_to_save(self) -> dict[str, Any]:
        self._dirty = False
        return {"entries": {key: entry.to_json() for key, entry in self._entries.items()}}

    def _save_later(self) -> None:
        self._dirty = True
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_S)
