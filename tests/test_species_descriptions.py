"""Species descriptions: the few sentences about a species on its sheet (from Wikipedia) and the scientific names the lists carry.

Runs the real species_descriptions.py, reference_photos.py, reference_sounds.py and websocket_api.py with Home Assistant, Wikipedia
and iNaturalist faked (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import types
import unittest
from unittest import mock

import voluptuous as vol
from ha_stubs import (
    DISK,
    FakeResponse,
    FakeSession,
    HomeAssistant,
    KestrelApiError,
    SESSION,
    const_module,
    reference_module as sounds,
    reference_photos_module as photos,
    websocket_module,
)

descriptions = importlib.import_module("kestrel_pkg.species_descriptions")

import aiohttp  # the stub installed by ha_stubs

DOMAIN = const_module.DOMAIN
TAXA = f"{sounds.INAT_API}/taxa"
STORAGE = "kestrel.species_descriptions"
SCIENTIFIC = "Thryothorus ludovicianus"
ARTICLE = "https://en.wikipedia.org/wiki/Carolina_wren"
LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
DAY = 86400

FIRST = "The Carolina wren (Thryothorus ludovicianus) is a species of wren found in the eastern United States, southern Ontario and northeastern Mexico."
SECOND = "It is the state bird of South Carolina."
THIRD = "A reclusive bird, it is more often heard than seen."
FOURTH = "Pairs stay together for life."
EXTRACT = " ".join((FIRST, SECOND, THIRD, FOURTH))
LEAD = " ".join((FIRST, SECOND, THIRD))
RACCOON = "The raccoon is a medium-sized mammal native to North America. It is the largest of the procyonid family."


def wiki(title: str) -> str:
    return f"{photos.WIKI_API}/{title}"


def summary(**over: object) -> dict:
    return {
        "type": "standard", "title": "Carolina wren", "description": "Species of bird", "extract": EXTRACT,
        "content_urls": {"desktop": {"page": ARTICLE}}, **over,
    }


def taxon(scientific: str, common: str) -> dict:
    return {"results": [{"id": 41663, "rank": "species", "name": scientific, "preferred_common_name": common, "matched_term": common}]}


class Gated(FakeResponse):
    """A Wikipedia that answers only when the test says so."""

    def __init__(self, gate: asyncio.Event, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.gate = gate

    async def __aenter__(self) -> "Gated":
        await self.gate.wait()
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


class DescriptionTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        DISK.clear()
        self.session = FakeSession()
        SESSION["session"] = self.session
        self.hass = HomeAssistant()
        self.hass.data[DOMAIN] = {"birdnet_species_map": {"carolina wren": SCIENTIFIC}}
        self.clock = 1_800_000_000.0
        clock = mock.patch.object(descriptions, "_now", lambda: self.clock)
        clock.start()
        self.addCleanup(clock.stop)
        self.services: list[descriptions.SpeciesDescriptions] = []
        self.addAsyncCleanup(self.stop_services)

    async def stop_services(self) -> None:
        for service in self.services:
            await service.async_stop()
        DISK.clear()

    def service(self) -> descriptions.SpeciesDescriptions:
        service = descriptions.SpeciesDescriptions(self.hass)
        self.services.append(service)
        self.hass.data[DOMAIN]["species_descriptions"] = service
        return service

    def route_wren(self) -> None:
        """The article of the scientific name, reached through a redirect as Wikipedia does for a scientific name."""
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(302, headers={"Location": wiki("Carolina_wren")}))
        self.session.route("GET", wiki("Carolina_wren"), FakeResponse(200, summary()))

    def asked(self, url: str) -> int:
        return len(self.session.calls_to("GET", url))


# ---- the first sentences of an article -------------------------------------------------------------------------------


class LeadTests(unittest.TestCase):
    def test_the_first_three_whole_sentences_are_kept_as_one_plain_line(self) -> None:
        self.assertEqual(descriptions.lead(EXTRACT), LEAD)
        self.assertEqual(descriptions.lead(f"{FIRST}\n\n{SECOND}  \u200b{THIRD}\u00ad {FOURTH}"), LEAD)

    def test_a_full_stop_in_an_abbreviation_an_initial_or_an_acronym_does_not_end_a_sentence(self) -> None:
        first = "It winters in the southern U.S. in most years, e.g. in Texas."
        second = "J. J. Audubon described it near Mt. Pleasant in 1834."
        third = "It weighs approx. 20 grams."
        self.assertEqual(descriptions.lead(f"{first} {second} {third} A fourth sentence follows here."), f"{first} {second} {third}")

    def test_sentences_stop_before_the_limit_and_a_first_sentence_over_it_is_cut_at_a_word(self) -> None:
        sentences = [f"The {word} wren sings " + "and sings " * 17 + "all day." for word in ("first", "second", "third")]
        self.assertEqual(descriptions.lead(" ".join(sentences)), " ".join(sentences[:2]), "a third that does not fit is left out whole")
        endless = "The wren " + "sings and sings " * 40 + "for ever."
        cut = descriptions.lead(endless)
        self.assertTrue(cut.endswith("\u2026") and len(cut) <= descriptions.MAX_CHARS)
        self.assertTrue(endless.startswith(cut[:-1]) and not cut[:-1].endswith(" "))

    def test_nothing_worth_showing_is_none(self) -> None:
        for nothing in (None, 5, "", "Too short.", "Mercury may refer to: the planet, the element, a god, or one of many other things"):
            self.assertIsNone(descriptions.lead(nothing), nothing)

    def test_only_an_english_wikipedia_article_address_is_ever_kept(self) -> None:
        self.assertEqual(descriptions.article_page(summary()), ARTICLE)
        cooper = {"content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Cooper's_hawk"}}}
        self.assertEqual(descriptions.article_page(cooper), "https://en.wikipedia.org/wiki/Cooper%27s_hawk", "an apostrophe is kept as %27")
        for unusable in (
            {}, {"content_urls": None}, {"content_urls": {"desktop": {}}}, {"content_urls": {"desktop": {"page": 5}}},
            {"content_urls": {"desktop": {"page": "https://evil.example/wiki/Carolina_wren"}}},
            {"content_urls": {"desktop": {"page": "http://en.wikipedia.org/wiki/Carolina_wren"}}},
            {"content_urls": {"desktop": {"page": "https://en.wikipedia.org.evil.example/wiki/Carolina_wren"}}},
        ):
            self.assertIsNone(descriptions.article_page(unusable), unusable)


class EntryTests(unittest.TestCase):
    GOOD = {"name": "Carolina Wren", "scientific": SCIENTIFIC, "checked": 1.5, "text": LEAD, "page": ARTICLE}

    def test_what_is_credited_is_the_article_and_the_licence_it_is_shared_under(self) -> None:
        entry = descriptions.Entry.from_json(self.GOOD)
        self.assertEqual(entry.source(), {"name": "Wikipedia", "url": ARTICLE, "licence": "CC BY-SA 4.0", "licenceUrl": LICENCE_URL})
        self.assertIsNone(descriptions.Entry.from_json({**self.GOOD, "text": None, "page": ""}).source(), "no words, nobody to credit")

    def test_a_stored_answer_is_trusted_only_when_it_is_what_this_module_writes(self) -> None:
        self.assertEqual(descriptions.Entry.from_json(self.GOOD).to_json(), self.GOOD)
        self.assertIsNotNone(descriptions.Entry.from_json({**self.GOOD, "scientific": None, "text": None, "page": ""}))
        for damaged in (
            None, 5, [], {"name": "Carolina Wren"}, {**self.GOOD, "name": 5}, {**self.GOOD, "name": "  "},
            {**self.GOOD, "scientific": ""}, {**self.GOOD, "scientific": 7}, {**self.GOOD, "checked": True}, {**self.GOOD, "checked": "1"},
            {**self.GOOD, "text": "short"}, {**self.GOOD, "text": "x" * 600}, {**self.GOOD, "page": ""}, {**self.GOOD, "text": None},
            {**self.GOOD, "page": 5}, {**self.GOOD, "page": "https://evil.example/wiki/Carolina_wren"},
        ):
            self.assertIsNone(descriptions.Entry.from_json(damaged), damaged)


# ---- scientific names ------------------------------------------------------------------------------------------------


class ScientificNameTests(DescriptionTestCase):
    async def test_birdnet_gos_names_come_first_then_what_the_lookups_found_and_otherwise_nothing(self) -> None:
        self.hass.data[DOMAIN]["reference_photos"] = types.SimpleNamespace(scientific=lambda name: "Rana sylvatica" if name == "Wood Frog" else None)
        self.service()
        self.assertEqual(descriptions.scientific_name(self.hass, "Carolina Wren"), SCIENTIFIC)
        self.assertEqual(descriptions.scientific_name(self.hass, "  carolina   wren "), SCIENTIFIC, "spacing and capitals do not matter")
        self.assertEqual(descriptions.scientific_name(self.hass, "Wood Frog"), "Rana sylvatica")
        self.assertIsNone(descriptions.scientific_name(self.hass, "Unicorn"))
        for unusable in ("", "   ", "x" * 101, None, 7):
            self.assertIsNone(descriptions.scientific_name(self.hass, unusable), unusable)
        self.hass.data[DOMAIN]["birdnet_species_map"] = None  # not loaded yet
        self.assertIsNone(descriptions.scientific_name(self.hass, "Carolina Wren"))
        self.assertEqual(self.session.calls, [], "this never asks anyone")

    async def test_the_photo_lookup_asked_for_nothing_knows_nothing(self) -> None:
        self.assertIsNone(photos.ReferencePhotos(self.hass).scientific("Carolina Wren"))
        self.assertEqual(self.session.calls, [])


# ---- the service -----------------------------------------------------------------------------------------------------


class ServiceTests(DescriptionTestCase):
    async def test_a_bird_birdnet_go_lists_is_described_by_the_article_of_its_scientific_name(self) -> None:
        self.route_wren()
        entry = await self.service().async_describe("Carolina Wren")
        self.assertEqual((entry.text, entry.page, entry.scientific), (LEAD, ARTICLE, SCIENTIFIC))
        self.assertEqual(entry.source(), {"name": "Wikipedia", "url": ARTICLE, "licence": "CC BY-SA 4.0", "licenceUrl": LICENCE_URL})
        self.assertEqual(self.asked(TAXA), 0, "BirdNET-Go already named the bird")
        self.assertEqual(self.asked(wiki("Carolina_Wren")), 0, "the article of the scientific name was enough")

    async def test_a_name_with_an_apostrophe_gets_its_description_and_a_link_that_holds_no_quote(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {"cooper's hawk": "Astur cooperii"}
        self.session.route("GET", wiki("Astur_cooperii"), FakeResponse(200, summary(
            title="Cooper's hawk", content_urls={"desktop": {"page": "https://en.wikipedia.org/wiki/Cooper's_hawk"}},
        )))
        service = self.service()
        entry = await service.async_describe("Cooper\u2019s Hawk")
        self.assertEqual((entry.text, entry.page, entry.scientific), (LEAD, "https://en.wikipedia.org/wiki/Cooper%27s_hawk", "Astur cooperii"))
        await service.async_stop()
        self.assertEqual(descriptions.Entry.from_json(DISK[STORAGE]["entries"]["cooper's hawk"]).page, entry.page, "and it is kept")

    async def test_a_mammal_is_named_by_iNaturalist_and_the_name_is_then_known_to_the_lists(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, taxon("Procyon lotor", "Common Raccoon")))
        self.session.route("GET", wiki("Procyon_lotor"), FakeResponse(200, summary(
            title="Raccoon", description="Species of mammal", extract=RACCOON, content_urls={"desktop": {"page": "https://en.wikipedia.org/wiki/Raccoon"}},
        )))
        entry = await self.service().async_describe("Common Raccoon")
        self.assertEqual((entry.scientific, entry.text, entry.page), ("Procyon lotor", RACCOON, "https://en.wikipedia.org/wiki/Raccoon"))
        asked = self.session.calls_to("GET", TAXA)[0]["params"]
        self.assertEqual((asked["q"], asked["taxon_id"]), ("Common Raccoon", 1), "only animals are searched, as Kestrel only ever names animals")
        self.assertEqual(descriptions.scientific_name(self.hass, "Common Raccoon"), "Procyon lotor")

    async def test_the_search_stays_inside_one_branch_only_when_asked_to(self) -> None:
        self.session.route("GET", TAXA, FakeResponse(200, taxon("Falco columbarius", "Merlin")))
        self.assertEqual((await sounds.inaturalist_taxon(self.session, "Merlin", None)).scientific, "Falco columbarius")
        await sounds.inaturalist_taxon(self.session, "Merlin", None, within=1)
        plain, animals = (call["params"] for call in self.session.calls_to("GET", TAXA))
        self.assertNotIn("taxon_id", plain, "the lookups for sounds and photos ask as before")
        self.assertEqual(animals["taxon_id"], 1)

    async def test_a_page_found_only_by_common_name_must_be_about_a_species(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))  # iNaturalist does not know the name
        self.session.route("GET", wiki("Cardinal"), FakeResponse(200, summary(description="Senior official of the Catholic Church")))
        service = self.service()
        entry = await service.async_describe("Cardinal")
        self.assertEqual((entry.text, entry.page, entry.source()), (None, "", None))
        self.session.route("GET", wiki("Cardinal"), FakeResponse(200, summary(description="Species of bird")))
        self.clock += 8 * DAY
        self.assertEqual((await service.async_describe("Cardinal")).text, LEAD)

    async def test_a_page_that_is_not_a_plain_article_gives_no_description_and_never_a_link(self) -> None:
        self.session.route("GET", wiki("Carolina_Wren"), FakeResponse(404))
        for unusable in (
            summary(type="disambiguation"), summary(extract="Short."), summary(extract=None),
            summary(extract="The Carolina wren may refer to: a bird, a village, or a ship named after them"),
            summary(content_urls=None), summary(content_urls={"desktop": {"page": "https://evil.example/wiki/Carolina_wren"}}),
        ):
            self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(200, unusable))
            entry = await self.service().async_describe("Carolina Wren")
            self.assertEqual((entry.text, entry.page, entry.scientific), (None, "", SCIENTIFIC), unusable)

    async def test_a_description_is_kept_for_thirty_days_and_no_description_for_seven(self) -> None:
        self.route_wren()
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        service = self.service()
        first = await service.async_describe("Carolina Wren")
        self.clock += 29 * DAY
        self.assertIs(await service.async_describe("Carolina Wren"), first)
        self.assertEqual(self.asked(wiki("Thryothorus_ludovicianus")), 1)
        self.clock += 2 * DAY
        await service.async_describe("Carolina Wren")
        self.assertEqual(self.asked(wiki("Thryothorus_ludovicianus")), 2)

        self.assertIsNone((await service.async_describe("Unicorn")).text)
        self.clock += 6 * DAY
        await service.async_describe("Unicorn")
        self.assertEqual(self.asked(wiki("Unicorn")), 1, "an article may still be written, but not this week")
        self.clock += 2 * DAY
        await service.async_describe("Unicorn")
        self.assertEqual(self.asked(wiki("Unicorn")), 2)

    async def test_a_wikipedia_that_cannot_be_asked_is_not_remembered_and_is_asked_again_after_a_minute(self) -> None:
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(500))
        self.session.route("GET", wiki("Carolina_Wren"), aiohttp.ClientError("down"))
        service = self.service()
        self.assertIsNone(await service.async_describe("Carolina Wren"))
        self.assertEqual(service.diagnostics(), {"species_remembered": 0, "with_description": 0}, "no answer is not an answer")
        self.clock += 59
        self.assertIsNone(await service.async_describe("Carolina Wren"))
        self.assertEqual(self.asked(wiki("Thryothorus_ludovicianus")), 1, "within the minute nobody is bothered again")
        self.route_wren()
        self.clock += 2
        self.assertEqual((await service.async_describe("Carolina Wren")).text, LEAD)

    async def test_everyone_asking_at_once_causes_one_lookup(self) -> None:
        gate = asyncio.Event()
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), Gated(gate, 200, summary()))
        service = self.service()
        askers = [asyncio.ensure_future(service.async_describe(name)) for name in ("Carolina Wren", "carolina wren", " Carolina  Wren ")]
        await asyncio.sleep(0)
        gate.set()
        found = await asyncio.gather(*askers)
        self.assertEqual(self.asked(wiki("Thryothorus_ludovicianus")), 1)
        self.assertTrue(all(entry is found[0] and entry.text == LEAD for entry in found))

    async def test_a_sheet_waits_a_few_seconds_but_the_lookup_goes_on_and_is_kept(self) -> None:
        gate = asyncio.Event()
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), Gated(gate, 200, summary()))
        service = self.service()
        with mock.patch.object(descriptions, "ASK_WAIT_S", 0.05):
            self.assertIsNone(await service.async_describe("Carolina Wren"), "the sheet opens without it")
        gate.set()
        self.assertEqual((await service.async_describe("Carolina Wren")).text, LEAD, "and has it the next time")
        self.assertEqual(self.asked(wiki("Thryothorus_ludovicianus")), 1)

    async def test_an_unusable_name_is_never_looked_up(self) -> None:
        service = self.service()
        for name in ("", "   ", "x" * 101):
            self.assertIsNone(await service.async_describe(name))
        self.assertEqual(self.session.calls, [])

    async def test_what_was_found_survives_a_restart_and_a_damaged_file_is_ignored(self) -> None:
        self.route_wren()
        service = self.service()
        await service.async_describe("Carolina Wren")
        await service.async_stop()  # writes what has not been written yet
        self.assertEqual(list(DISK[STORAGE]["entries"]), ["carolina wren"])
        self.session.calls.clear()
        fresh = self.service()
        await fresh.async_load()
        self.assertEqual((await fresh.async_describe("Carolina Wren")).text, LEAD)
        self.assertEqual(self.session.calls, [], "answered from what was remembered")

        good = EntryTests.GOOD
        DISK[STORAGE] = {"entries": {
            "carolina wren": good,
            "blue jay": {**good, "name": "Blue Jay", "page": "https://evil.example/wiki/Blue_jay"},
            "somebody else": good,  # kept under the wrong name
            "junk": 5,
        }}
        damaged = self.service()
        await damaged.async_load()
        self.assertEqual(damaged.diagnostics(), {"species_remembered": 1, "with_description": 1})
        for nothing in (None, ["not", "a", "dict"], {"entries": 5}):
            DISK[STORAGE] = copy.deepcopy(nothing)
            empty = self.service()
            await empty.async_load()
            self.assertEqual(empty.diagnostics()["species_remembered"], 0, nothing)

    async def test_the_oldest_answers_are_forgotten_beyond_the_limit(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {f"bird {number}": f"Aus {number}" for number in range(5)}
        service = self.service()
        with mock.patch.object(descriptions, "MAX_ENTRIES", 3):
            for number in range(5):
                self.clock += 1
                await service.async_describe(f"Bird {number}")
        self.assertEqual([service.scientific(f"Bird {number}") for number in range(5)], [None, None, "Aus 2", "Aus 3", "Aus 4"])

    async def test_diagnostics_count_the_answers_and_never_show_the_words(self) -> None:
        self.route_wren()
        self.hass.data[DOMAIN]["birdnet_species_map"]["unicorn"] = "Equus monoceros"
        service = self.service()
        await service.async_describe("Carolina Wren")
        await service.async_describe("Unicorn")
        self.assertEqual(service.diagnostics(), {"species_remembered": 2, "with_description": 1})

    async def test_removing_the_integration_forgets_everything_on_disk(self) -> None:
        self.route_wren()
        service = self.service()
        await service.async_describe("Carolina Wren")
        await service.async_stop()
        self.assertIn(STORAGE, DISK)
        await service.async_remove()
        self.assertNotIn(STORAGE, DISK)


# ---- what the panel is sent ------------------------------------------------------------------------------------------


class WebsocketTestCase(DescriptionTestCase):
    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.plugin: dict[str, object] = {}  # what the plugin answers by path (an exception is raised instead)
        self.requests: list[tuple[str, str, object]] = []

        async def async_request(method: str, path: str, params: object = None, json: object = None) -> object:
            self.requests.append((method, path, params))
            answer = self.plugin.get(path)
            if isinstance(answer, Exception):
                raise answer
            return copy.deepcopy(answer)

        self.hass.data[DOMAIN]["coordinator"] = types.SimpleNamespace(client=types.SimpleNamespace(async_request=async_request))
        self.connection = FakeConnection()

    async def call(self, command: object, **msg: object) -> object:
        self.connection.results.clear()
        await command(self.hass, self.connection, {"id": 7, **msg})
        return self.connection.results[-1] if self.connection.results else None


class SpeciesListTests(WebsocketTestCase):
    async def test_the_period_is_passed_on_and_every_species_says_its_scientific_name(self) -> None:
        self.plugin["species"] = {
            "items": [
                {"species": "Carolina Wren", "hasPhoto": True, "periodCount": 3},
                {"species": "Red Fox", "hasPhoto": False, "periodCount": 1},
            ],
            "period": "week", "since": 1_800_000_000,
        }
        result = await self.call(websocket_module.ws_species, type="kestrel/species", period="week")
        self.assertEqual(self.requests, [("GET", "species", {"period": "week"})])
        self.assertEqual([(item["species"], item["scientific"]) for item in result["items"]], [("Carolina Wren", SCIENTIFIC), ("Red Fox", None)])
        self.assertEqual((result["period"], result["since"], result["items"][0]["periodCount"]), ("week", 1_800_000_000, 3))
        self.assertIn("photo_url", result["items"][0])
        self.assertEqual(self.connection.errors, [])

    async def test_without_a_period_the_plugin_is_asked_for_everything(self) -> None:
        self.plugin["species"] = {"items": []}
        await self.call(websocket_module.ws_species, type="kestrel/species")
        self.assertEqual(self.requests, [("GET", "species", None)])

    def test_only_the_four_periods_are_accepted(self) -> None:
        for period in ("today", "week", "month", "all"):
            self.assertEqual(websocket_module.ws_species.ws_schema({"id": 1, "type": "kestrel/species", "period": period})["period"], period)
        websocket_module.ws_species.ws_schema({"id": 1, "type": "kestrel/species"})
        for period in ("decade", "", "Week", 7, None):
            with self.assertRaises(vol.Invalid, msg=period):
                websocket_module.ws_species.ws_schema({"id": 1, "type": "kestrel/species", "period": period})


class HighlightsTests(WebsocketTestCase):
    async def test_the_plugins_three_highlights_come_through_with_links_and_scientific_names(self) -> None:
        self.plugin["highlights"] = {
            "period": "week", "kind": "heard",
            "latest": {"species": "Carolina Wren", "grp": "bird", "kind": "heard", "count": 3, "total": 40, "at": 5, "visitId": "v1", "hasPhoto": True},
            "top": {"species": "Red Fox", "grp": "mammal", "kind": "seen", "count": 9, "total": 9, "at": 6, "visitId": "v2", "hasPhoto": False},
            "rare": None,
        }
        result = await self.call(websocket_module.ws_highlights, type="kestrel/highlights", period="week", kind="heard")
        self.assertEqual(self.requests, [("GET", "highlights", {"period": "week", "kind": "heard"})])
        self.assertEqual((result["latest"]["scientific"], result["top"]["scientific"], result["rare"]), (SCIENTIFIC, None, None))
        self.assertIn("photo_url", result["latest"])
        self.assertEqual((result["latest"]["visitId"], result["top"]["count"]), ("v1", 9))

    async def test_period_and_kind_are_optional_and_only_known_ones_are_accepted(self) -> None:
        self.plugin["highlights"] = {"period": "all", "kind": "both", "latest": None, "top": None, "rare": None}
        await self.call(websocket_module.ws_highlights, type="kestrel/highlights")
        await self.call(websocket_module.ws_highlights, type="kestrel/highlights", kind="seen")
        self.assertEqual(self.requests, [("GET", "highlights", None), ("GET", "highlights", {"kind": "seen"})])
        schema = websocket_module.ws_highlights.ws_schema
        for bad in ({"period": "decade"}, {"kind": "everything"}, {"kind": 1}, {"period": None}):
            with self.assertRaises(vol.Invalid, msg=bad):
                schema({"id": 1, "type": "kestrel/highlights", **bad})

    async def test_a_plugin_that_does_not_know_the_command_is_an_error_not_a_crash(self) -> None:
        self.plugin["highlights"] = KestrelApiError("Not found", status=404)
        await self.call(websocket_module.ws_highlights, type="kestrel/highlights")
        self.assertEqual(self.connection.errors, [("not_found", "Not found")])


class SpeciesSheetTests(WebsocketTestCase):
    SHEET = {"species": "Carolina Wren", "hasPhoto": True, "perDay": [0] * 30, "newToHome": False, "description": None, "descriptionSource": None, "visits": [], "next": None}

    async def test_the_sheet_gets_its_description_with_the_credit_and_the_scientific_name(self) -> None:
        self.plugin["species/Carolina%20Wren"] = copy.deepcopy(self.SHEET)
        self.route_wren()
        self.service()
        result = await self.call(websocket_module.ws_species_detail, type="kestrel/species/detail", species="Carolina Wren")
        self.assertEqual(
            (result["description"], result["descriptionSource"], result["scientific"]),
            (LEAD, {"name": "Wikipedia", "url": ARTICLE, "licence": "CC BY-SA 4.0", "licenceUrl": LICENCE_URL}, SCIENTIFIC),
        )
        self.assertEqual({key: result[key] for key in ("perDay", "newToHome", "visits", "next")}, {key: self.SHEET[key] for key in ("perDay", "newToHome", "visits", "next")})
        self.assertEqual(self.requests, [("GET", "species/Carolina%20Wren", None)])

    async def test_a_species_only_iNaturalist_can_name_gets_its_name_and_description_on_its_sheet(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.plugin["species/Common%20Raccoon"] = {**self.SHEET, "species": "Common Raccoon", "hasPhoto": False}
        self.session.route("GET", TAXA, FakeResponse(200, taxon("Procyon lotor", "Common Raccoon")))
        self.session.route("GET", wiki("Procyon_lotor"), FakeResponse(200, summary(
            description="Species of mammal", extract=RACCOON, content_urls={"desktop": {"page": "https://en.wikipedia.org/wiki/Raccoon"}},
        )))
        self.service()
        result = await self.call(websocket_module.ws_species_detail, type="kestrel/species/detail", species="Common Raccoon")
        self.assertEqual((result["scientific"], result["description"]), ("Procyon lotor", RACCOON))

    async def test_a_sheet_opens_without_a_description_when_there_is_none_or_wikipedia_cannot_be_asked(self) -> None:
        self.plugin["species/Carolina%20Wren"] = copy.deepcopy(self.SHEET)
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(503))
        self.session.route("GET", wiki("Carolina_Wren"), FakeResponse(503))
        self.service()
        result = await self.call(websocket_module.ws_species_detail, type="kestrel/species/detail", species="Carolina Wren")
        self.assertEqual((result["description"], result["descriptionSource"], result["scientific"]), (None, None, SCIENTIFIC))
        self.assertEqual((len(self.connection.results), self.connection.errors), (1, []))

        del self.hass.data[DOMAIN]["species_descriptions"]  # the service is not running at all
        result = await self.call(websocket_module.ws_species_detail, type="kestrel/species/detail", species="Carolina Wren")
        self.assertEqual((result["description"], result["descriptionSource"]), (None, None))

    async def test_a_species_the_plugin_does_not_know_is_not_found(self) -> None:
        self.plugin["species/Unicorn"] = KestrelApiError("Not found", status=404)
        self.service()
        await self.call(websocket_module.ws_species_detail, type="kestrel/species/detail", species="Unicorn")
        self.assertEqual(self.connection.errors, [("not_found", "Not found")])
        self.assertEqual(self.session.calls, [], "Wikipedia is not asked about a species nobody has seen")


if __name__ == "__main__":
    unittest.main()
