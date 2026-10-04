"""Reference photos: BirdNET-Go first, then iNaturalist, then Wikipedia; what is remembered, what may be fetched and served.

Runs the real reference_photos.py, media.py and websocket_api.py with Home Assistant, BirdNET-Go, iNaturalist and Wikipedia
faked (see ha_stubs.py). The answers follow what the real services send (checked live):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from ha_stubs import (
    DISK,
    FakeResponse,
    FakeSession,
    HomeAssistant,
    SESSION,
    const_module,
    media_module,
    reference_module as sounds,
    reference_photos_module as photos,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

DOMAIN = const_module.DOMAIN
BIRDNET = const_module.BIRDNET_GO_INTERNAL_URL
BN_INFO = f"{BIRDNET}/api/v2/media/species-image/info"
BN_IMAGE = f"{BIRDNET}/api/v2/media/image/Thryothorus%20ludovicianus"
SCIENTIFIC = "Thryothorus ludovicianus"
TAXA = f"{sounds.INAT_API}/taxa"
T0 = 1_800_000_000.0
DAY = 86400.0
JPEG = b"\xff\xd8\xff\xe0" + b"j" * 4000  # big enough to be a picture
THUMB = "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/Carolina_wren_%2814391%29.jpg/330px-Carolina_wren_%2814391%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail"
ORIGINAL = "https://upload.wikimedia.org/wikipedia/commons/d/d3/Carolina_wren_%2814391%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail_unscaled"
WREN_960 = "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/Carolina_wren_%2814391%29.jpg/960px-Carolina_wren_%2814391%29.jpg"
ARTICLE = "https://en.wikipedia.org/wiki/Carolina_wren"
COMMONS = {"query": {"pages": [{"imageinfo": [{"extmetadata": {
    "Artist": {"value": '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane  Doe</a> &amp; friends'},
    "LicenseShortName": {"value": "CC BY-SA 4.0"}}}]}]}}


def inat_photo(photo_id: int = 428809700, **over: object) -> dict:
    """iNaturalist's default photo of a taxon, as its taxa answer gives it (checked live: no large_url, licence may be null)."""
    return {
        "id": photo_id, "license_code": None, "attribution": "(c) Jake Scott, all rights reserved", "attribution_name": "Jake Scott",
        "url": f"https://static.inaturalist.org/photos/{photo_id}/square.jpeg", "flags": [],
        "medium_url": f"https://static.inaturalist.org/photos/{photo_id}/medium.jpeg", **over,
    }


def taxon(taxon_id: int, scientific: str, common: str, photo: dict | None = None) -> dict:
    return {"id": taxon_id, "name": scientific, "rank": "species", "preferred_common_name": common, "matched_term": common, "default_photo": photo}


def size(total: int) -> FakeResponse:
    """What a file server says to "just the first byte, please"."""
    return FakeResponse(206, body=b"x", headers={"Content-Range": f"bytes 0-{0}/{total}"})


def picture(body: bytes = JPEG, kind: str = "image/jpeg", **headers: str) -> FakeResponse:
    return FakeResponse(200, body=body, headers={"Content-Type": kind, **headers})


def summary(**over: object) -> dict:
    """A Wikipedia REST summary (checked live for the Carolina wren)."""
    return {
        "type": "standard", "title": "Carolina wren", "description": "Species of bird",
        "thumbnail": {"source": THUMB, "width": 330, "height": 257}, "originalimage": {"source": ORIGINAL, "width": 2964, "height": 2310},
        "content_urls": {"desktop": {"page": ARTICLE}}, **over,
    }


def wiki(title: str) -> str:
    return f"{photos.WIKI_API}/{title}"


class PhotoTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        DISK.clear()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.hass = HomeAssistant()
        self.hass.config = types.SimpleNamespace(path=lambda *parts: os.path.join(self.folder.name, *parts))
        self.hass.data[DOMAIN] = {"birdnet_species_map": {"carolina wren": SCIENTIFIC}}
        self.clock = T0
        for name, value in (("_now", lambda: self.clock), ("BIRDNET_WAIT_S", 0)):
            patcher = mock.patch.object(photos, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.services: list[photos.ReferencePhotos] = []

    async def asyncTearDown(self) -> None:
        for service in self.services:
            await service.async_stop()

    def service(self) -> photos.ReferencePhotos:
        service = photos.ReferencePhotos(self.hass)
        self.services.append(service)
        self.hass.data[DOMAIN]["reference_photos"] = service
        return service

    def calls(self, url: str) -> list[dict]:
        return self.session.calls_to("GET", url)

    def route_taxon(self, scientific: str, common: str, photo: dict | None, taxon_id: int = 7513) -> None:
        self.session.route("GET", TAXA, FakeResponse(200, {"results": [taxon(taxon_id, scientific, common, photo)]}))

    def route_inat_files(self, photo_id: int = 428809700, large: int | None = 400_000, medium: int | None = 90_000) -> None:
        for kind, total in (("large", large), ("medium", medium)):
            self.session.route("GET", f"https://static.inaturalist.org/photos/{photo_id}/{kind}.jpeg", size(total) if total else FakeResponse(404))

    def route_wren_article(self) -> None:
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(302, headers={"Location": wiki("Carolina_wren")}))
        self.session.route("GET", wiki("Carolina_wren"), FakeResponse(200, summary()))
        self.session.route("GET", photos.COMMONS_API, FakeResponse(200, COMMONS))


# ---- the chain -------------------------------------------------------------------------------------------------------


class ChainTests(PhotoTestCase):
    async def test_birdnet_go_is_asked_first_and_its_picture_is_streamed_from_the_add_on(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(200, {"authorName": "Jonathan Irons"}))
        service = self.service()
        found = await service.async_image("Carolina Wren")
        self.assertEqual((found.stream, found.path), (BN_IMAGE, None))
        self.assertEqual(self.calls(BN_INFO)[0]["params"], {"name": SCIENTIFIC})
        self.assertEqual(self.calls(TAXA), [], "no other source was asked")
        self.assertEqual(self.session.calls_to("GET", wiki("Carolina_wren")), [])
        self.assertFalse(Path(service.photo_dir).exists(), "and nothing is copied")

    async def test_when_birdnet_go_has_none_iNaturalists_default_photo_is_used_large_and_with_its_credit(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        service = self.service()
        entry = await service.async_resolve("Carolina Wren")
        self.assertEqual((entry.photo.source, entry.scientific), ("inaturalist", SCIENTIFIC))
        self.assertEqual(entry.photo.image, "https://static.inaturalist.org/photos/428809700/large.jpeg")
        self.assertEqual(
            await service.async_info("Carolina Wren"),
            {"source": "iNaturalist", "credit": "Jake Scott", "licence": "All rights reserved", "page": "https://www.inaturalist.org/photos/428809700"},
        )
        self.assertEqual(self.session.calls_to("GET", wiki("Carolina_wren")), [], "Wikipedia was not needed")
        self.assertEqual(self.calls(TAXA)[0]["params"]["q"], SCIENTIFIC, "the scientific name BirdNET-Go knows is asked first")

    async def test_a_licensed_photo_names_its_licence_and_a_missing_large_size_falls_back_to_the_medium_one(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo(license_code="cc-by-nc"))
        self.route_inat_files(large=None)
        entry = await self.service().async_resolve("Carolina Wren")
        self.assertEqual((entry.photo.image, entry.photo.licence), ("https://static.inaturalist.org/photos/428809700/medium.jpeg", "CC BY-NC"))

    async def test_a_name_birdnet_go_does_not_list_is_identified_by_iNaturalist_and_birdnet_go_is_then_asked_by_that_name(self) -> None:
        self.route_taxon("Procyon lotor", "Common Raccoon", inat_photo(55), taxon_id=41663)
        self.route_inat_files(55)
        entry = await self.service().async_resolve("Common Raccoon")
        self.assertEqual((entry.scientific, entry.photo.source), ("Procyon lotor", "inaturalist"))
        self.assertEqual(self.calls(BN_INFO)[0]["params"], {"name": "Procyon lotor"})
        self.assertEqual(len(self.calls(TAXA)), 1, "iNaturalist was asked who it is once, and its photo came with the answer")

    async def test_a_species_birdnet_go_only_knows_under_another_name_still_gets_birdnet_gos_picture(self) -> None:
        self.route_taxon("Columba livia", "Rock Pigeon", inat_photo(9))
        self.session.route("GET", BN_INFO, FakeResponse(200, {}))
        entry = await self.service().async_resolve("Rock Pigeon")
        self.assertEqual((entry.photo.source, entry.scientific), ("birdnet-go", "Columba livia"))

    async def test_wikipedia_is_the_last_resort_its_page_image_is_resized_and_its_author_and_licence_come_from_commons(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", None)
        self.route_wren_article()
        service = self.service()
        entry = await service.async_resolve("Carolina Wren")
        self.assertEqual((entry.photo.source, entry.photo.image, entry.photo.ext), ("wikipedia", WREN_960, "jpg"))
        self.assertEqual(
            await service.async_info("Carolina Wren"),
            {"source": "Wikipedia", "credit": "Jane Doe & friends", "licence": "CC BY-SA 4.0", "page": ARTICLE},
        )
        [lookup] = self.calls(photos.COMMONS_API)
        self.assertEqual(lookup["params"]["titles"], "File:Carolina wren (14391).jpg")

    async def test_a_photo_iNaturalist_moderators_flagged_or_whose_file_is_gone_is_passed_over(self) -> None:
        for given, files in ((inat_photo(flags=[{"flag": "copyright"}]), {}), (inat_photo(), {"large": None, "medium": None})):
            self.hass.data[DOMAIN]["reference_photos"] = None
            self.route_taxon(SCIENTIFIC, "Carolina Wren", given)
            self.route_inat_files(**files)
            self.route_wren_article()
            entry = await self.service().async_resolve("Carolina Wren")
            self.assertEqual(entry.photo.source, "wikipedia", given)
            DISK.clear()

    async def test_a_page_found_by_common_name_must_be_about_a_species_and_a_page_without_a_picture_is_skipped(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))  # iNaturalist does not know the name
        self.session.route("GET", wiki("Cardinal"), FakeResponse(200, summary(description="Senior official of the Catholic Church")))
        self.assertIsNone((await self.service().async_resolve("Cardinal")).photo)
        for unusable in (summary(type="disambiguation"), summary(thumbnail=None, originalimage=None), summary(originalimage={"source": "https://evil.example/x.jpg", "width": 100}, thumbnail=None)):
            DISK.clear()
            self.session.route("GET", wiki("Cardinal"), FakeResponse(200, unusable))
            self.assertIsNone((await self.service().async_resolve("Cardinal")).photo, unusable)
        DISK.clear()
        self.session.route("GET", wiki("Cardinal"), FakeResponse(200, summary(description="Species of bird")))
        self.session.route("GET", photos.COMMONS_API, FakeResponse(200, COMMONS))
        self.assertEqual((await self.service().async_resolve("Cardinal")).photo.source, "wikipedia")

    async def test_birdnet_go_still_resolving_is_waited_for_a_few_times_and_then_not_trusted(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(503), FakeResponse(202), FakeResponse(200, {}))
        self.assertEqual((await self.service().async_resolve("Carolina Wren")).photo.source, "birdnet-go")
        self.assertEqual(len(self.calls(BN_INFO)), 3)

        DISK.clear()
        self.calls(BN_INFO).clear()
        self.session.calls.clear()
        self.session.route("GET", BN_INFO, FakeResponse(503))
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        entry = await self.service().async_resolve("Carolina Wren")
        self.assertEqual((len(self.calls(BN_INFO)), entry.photo.source, entry.exact), (3, "inaturalist", False))

    async def test_an_unreachable_birdnet_go_is_skipped_at_once(self) -> None:
        self.session.route("GET", BN_INFO, aiohttp.ClientError("down"))
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        entry = await self.service().async_resolve("Carolina Wren")
        self.assertEqual((len(self.calls(BN_INFO)), entry.photo.source, entry.exact), (1, "inaturalist", False))


# ---- what is remembered ----------------------------------------------------------------------------------------------


class MemoryTests(PhotoTestCase):
    async def test_a_found_photo_is_not_asked_for_again_not_even_after_a_restart(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        service = self.service()
        first = await service.async_resolve("Carolina Wren")
        asked = len(self.session.calls)
        self.assertIs(await service.async_resolve("carolina  WREN"), first)
        await service.async_stop()
        again = self.service()
        await again.async_load()
        self.assertEqual((await again.async_resolve("Carolina Wren")).photo, first.photo)
        self.assertEqual(len(self.session.calls), asked)

    async def test_no_photo_anywhere_is_remembered_for_a_week_and_then_no_link_is_offered_until_it_is_asked_again(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        self.session.route("GET", wiki("Unicorn"), FakeResponse(404))
        service = self.service()
        self.assertTrue(service.offer("Unicorn"), "never looked at: a link may be tried")
        self.assertIsNone((await service.async_resolve("Unicorn")).photo)
        self.assertFalse(service.offer("Unicorn"), "every source said no: no link is worth signing")
        asked = len(self.session.calls)
        self.clock = T0 + 6 * DAY
        self.assertIsNone((await service.async_resolve("Unicorn")).photo)
        self.assertEqual(len(self.session.calls), asked, "still remembered after 6 days")
        self.clock = T0 + 8 * DAY
        self.assertTrue(service.offer("Unicorn"), "a week on it may have one")
        await service.async_resolve("Unicorn")
        self.assertGreater(len(self.session.calls), asked)

    async def test_a_found_photo_is_good_for_30_days_and_birdnet_gos_for_a_day(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(200, {}))
        service = self.service()
        await service.async_resolve("Carolina Wren")
        self.clock = T0 + 0.9 * DAY
        await service.async_resolve("Carolina Wren")
        self.assertEqual(len(self.calls(BN_INFO)), 1)
        self.clock = T0 + 1.1 * DAY
        await service.async_resolve("Carolina Wren")
        self.assertEqual(len(self.calls(BN_INFO)), 2, "BirdNET-Go's copy is asked about again after a day")

        DISK.clear()
        other = self.service()
        self.session.route("GET", BN_INFO, FakeResponse(404))
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        self.clock = T0 + 2 * DAY
        await other.async_resolve("Carolina Wren")
        asked = len(self.session.calls)
        self.clock = T0 + 31 * DAY
        await other.async_resolve("Carolina Wren")
        self.assertEqual(len(self.session.calls), asked, "a fallback photo is good for 30 days")
        self.clock = T0 + 33 * DAY
        await other.async_resolve("Carolina Wren")
        self.assertGreater(len(self.session.calls), asked)

    async def test_a_source_that_cannot_be_asked_is_never_remembered_as_no_photo_and_is_not_hammered(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(404))
        self.session.route("GET", TAXA, aiohttp.ClientError("offline"))
        self.session.route("GET", wiki("Thryothorus_ludovicianus"), FakeResponse(503))
        self.session.route("GET", wiki("Carolina_wren"), FakeResponse(503))
        service = self.service()
        self.assertIsNone(await service.async_resolve("Carolina Wren"))
        self.assertTrue(service.offer("Carolina Wren"), "not 'no photo': the link is still offered")
        asked = len(self.session.calls)
        self.clock += 30
        self.assertIsNone(await service.async_resolve("Carolina Wren"))
        self.assertEqual(len(self.session.calls), asked, "no request while it pauses")

        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        self.clock += 40
        self.assertEqual((await service.async_resolve("Carolina Wren")).photo.source, "inaturalist")
        await service.async_stop()
        self.assertEqual(list(DISK["kestrel.reference_photos"]["entries"]), ["carolina wren"])

    async def test_an_answer_made_while_a_better_source_was_down_is_asked_again_after_an_hour(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(404))
        self.session.route("GET", TAXA, FakeResponse(500))
        self.route_wren_article()
        service = self.service()
        self.assertEqual((await service.async_resolve("Carolina Wren")).photo.source, "wikipedia")
        self.clock = T0 + 1800
        self.assertEqual((await service.async_resolve("Carolina Wren")).photo.source, "wikipedia", "half an hour: kept")
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        self.clock = T0 + 3700
        self.assertEqual((await service.async_resolve("Carolina Wren")).photo.source, "inaturalist", "an hour on: iNaturalist is back")

    async def test_a_lookup_that_runs_out_of_time_is_just_no_picture_right_now(self) -> None:
        async def never(name: str) -> object:
            await asyncio.Event().wait()

        service = self.service()
        with mock.patch.object(service, "_find", never), mock.patch.object(photos, "LOOKUP_TIMEOUT_S", 0.01):
            self.assertIsNone(await service.async_resolve("Carolina Wren"))

    async def test_a_bug_in_a_lookup_is_no_picture_not_a_crash(self) -> None:
        service = self.service()
        with mock.patch.object(service, "_find", side_effect=RuntimeError("boom")), self.assertLogs(photos.__name__, "ERROR"):
            self.assertIsNone(await service.async_resolve("Carolina Wren"))

    async def test_two_requests_at_once_share_one_lookup(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        first, second = await asyncio.gather(self.service().async_resolve("Carolina Wren"), self.services[0].async_resolve("Carolina Wren"))
        self.assertIs(first, second)
        self.assertEqual((len(self.calls(BN_INFO)), len(self.calls(TAXA))), (1, 1))

    async def test_what_is_kept_is_bounded_and_damaged_or_foreign_entries_are_ignored(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        service = self.service()
        with mock.patch.object(photos, "MAX_ENTRIES", 3):
            for number in range(5):
                self.clock += 1
                await service.async_resolve(f"Species {number}")
            self.assertEqual(sorted(service._entries), ["species 2", "species 3", "species 4"], "the oldest go first")

        good = photos.Photo("inaturalist", "Jake", "CC0", "https://www.inaturalist.org/photos/5", "https://static.inaturalist.org/photos/5/large.jpeg", "jpeg")
        entry = {"name": "Good Bird", "scientific": None, "checked": T0, "exact": True, "photo": good.to_json()}
        bn = photos.Photo("birdnet-go", "", "", "", "", "").to_json()
        DISK["kestrel.reference_photos"] = {"entries": {
            "good bird": entry,
            "wrong key": entry,
            "bad host": {**entry, "name": "Bad Host", "photo": {**good.to_json(), "image": "https://evil.example/5.jpeg"}},
            "bad page": {**entry, "name": "Bad Page", "photo": {**good.to_json(), "page": "javascript:alert(1)"}},
            "bad type": {**entry, "name": "Bad Type", "photo": {**good.to_json(), "ext": "exe"}},
            "birdnet with an address": {**entry, "name": "Birdnet With An Address", "scientific": "Aus bus", "photo": {**bn, "image": "https://evil.example/x"}},
            "birdnet without a name": {**entry, "name": "Birdnet Without A Name", "photo": bn},
            "birdnet fine": {**entry, "name": "Birdnet Fine", "scientific": "Aus bus", "photo": bn},
            "not a dict": "oops",
        }}
        fresh = self.service()
        await fresh.async_load()
        self.assertEqual(sorted(fresh._entries), ["birdnet fine", "good bird"])


# ---- the pictures ----------------------------------------------------------------------------------------------------


class FileTests(PhotoTestCase):
    async def lookup(self) -> tuple[photos.ReferencePhotos, str]:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        service = self.service()
        entry = await service.async_resolve("Carolina Wren")
        return service, entry.photo.image

    async def test_the_first_view_fetches_the_picture_once_and_later_views_come_from_disk(self) -> None:
        service, address = await self.lookup()
        self.session.route("GET", address, picture())
        first, second = await asyncio.gather(service.async_image("Carolina Wren"), service.async_image("Carolina Wren"))
        self.assertEqual(first, second)
        self.assertEqual((first.stream, first.content_type, first.path.read_bytes()), (None, "image/jpeg", JPEG))
        self.assertEqual(first.path.parent, service.photo_dir)
        self.assertRegex(first.path.name, r"^[0-9a-f]{24}\.jpeg$", "named from the address, never from the species name")
        self.assertEqual(len(self.calls(address)) - 1, 1, "one fetch for two views (and one size probe)")
        self.assertEqual(sorted(p.name for p in service.photo_dir.iterdir()), [first.path.name], "no half-written file is left")
        self.session.calls.clear()
        self.assertEqual(await service.async_image("Carolina Wren"), first)
        self.assertEqual(self.session.calls, [])

    async def test_a_page_a_huge_file_or_a_scrap_is_not_kept_as_a_picture(self) -> None:
        refused = {
            "a web page": picture(b"<html>" + b"x" * 4000, "text/html"),
            "a declared huge file": picture(JPEG, "image/jpeg", **{"Content-Length": str(photos.MAX_PHOTO_BYTES + 1)}),
            "a huge file that says nothing about its size": picture(b"x" * (photos.MAX_PHOTO_BYTES + 10)),
            "a scrap": picture(b"\xff\xd8"),
            "an error page": FakeResponse(500),
        }
        for what, answer in refused.items():
            DISK.clear()
            service, address = await self.lookup()  # found (the size probe says yes) ...
            self.session.route("GET", address, answer)  # ... and then what comes back is not a picture
            self.assertIsNone(await service.async_image("Carolina Wren"), what)
            self.assertFalse(service.photo_dir.exists() and any(service.photo_dir.iterdir()), what)
            await service.async_stop()
            self.services.clear()

    async def test_a_picture_the_source_no_longer_has_makes_the_next_look_ask_again_after_a_pause(self) -> None:
        service, address = await self.lookup()
        self.session.route("GET", address, FakeResponse(404))
        self.assertIsNone(await service.async_image("Carolina Wren"))
        self.assertNotIn("carolina wren", service._entries, "the answer is forgotten")
        self.assertIsNone(await service.async_image("Carolina Wren"), "and not asked again at once")
        self.clock += 90
        self.route_wren_article()
        self.session.route("GET", address, FakeResponse(404))
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files(large=None, medium=None)  # iNaturalist's file is really gone: the probe now says so
        self.assertEqual((await service.async_resolve("Carolina Wren")).photo.source, "wikipedia")

    async def test_a_redirect_is_followed_only_within_the_sources_own_hosts(self) -> None:
        service, address = await self.lookup()
        self.session.route("GET", address, FakeResponse(302, headers={"Location": "https://evil.example/steal.jpeg"}))
        self.assertIsNone(await service.async_image("Carolina Wren"))
        self.assertEqual(self.calls("https://evil.example/steal.jpeg"), [], "never fetched")
        DISK.clear()
        service, address = await self.lookup()
        elsewhere = "https://inaturalist-open-data.s3.amazonaws.com/photos/428809700/large.jpeg"
        self.session.route("GET", address, FakeResponse(302, headers={"Location": elsewhere}))
        self.session.route("GET", elsewhere, picture())
        self.assertEqual((await service.async_image("Carolina Wren")).path.read_bytes(), JPEG)

    async def test_a_full_or_unwritable_disk_means_no_picture_not_an_error(self) -> None:
        service, address = await self.lookup()
        self.session.route("GET", address, picture())
        with mock.patch.object(photos, "store_file", side_effect=OSError("No space left on device")), self.assertLogs(photos.__name__, "WARNING") as logs:
            self.assertIsNone(await service.async_image("Carolina Wren"))
        self.assertNotIn("No space", "\n".join(logs.output))

    async def test_names_that_are_not_species_names_never_name_a_file_or_an_address(self) -> None:
        service = self.service()
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        self.session.route("GET", wiki("..%2F..%2Fetc%2Fpasswd"), FakeResponse(404))
        for bad in ("", "   ", "x" * 101, None, 5, "\x00\x01"):
            self.assertIsNone(await service.async_image(bad), repr(bad))
            self.assertFalse(service.offer(bad) if isinstance(bad, str) else False, repr(bad))
        self.assertEqual(self.session.calls, [])
        await service.async_image("../../etc/passwd")
        for _, url, kwargs in self.session.calls:
            self.assertTrue(url.startswith((BIRDNET, sounds.INAT_API, photos.WIKI_API)), url)
            self.assertNotIn("passwd", url.replace("%2F", "/").replace("..%2F", "") if url.startswith(sounds.INAT_API) else "", url)
        self.assertFalse(service.photo_dir.exists())


# ---- who took it -----------------------------------------------------------------------------------------------------


class InfoTests(PhotoTestCase):
    async def test_birdnet_gos_attribution_is_translated_to_the_panels_shape(self) -> None:
        sample = {"authorName": "Jonathan Irons", "authorURL": "", "licenseName": "CC BY-NC 3.0", "licenseURL": "https://creativecommons.org/licenses/by-nc/3.0/",
                  "sourceProvider": "avicommons", "url": "https://example.test/x.jpg"}
        self.session.route("GET", BN_INFO, FakeResponse(200, sample))
        self.assertEqual(
            await self.service().async_info("Carolina Wren"),
            {"source": "Avicommons", "credit": "Jonathan Irons", "licence": "CC BY-NC 3.0", "page": ""},
        )

    def test_odd_attribution_is_tidied_and_never_becomes_a_link_that_is_not_https(self) -> None:
        self.assertEqual(
            photos.birdnet_info({"AUTHOR_NAME": " <b>Ann</b>\n Lee ", "license_name": "CC0", "authorUrl": "javascript:alert(1)", "source_provider": "Wikimedia"}),
            {"source": "Wikimedia Commons", "credit": "Ann Lee", "licence": "CC0", "page": ""},
        )
        self.assertEqual(photos.birdnet_info({"authorUrl": "https://commons.wikimedia.org/wiki/User:Ann"})["page"], "https://commons.wikimedia.org/wiki/User:Ann")
        for odd in (None, [], "x", {"authorName": 5}):
            self.assertEqual(photos.birdnet_info(odd), {"source": "BirdNET-Go", "credit": "", "licence": "", "page": ""})

    async def test_nothing_is_known_when_birdnet_go_cannot_say_or_no_source_has_a_picture(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(200, {}), FakeResponse(500))
        service = self.service()
        await service.async_resolve("Carolina Wren")  # BirdNET-Go has it ...
        self.assertIsNone(await service.async_info("Carolina Wren"), "... but cannot tell who took it just now")
        self.assertIsNone(await service.async_info(""))


class PureTests(unittest.TestCase):
    def test_a_wikipedia_image_is_chosen_at_a_width_that_suits_the_panel(self) -> None:
        self.assertEqual(photos.wikipedia_image(summary()), WREN_960, "a big original: a 960 px copy of its thumbnail")
        small = summary(originalimage={"source": ORIGINAL, "width": 800, "height": 600})
        self.assertEqual(photos.wikipedia_image(small), "https://upload.wikimedia.org/wikipedia/commons/d/d3/Carolina_wren_%2814391%29.jpg", "a small original as it is, without the tracking query")
        chipmunk = "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Chipmunk_%2805980%29.jpg/3840px-Chipmunk_%2805980%29.jpg?utm_source=x"
        thumb_original = summary(originalimage={"source": chipmunk, "width": 3854}, thumbnail={"source": chipmunk.replace("3840px", "330px")})
        self.assertEqual(photos.wikipedia_image(thumb_original), "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Chipmunk_%2805980%29.jpg/960px-Chipmunk_%2805980%29.jpg")
        vector = summary(originalimage={"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Map.svg", "width": 500}, thumbnail={"source": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Map.svg/330px-Map.svg.png"})
        self.assertTrue(photos.wikipedia_image(vector).endswith("Map.svg.png"), "an image a browser cannot show is replaced by its picture")
        for none in (summary(thumbnail=None, originalimage=None), summary(thumbnail={"source": "http://upload.wikimedia.org/x.jpg"}, originalimage=None), {}):
            self.assertIsNone(photos.wikipedia_image(none))

    def test_the_wiki_and_file_name_are_read_from_a_wikimedia_address(self) -> None:
        self.assertEqual(photos.commons_file(ORIGINAL), ("commons", "Carolina wren (14391).jpg"))
        self.assertEqual(photos.commons_file(THUMB), ("commons", "Carolina wren (14391).jpg"))
        self.assertEqual(photos.commons_file("https://upload.wikimedia.org/wikipedia/en/a/ab/Local_file.png"), ("en", "Local file.png"))
        for bad in ("https://upload.wikimedia.org/x.jpg", "https://example.test/", ""):
            self.assertIsNone(photos.commons_file(bad))

    def test_only_the_sources_own_https_hosts_are_fetched(self) -> None:
        self.assertTrue(photos.image_url_ok("wikipedia", WREN_960))
        self.assertTrue(photos.image_url_ok("inaturalist", "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpg"))
        for source, url in (
            ("wikipedia", "http://upload.wikimedia.org/a.jpg"), ("wikipedia", "https://upload.wikimedia.org.evil.example/a.jpg"),
            ("wikipedia", "https://user@upload.wikimedia.org/a.jpg"), ("wikipedia", "https://upload.wikimedia.org:8443/a.jpg"),
            ("inaturalist", "https://upload.wikimedia.org/a.jpg"), ("birdnet-go", "https://static.inaturalist.org/a.jpg"), ("nobody", "https://x"),
        ):
            self.assertFalse(photos.image_url_ok(source, url), (source, url))


# ---- the links and the media route -----------------------------------------------------------------------------------


class RouteTests(PhotoTestCase):
    def view(self) -> object:
        return media_module.KestrelMediaView(self.hass)

    def request(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(headers={})

    async def test_birdnet_gos_picture_is_streamed_and_kept_for_a_long_time(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(200, {}))
        self.session.route("GET", BN_IMAGE, FakeResponse(200, body=JPEG, headers={"Content-Type": "image/jpeg"}))
        self.service()
        response = await self.view().get(self.request(), "species_ref", "Carolina Wren")
        self.assertEqual((response.status, response.body, response.headers["Cache-Control"]), (200, JPEG, "public, max-age=2592000"))

    async def test_a_picture_birdnet_go_turns_out_not_to_have_is_no_content_so_the_browser_logs_no_failed_request(self) -> None:
        self.session.route("GET", BN_INFO, FakeResponse(200, {}))
        self.service()
        for upstream in (404, 202, 503):
            self.session.route("GET", BN_IMAGE, FakeResponse(upstream))
            response = await self.view().get(self.request(), "species_ref", "Carolina Wren")
            self.assertEqual((response.status, response.headers["Cache-Control"]), (204, "private, max-age=300"), upstream)
        self.session.route("GET", BN_IMAGE, FakeResponse(500))
        self.assertEqual((await self.view().get(self.request(), "species_ref", "Carolina Wren")).status, 502, "a real failure stays an error")

    async def test_a_fallback_picture_is_served_from_its_file_and_nothing_found_or_nobody_to_ask_is_no_content(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        service = self.service()
        entry = await service.async_resolve("Carolina Wren")
        self.session.route("GET", entry.photo.image, picture())
        response = await self.view().get(self.request(), "species_ref", "Carolina Wren")
        self.assertEqual((response.status, Path(response.path).read_bytes()), (200, JPEG))
        self.assertEqual(response.headers, {"Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000"})

        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        self.session.route("GET", wiki("Unicorn"), FakeResponse(404))
        nothing = await self.view().get(self.request(), "species_ref", "Unicorn")
        self.assertEqual((nothing.status, nothing.headers["Cache-Control"]), (204, "private, max-age=300"))
        del self.hass.data[DOMAIN]["reference_photos"]
        self.assertEqual((await self.view().get(self.request(), "species_ref", "Carolina Wren")).status, 204)

    async def test_who_took_the_picture_is_json_or_no_content(self) -> None:
        self.route_taxon(SCIENTIFIC, "Carolina Wren", inat_photo())
        self.route_inat_files()
        self.service()
        response = await self.view().get(self.request(), "species_ref_info", "Carolina Wren")
        self.assertEqual((response.status, response.headers["Content-Type"]), (200, "application/json"))
        self.assertEqual(json_of(response), {"source": "iNaturalist", "credit": "Jake Scott", "licence": "All rights reserved", "page": "https://www.inaturalist.org/photos/428809700"})
        self.assertEqual((await self.view().get(self.request(), "species_ref_info", "   ")).status, 204)

    async def test_other_media_that_is_missing_is_still_an_error(self) -> None:
        """Only a reference picture is optional decoration: a recording that was never saved is a 404 (the panel's player says so)."""
        self.session.route("GET", f"{BIRDNET}/api/v2/audio/12", FakeResponse(404))
        self.assertEqual((await self.view().get(self.request(), "birdnet_audio", "12")).status, 404)

    async def test_a_species_without_its_own_photo_is_offered_a_picture_link_named_by_the_species_unless_no_source_has_one(self) -> None:
        service = self.service()
        sign = lambda payload: websocket_module._sign_media_paths(self.hass, payload, "token-1")  # noqa: E731
        offered = sign({"species": "Spring Peeper", "hasPhoto": False})
        self.assertEqual(offered["referenceImage"], "/api/kestrel/media/species_ref/Spring%20Peeper?authSig=FAKE")
        self.assertEqual(offered["referenceImageInfoUrl"], "/api/kestrel/media/species_ref_info/Spring%20Peeper?authSig=FAKE")
        self.assertNotIn("referenceImage", sign({"species": "Spring Peeper", "hasPhoto": True}))
        self.assertEqual(sign({"species": "Cooper's Hawk", "hasPhoto": False})["referenceImage"], "/api/kestrel/media/species_ref/Cooper%27s%20Hawk?authSig=FAKE")

        self.hass.data[DOMAIN]["birdnet_species_map"] = {}
        self.session.route("GET", TAXA, FakeResponse(200, {"results": []}))
        self.session.route("GET", wiki("Spring_Peeper"), FakeResponse(404))
        await service.async_resolve("Spring Peeper")
        self.assertNotIn("referenceImage", sign({"species": "Spring Peeper", "hasPhoto": False}))
        self.assertNotIn("referenceImageInfoUrl", sign({"species": "Spring Peeper", "hasPhoto": False}))
        del self.hass.data[DOMAIN]["reference_photos"]
        self.assertNotIn("referenceImage", sign({"species": "Wood Frog", "hasPhoto": False}))


def json_of(response: object) -> object:
    import json

    return json.loads(response.text)


if __name__ == "__main__":
    unittest.main()
