"""Reference sounds ("Play reference"): where recordings come from, what is remembered, and what may be served.

Runs the real reference_sounds.py, websocket_api.py, media.py and diagnostics.py with Home Assistant, Xeno-canto and
iNaturalist faked (see ha_stubs.py). The Xeno-canto answers follow the payload its API v3 page documents:

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import voluptuous as vol

from ha_stubs import (
    DISK,
    FakeResponse,
    FakeSession,
    HomeAssistant,
    SESSION,
    const_module,
    diagnostics_module,
    media_module,
    new_coordinator,
    reference_module as ref,
    websocket_module,
)

import aiohttp  # the stub installed by ha_stubs

DOMAIN = const_module.DOMAIN
KEY = "xc-test-key-0123456789"
SCIENTIFIC = "Thryothorus ludovicianus"
XC = ref.XC_API
INAT_TAXA = f"{ref.INAT_API}/taxa"
INAT_OBSERVATIONS = f"{ref.INAT_API}/observations"
T0 = 1_800_000_000.0
DAY = 86400.0
MP3 = b"ID3\x04\x00\x00" + b"\x00" * 3000  # something that is big enough to be a recording


def xc_recording(number: int, **fields: object) -> dict:
    """One Xeno-canto recording, with the fields of the documented example."""
    return {
        "id": str(number), "gen": "Thryothorus", "sp": "ludovicianus", "ssp": "", "grp": "birds", "status": "identified",
        "en": "Carolina Wren", "rec": "Jane Doe", "cnt": "United States", "loc": "Atlanta", "type": "song", "sex": "male",
        "stage": "adult", "method": "field recording", "url": f"https://xeno-canto.org/{number}",
        "file": f"https://xeno-canto.org/{number}/download", "file-name": f"XC{number}.mp3",
        "sono": {"small": "", "med": "", "large": "", "full": ""}, "osci": {"small": "", "med": "", "large": ""},
        "lic": "https://creativecommons.org/licenses/by-nc-sa/4.0/", "q": "A", "length": "0:30", "playback-used": "no",
        "also": [], "rmk": "", **fields,
    }


def xc_answer(*recordings: dict, pages: object = 1) -> FakeResponse:
    return FakeResponse(200, {"numRecordings": str(len(recordings)), "numSpecies": "1", "page": 1, "numPages": pages, "recordings": list(recordings)})


def inat_taxon(taxon_id: int, name: str, common: str, rank: str = "species") -> dict:
    return {"id": taxon_id, "name": name, "rank": rank, "preferred_common_name": common, "matched_term": common}


def inat_url(sound_id: int, ext: str = "m4a") -> str:
    return f"https://static.inaturalist.org/sounds/{sound_id}.{ext}?1700000000"


def inat_observation(observation: int, sound_id: int, *, faves: int = 0, agrees: int = 0, ext: str = "m4a",
                     user: str = "Pat Birder", login: str = "pbirder", license_code: object = "cc-by-nc", **sound: object) -> dict:
    return {
        "id": observation, "faves_count": faves, "num_identification_agreements": agrees,
        "user": {"login": login, "name": user},
        "sounds": [{"id": sound_id, "file_url": inat_url(sound_id, ext), "file_content_type": "audio/mp4", "license_code": license_code,
                    "hidden": False, "flags": [], "moderator_actions": [], **sound}],
    }


def partial(total: int) -> FakeResponse:
    """What a file server says to "just the first byte, please"."""
    return FakeResponse(206, body=b"x", headers={"Content-Range": f"bytes 0-0/{total}"})


def audio(body: bytes = MP3, kind: str = "audio/mpeg", **headers: str) -> FakeResponse:
    return FakeResponse(200, body=body, headers={"Content-Type": kind, **headers})


class ReferenceTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.session = FakeSession()
        SESSION["session"] = self.session
        DISK.clear()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.hass = HomeAssistant()
        self.hass.config = types.SimpleNamespace(path=lambda *parts: os.path.join(self.folder.name, *parts))
        self.hass.data[DOMAIN] = {"birdnet_species_map": {}}
        self.clock = T0
        patcher = mock.patch.object(ref, "_now", lambda: self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.services: list[ref.ReferenceSounds] = []

    async def asyncTearDown(self) -> None:
        for service in self.services:
            await service.async_stop()

    def service(self, key: str | None = None) -> ref.ReferenceSounds:
        service = ref.ReferenceSounds(self.hass, key)
        self.services.append(service)
        self.hass.data[DOMAIN]["reference_sounds"] = service
        return service

    def route_inat(self, taxon: dict | None, observations: list[dict] | None = None, sizes: dict[int, int | None] | None = None) -> None:
        """iNaturalist knows `taxon` (or nobody) and has `observations`; `sizes` gives a sound's file size (None: gone)."""
        self.session.route("GET", INAT_TAXA, FakeResponse(200, {"results": [taxon] if taxon else []}))
        self.session.route("GET", INAT_OBSERVATIONS, FakeResponse(200, {"results": observations or []}))
        for observation in observations or []:
            for sound in observation["sounds"]:
                size = (sizes or {}).get(sound["id"], 300_000)
                self.session.route("GET", sound["file_url"], partial(size) if size else FakeResponse(404))

    def route_carolina_wren(self) -> None:
        self.route_inat(
            inat_taxon(7513, SCIENTIFIC, "Carolina Wren"),
            [inat_observation(1, 11, faves=2), inat_observation(2, 12, ext="mp3", license_code=None, user="", login="wrenfan")],
        )

    def network_calls(self) -> int:
        return len(self.session.calls)


# ---- Xeno-canto ------------------------------------------------------------------------------------------------------


class XenoCantoTests(ReferenceTestCase):
    async def clips(self, *answers: object) -> list[ref.Clip]:
        self.session.route("GET", XC, *answers)
        return await ref.xeno_canto_clips(self.session, KEY, SCIENTIFIC)

    async def test_the_best_song_and_the_best_call_are_offered_with_who_recorded_them(self) -> None:
        found = await self.clips(xc_answer(
            xc_recording(101),                                   # the best song
            xc_recording(102, q="B"),                            # same, worse quality
            xc_recording(105, length="0:08"),                    # same quality, but too short to be the ideal
            xc_recording(103, type="call", length="0:20"),       # the best call
            xc_recording(104, type="alarm call", length="0:20"), # a call, but not the plain word
            xc_recording(106, **{"playback-used": "yes"}),       # the same and newer, but the bird was lured by playback
        ))
        self.assertEqual([(c.id, c.kind, c.label) for c in found], [("xc-101", "song", "Song"), ("xc-103", "call", "Call")])
        song = found[0].public()
        self.assertEqual(
            (song["source"], song["sourceName"], song["credit"], song["licence"], song["quality"], song["seconds"], song["page"]),
            ("xeno-canto", "Xeno-canto", "Jane Doe", "CC BY-NC-SA 4.0", "A", 30, "https://xeno-canto.org/101"),
        )
        self.assertNotIn("audio", song, "where the bytes come from stays on the server")
        self.assertEqual(found[0].audio, "https://xeno-canto.org/101/download")

    async def test_a_recording_typed_both_song_and_call_is_never_offered_twice(self) -> None:
        found = await self.clips(xc_answer(xc_recording(1, type="call, song")))
        self.assertEqual([(c.id, c.label) for c in found], [("xc-1", "Song")])

    async def test_a_recording_of_no_known_kind_is_offered_plainly_when_nothing_better_exists(self) -> None:
        found = await self.clips(xc_answer(xc_recording(7, type="drumming"), xc_recording(8, type="")))
        self.assertEqual([(c.kind, c.label) for c in found], [("other", "Recording")])

    async def test_withheld_questioned_foreign_and_unplayable_recordings_are_left_out(self) -> None:
        found = await self.clips(xc_answer(
            xc_recording(1, file="", _meta={"redacted_fields": {"file": "restricted_species"}}),
            xc_recording(10, _meta={"redacted_fields": {"file": "restricted_species"}}),  # said to be withheld even if a link slipped through
            xc_recording(2, status="questioned"),
            xc_recording(3, gen="Troglodytes", sp="troglodytes"),
            xc_recording(4, length="0:03"),
            xc_recording(5, length="5:00"),
            xc_recording(6, file="https://evil.example/6/download"),
            xc_recording(7, file="http://xeno-canto.org/7/download"),
            xc_recording(8, length="not a length"),
            "not even a recording",
            xc_recording(9),
        ))
        self.assertEqual([c.id for c in found], ["xc-9"])

    async def test_when_the_best_pass_finds_nothing_a_wider_one_is_asked(self) -> None:
        found = await self.clips(xc_answer(), xc_answer(xc_recording(5, q="C", length="1:20")))
        self.assertEqual([(c.id, c.quality, c.seconds) for c in found], [("xc-5", "C", 80)])
        first, second = (call["params"]["query"] for call in self.session.calls_to("GET", XC))
        self.assertEqual(first, f'sp:"{SCIENTIFIC}" q:A len:10-60 playback:no')
        self.assertEqual(second, f'sp:"{SCIENTIFIC}" q:">D" len:5-90')

    async def test_a_full_page_with_no_call_is_asked_once_more_for_calls_and_a_complete_page_is_not(self) -> None:
        found = await self.clips(xc_answer(xc_recording(1), pages=3), xc_answer(xc_recording(2, type="call"), xc_recording(1)))
        self.assertEqual([c.id for c in found], ["xc-1", "xc-2"])
        queries = [call["params"]["query"] for call in self.session.calls_to("GET", XC)]
        self.assertEqual(len(queries), 2)
        self.assertTrue(queries[1].endswith(" type:call"), queries[1])

        self.session.calls.clear()
        found = await self.clips(xc_answer(xc_recording(1), pages="1"))  # all of it was returned: nothing more to find
        self.assertEqual([c.id for c in found], ["xc-1"])
        self.assertEqual(len(self.session.calls_to("GET", XC)), 1)

    async def test_the_key_travels_only_as_a_parameter_and_never_reaches_a_log_or_an_error(self) -> None:
        failures: list[object] = [FakeResponse(500), FakeResponse(400), FakeResponse(429), FakeResponse(200, ["not", "an", "answer"]),
                                  aiohttp.ClientError(f"cannot connect to https://xeno-canto.org/api/3/recordings?key={KEY}")]
        with self.assertLogs(ref.__name__, level="DEBUG") as logs:
            for failure in failures:
                self.session.route("GET", XC, failure)
                with self.assertRaises(ref.Unavailable) as raised:
                    await ref.xeno_canto_clips(self.session, KEY, SCIENTIFIC)
                self.assertNotIn(KEY, repr(raised.exception))
                self.assertIsNone(raised.exception.__cause__)
        self.assertNotIn(KEY, "\n".join(logs.output))
        for call in self.session.calls_to("GET", XC):
            self.assertEqual(call["params"]["key"], KEY)
            self.assertNotIn(KEY, call["params"]["query"])

    async def test_a_refused_key_is_told_apart_from_a_source_that_is_down(self) -> None:
        for status in (401, 403):
            self.session.route("GET", XC, FakeResponse(status, {"error": "client_error", "message": "Missing or invalid 'key' parameter."}))
            with self.assertRaises(ref.KeyRejected):
                await ref.xeno_canto_clips(self.session, KEY, SCIENTIFIC)

    async def test_only_a_genus_and_species_is_ever_put_into_a_query(self) -> None:
        for name in ('Foo" playback:yes', "Carolina", "thryothorus ludovicianus", "A b c d", ""):
            self.assertEqual(await ref.xeno_canto_clips(self.session, KEY, name), [], name)
        self.assertEqual(self.session.calls, [])
        self.session.route("GET", XC, xc_answer(xc_recording(1)))
        await ref.xeno_canto_clips(self.session, KEY, "Thryothorus ludovicianus ludovicianus")  # a subspecies is asked as its species
        self.assertTrue(self.session.calls_to("GET", XC)[0]["params"]["query"].startswith(f'sp:"{SCIENTIFIC}" '))


# ---- iNaturalist -----------------------------------------------------------------------------------------------------


class INaturalistTests(ReferenceTestCase):
    async def test_a_species_is_found_only_by_an_exact_name_never_a_near_one(self) -> None:
        self.session.route("GET", INAT_TAXA, FakeResponse(200, {"results": [
            inat_taxon(1, "Lobelia cardinalis", "cardinal flower"),
            inat_taxon(2, "Cardinalis cardinalis x sinuatus", "Northern Cardinal x Pyrrhuloxia", rank="hybrid"),
            inat_taxon(3, "Cardinalis", "Cardinals", rank="genus"),
            inat_taxon(4, "Cardinalis cardinalis", "Northern Cardinal"),
        ]}))
        self.assertEqual(await ref.inaturalist_taxon(self.session, "Northern Cardinal", None), ref.Taxon(4, "Cardinalis cardinalis"))
        self.assertEqual(await ref.inaturalist_taxon(self.session, "northern cardinal", None), ref.Taxon(4, "Cardinalis cardinalis"))
        self.assertIsNone(await ref.inaturalist_taxon(self.session, "Cardinal", None), "a part of a name is not the name")
        self.assertIsNone(await ref.inaturalist_taxon(self.session, "Cardinalis cardin", None))

    async def test_a_known_scientific_name_is_tried_first_and_the_common_name_when_it_matches_nothing(self) -> None:
        self.session.route(
            "GET", INAT_TAXA,
            FakeResponse(200, {"results": [inat_taxon(9, "Tyto alba", "Barn Owl")]}),
            FakeResponse(200, {"results": [inat_taxon(9, "Tyto alba", "Barn Owl")]}),
        )
        self.assertEqual(await ref.inaturalist_taxon(self.session, "Barn Owl", "Tyto furcata"), ref.Taxon(9, "Tyto alba"))
        self.assertEqual([call["params"]["q"] for call in self.session.calls_to("GET", INAT_TAXA)], ["Tyto furcata", "Barn Owl"])

    async def test_a_taxon_lookup_that_fails_is_unavailable_not_nobody(self) -> None:
        for answer in (FakeResponse(429), FakeResponse(503), FakeResponse(200, {"oops": 1}), aiohttp.ClientError("down")):
            self.session.route("GET", INAT_TAXA, answer)
            with self.assertRaises(ref.Unavailable):
                await ref.inaturalist_taxon(self.session, "Barn Owl", None)

    async def test_clips_are_the_best_liked_observations_each_of_a_size_worth_streaming(self) -> None:
        observations = [
            inat_observation(1, 10, agrees=2),                                   # score 2
            inat_observation(2, 20, faves=2, ext="mp3", user="", login="ann"),   # score 6: the best; credited by login
            inat_observation(3, 30, faves=1, ext="wav"),                         # 9 MB of wav: too long to stream
            inat_observation(4, 40, faves=1, hidden=True),
            inat_observation(5, 50, faves=1, flags=[{"flag": "spam"}]),
            {**inat_observation(6, 60, faves=1), "sounds": [{**inat_observation(6, 60)["sounds"][0], "file_url": "https://evil.example/60.m4a"}]},
            inat_observation(7, 70, faves=1, ext="mp3"),                          # 10 kB: too small to be a recording
            inat_observation(8, 80, license_code=None),                           # score 0, all rights reserved
            inat_observation(9, 90, ext="mp3"),                                   # score 0: the third
            inat_observation(10, 100),                                            # a fourth is never offered
        ]
        observations[1]["sounds"].append({**observations[1]["sounds"][0], "id": 21, "file_url": inat_url(21, "mp3")})  # one per observation
        self.route_inat(inat_taxon(1, SCIENTIFIC, "Carolina Wren"), observations, {30: 9_000_000, 70: 10_000})
        found = await ref.inaturalist_clips(self.session, ref.Taxon(1, SCIENTIFIC))
        self.assertEqual([(c.id, c.label) for c in found], [("inat-20", "Clip 1"), ("inat-10", "Clip 2"), ("inat-80", "Clip 3")])
        best = found[0].public()
        self.assertEqual((best["kind"], best["credit"], best["licence"], best["quality"], best["seconds"]), ("other", "ann", "CC BY-NC", None, None))
        self.assertEqual(best["page"], "https://www.inaturalist.org/observations/2")
        self.assertEqual(found[2].licence, "All rights reserved", "no licence means all rights reserved")
        self.assertEqual(found[0].audio, inat_url(20, "mp3"))
        params = self.session.calls_to("GET", INAT_OBSERVATIONS)[0]["params"]
        self.assertEqual((params["taxon_id"], params["sounds"], params["quality_grade"]), (1, "true", "research"))

    async def test_a_sound_that_is_gone_is_skipped_but_a_server_that_cannot_be_reached_is_unavailable(self) -> None:
        observations = [inat_observation(1, 10, faves=3), inat_observation(2, 20)]
        self.route_inat(inat_taxon(1, SCIENTIFIC, "Carolina Wren"), observations, {10: None})
        found = await ref.inaturalist_clips(self.session, ref.Taxon(1, SCIENTIFIC))
        self.assertEqual([(c.id, c.label) for c in found], [("inat-20", "Recording")], "a lone clip is just the recording")
        self.session.route("GET", inat_url(10), aiohttp.ClientError("reset"))
        with self.assertRaises(ref.Unavailable):
            await ref.inaturalist_clips(self.session, ref.Taxon(1, SCIENTIFIC))

    async def test_the_size_is_read_from_the_range_answer_or_from_the_length_when_ranges_are_ignored(self) -> None:
        self.route_inat(inat_taxon(1, SCIENTIFIC, "Carolina Wren"), [inat_observation(1, 10)])
        self.session.route("GET", inat_url(10), FakeResponse(200, body=b"x", headers={"Content-Length": "250000"}))
        self.assertEqual([c.id for c in await ref.inaturalist_clips(self.session, ref.Taxon(1, SCIENTIFIC))], ["inat-10"])
        for unusable in (FakeResponse(200, body=b"x"), FakeResponse(206, body=b"x", headers={"Content-Range": "bytes 0-0/*"}), FakeResponse(403)):
            self.session.route("GET", inat_url(10), unusable)
            self.assertEqual(await ref.inaturalist_clips(self.session, ref.Taxon(1, SCIENTIFIC)), [])


class NamesTests(unittest.TestCase):
    def test_licences_are_named_the_way_a_listener_expects(self) -> None:
        for given, expected in {
            "https://creativecommons.org/licenses/by-nc-sa/4.0/": "CC BY-NC-SA 4.0", "//creativecommons.org/licenses/by/3.0/": "CC BY 3.0",
            "cc-by-nc": "CC BY-NC", "cc-by-nc-nd": "CC BY-NC-ND", "cc0": "CC0",
            "https://creativecommons.org/publicdomain/zero/1.0/": "CC0", None: "", "": "", "all rights": "", 5: "",
        }.items():
            self.assertEqual(ref.licence_name(given), expected, given)

    def test_a_length_is_read_from_minutes_and_seconds_only(self) -> None:
        for given, expected in {"4:08": 248, "0:43": 43, "1:02:10": 3730, "0:00": None, "43": None, "a:b": None, "": None, None: None, "1:2:3:4": None}.items():
            self.assertEqual(ref.parse_length(given), expected, given)

    def test_a_species_name_is_tidied_and_one_that_is_not_a_name_is_nothing(self) -> None:
        self.assertEqual(ref.clean_name("  Cooper\u2019s   Hawk "), "Cooper's Hawk")
        self.assertEqual(ref.clean_name("Spring\tPeeper\n"), "Spring Peeper")
        for bad in ("", "   ", "x" * 101, None, 5, "\x00\x01"):
            self.assertEqual(ref.clean_name(bad), "", bad)


# ---- finding, remembering and not asking twice -----------------------------------------------------------------------


class LookupTests(ReferenceTestCase):
    async def test_a_species_is_looked_up_once_and_after_a_restart_answered_from_what_was_kept(self) -> None:
        self.route_carolina_wren()
        first = await self.service().async_lookup("Carolina Wren")
        self.assertEqual((first["state"], first["scientific"]), ("ready", SCIENTIFIC))
        self.assertEqual([c["id"] for c in first["clips"]], ["inat-11", "inat-12"])
        asked = self.network_calls()

        self.assertEqual(await self.services[0].async_lookup("carolina  WREN"), {**first, "species": "carolina WREN"})
        await self.services[0].async_stop()
        again = self.service()
        await again.async_load()
        self.assertEqual((await again.async_lookup("Carolina Wren"))["clips"], first["clips"])
        self.assertEqual(self.network_calls(), asked, "nothing was asked a second time, not even after a restart")

    async def test_what_was_found_is_asked_again_after_45_days_and_nothing_found_after_a_week(self) -> None:
        service = self.service()
        self.route_carolina_wren()
        await service.async_lookup("Carolina Wren")
        self.route_inat(None)
        await service.async_lookup("Unicorn")
        asked = self.network_calls()

        self.clock = T0 + 6 * DAY
        await service.async_lookup("Carolina Wren")
        await service.async_lookup("Unicorn")
        self.assertEqual(self.network_calls(), asked, "both are still remembered after 6 days")

        self.clock = T0 + 8 * DAY
        self.assertEqual((await service.async_lookup("Unicorn"))["state"], "none")
        unicorn_calls = self.network_calls() - asked
        self.assertGreater(unicorn_calls, 0, "an empty answer is asked again after a week")
        await service.async_lookup("Carolina Wren")
        self.assertEqual(self.network_calls() - asked, unicorn_calls, "a found answer is still good after 8 days")

        self.clock = T0 + 46 * DAY
        before = self.network_calls()
        await service.async_lookup("Carolina Wren")
        self.assertGreater(self.network_calls(), before, "a found answer is asked again after 45 days")

    async def test_a_species_nobody_knows_is_remembered_as_having_no_recording(self) -> None:
        self.route_inat(None)
        service = self.service()
        result = await service.async_lookup("Mystery Warbler")
        self.assertEqual(result, {"species": "Mystery Warbler", "scientific": None, "state": "none", "clips": []})
        asked = self.network_calls()
        await service.async_lookup("mystery warbler")
        self.assertEqual(self.network_calls(), asked)
        await service.async_stop()
        self.assertIn("mystery warbler", DISK["kestrel.reference_sounds"]["entries"])

    async def test_a_known_species_with_no_sound_is_also_a_remembered_none(self) -> None:
        self.route_inat(inat_taxon(1, SCIENTIFIC, "Carolina Wren"), [inat_observation(1, 10)], {10: None})
        result = await self.service().async_lookup("Carolina Wren")
        self.assertEqual((result["state"], result["scientific"], result["clips"]), ("none", SCIENTIFIC, []))

    async def test_a_source_that_cannot_be_asked_is_not_remembered_and_is_not_hammered(self) -> None:
        service = self.service()
        self.session.route("GET", INAT_TAXA, aiohttp.ClientError("offline"))
        self.assertEqual((await service.async_lookup("Carolina Wren"))["state"], "unavailable")
        asked = self.network_calls()

        self.route_carolina_wren()
        self.clock += 30
        self.assertEqual((await service.async_lookup("Carolina Wren"))["state"], "unavailable", "still pausing")
        self.assertEqual(self.network_calls(), asked, "no request while it pauses")

        self.clock += 40
        self.assertEqual((await service.async_lookup("Carolina Wren"))["state"], "ready", "tried again, and it works now")
        await service.async_stop()
        self.assertEqual(list(DISK["kestrel.reference_sounds"]["entries"]), ["carolina wren"], "the failure was never written down")

    async def test_a_lookup_that_runs_out_of_time_is_unavailable_too(self) -> None:
        async def never(name: str) -> object:
            await asyncio.Event().wait()

        service = self.service()
        with mock.patch.object(service, "_find", never), mock.patch.object(ref, "LOOKUP_TIMEOUT_S", 0.01):
            self.assertEqual((await service.async_lookup("Carolina Wren"))["state"], "unavailable")

    async def test_two_requests_at_once_share_one_lookup(self) -> None:
        self.route_carolina_wren()
        service = self.service()
        first, second = await asyncio.gather(service.async_lookup("Carolina Wren"), service.async_lookup("Carolina Wren"))
        self.assertEqual(first, second)
        self.assertEqual(len(self.session.calls_to("GET", INAT_TAXA)), 1)
        self.assertEqual(len(self.session.calls_to("GET", INAT_OBSERVATIONS)), 1)

    async def test_the_scientific_name_birdnet_knows_is_what_is_asked_for_first(self) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {"carolina wren": SCIENTIFIC}
        self.route_carolina_wren()
        await self.service().async_lookup("Carolina Wren")
        self.assertEqual(self.session.calls_to("GET", INAT_TAXA)[0]["params"]["q"], SCIENTIFIC)

    async def test_what_is_kept_is_bounded_and_damaged_or_foreign_entries_are_ignored(self) -> None:
        service = self.service()
        self.route_inat(None)
        with mock.patch.object(ref, "MAX_ENTRIES", 3):
            for number in range(5):
                self.clock += 1
                await service.async_lookup(f"Species {number}")
            self.assertEqual(sorted(service._entries), ["species 2", "species 3", "species 4"], "the oldest go first")

        good = ref.Clip(id="xc-5", kind="song", label="Song", source="xeno-canto", credit="Jane", licence="CC0", quality="A", seconds=30,
                        page="https://xeno-canto.org/5", audio="https://xeno-canto.org/5/download", ext="mp3")
        entry = {"name": "Good Bird", "scientific": None, "checked": T0, "xc": True, "clips": [good.to_json()]}
        DISK["kestrel.reference_sounds"] = {"entries": {
            "good bird": entry,
            "wrong key": entry,
            "bad host": {**entry, "name": "Bad Host", "clips": [{**good.to_json(), "audio": "https://evil.example/5/download"}]},
            "bad id": {**entry, "name": "Bad Id", "clips": [{**good.to_json(), "id": "xc-../../x"}]},
            "bad kind": {**entry, "name": "Bad Kind", "clips": [{**good.to_json(), "kind": "scream"}]},
            "no clips list": {**entry, "name": "No Clips", "clips": "many"},
            "not a dict": "oops",
        }}
        fresh = self.service()
        await fresh.async_load()
        self.assertEqual(sorted(fresh._entries), ["good bird"])


class XenoCantoFirstTests(ReferenceTestCase):
    def route_xeno_canto(self, *answers: object) -> None:
        self.hass.data[DOMAIN]["birdnet_species_map"] = {"carolina wren": SCIENTIFIC}
        self.session.route("GET", XC, *answers)

    async def test_with_a_key_its_songs_and_calls_come_first_and_iNaturalist_is_not_asked(self) -> None:
        self.route_xeno_canto(xc_answer(xc_recording(101), xc_recording(103, type="call", length="0:20")))
        result = await self.service(KEY).async_lookup("Carolina Wren")
        self.assertEqual((result["state"], result["scientific"]), ("ready", SCIENTIFIC))
        self.assertEqual([(c["id"], c["label"], c["sourceName"]) for c in result["clips"]], [("xc-101", "Song", "Xeno-canto"), ("xc-103", "Call", "Xeno-canto")])
        self.assertEqual(self.session.calls_to("GET", INAT_TAXA), [])
        self.assertEqual(self.session.calls_to("GET", INAT_OBSERVATIONS), [])

    async def test_without_a_known_scientific_name_iNaturalist_supplies_it_for_the_query(self) -> None:
        self.session.route("GET", INAT_TAXA, FakeResponse(200, {"results": [inat_taxon(7513, SCIENTIFIC, "Carolina Wren")]}))
        self.session.route("GET", XC, xc_answer(xc_recording(101)))
        result = await self.service(KEY).async_lookup("Carolina Wren")
        self.assertEqual([c["id"] for c in result["clips"]], ["xc-101"])
        self.assertEqual(len(self.session.calls_to("GET", INAT_TAXA)), 1)
        self.assertEqual(self.session.calls_to("GET", INAT_OBSERVATIONS), [])

    async def test_iNaturalist_fills_in_when_xeno_canto_has_nothing(self) -> None:
        self.route_xeno_canto(xc_answer())
        self.route_carolina_wren()
        result = await self.service(KEY).async_lookup("Carolina Wren")
        self.assertEqual([c["source"] for c in result["clips"]], ["inaturalist", "inaturalist"])

    async def test_a_refused_key_is_given_up_on_and_said_so_once_without_the_key(self) -> None:
        self.route_xeno_canto(FakeResponse(401, {"error": "client_error", "message": "Missing or invalid 'key' parameter."}))
        self.route_carolina_wren()
        service = self.service(KEY)
        with self.assertLogs(ref.__name__, level="DEBUG") as logs:
            first = await service.async_lookup("Carolina Wren")
            self.hass.data[DOMAIN]["birdnet_species_map"]["cardinal"] = "Cardinalis cardinalis"
            await service.async_lookup("Northern Cardinal")
        self.assertEqual(first["state"], "ready", "iNaturalist answered instead")
        self.assertEqual(len(self.session.calls_to("GET", XC)), 1, "the refused key is not tried again")
        warnings = [line for line in logs.output if line.startswith("WARNING")]
        self.assertEqual(len(warnings), 1)
        self.assertNotIn(KEY, "\n".join(logs.output))
        self.assertEqual(service.diagnostics()["xeno_canto"], "rejected")

    async def test_a_down_xeno_canto_is_skipped_for_a_few_minutes_not_waited_for_by_every_species(self) -> None:
        self.route_xeno_canto(FakeResponse(503))
        self.route_carolina_wren()
        service = self.service(KEY)
        self.assertEqual((await service.async_lookup("Carolina Wren"))["state"], "ready")
        self.assertEqual(len(self.session.calls_to("GET", XC)), 1)
        self.hass.data[DOMAIN]["birdnet_species_map"]["barred owl"] = "Strix varia"
        self.clock += 60
        await service.async_lookup("Barred Owl")
        self.assertEqual(len(self.session.calls_to("GET", XC)), 1, "not asked while it is down")
        self.clock += 300
        self.hass.data[DOMAIN]["birdnet_species_map"]["eastern towhee"] = "Pipilo erythrophthalmus"
        await service.async_lookup("Eastern Towhee")
        self.assertEqual(len(self.session.calls_to("GET", XC)), 2, "asked again after the pause")

    async def test_adding_a_key_later_replaces_an_earlier_iNaturalist_answer_after_an_hour_and_keeps_xeno_canto_ones(self) -> None:
        self.route_carolina_wren()
        before = self.service()
        self.assertEqual((await before.async_lookup("Carolina Wren"))["clips"][0]["source"], "inaturalist")
        await before.async_stop()

        self.route_xeno_canto(xc_answer(xc_recording(101)))
        with_key = self.service(KEY)
        await with_key.async_load()
        self.clock = T0 + 1800
        self.assertEqual((await with_key.async_lookup("Carolina Wren"))["clips"][0]["source"], "inaturalist", "made half an hour ago: kept for now")
        self.assertEqual(self.session.calls_to("GET", XC), [])
        self.clock = T0 + 3700
        self.assertEqual((await with_key.async_lookup("Carolina Wren"))["clips"][0]["id"], "xc-101", "an hour on: asked again, Xeno-canto first")
        await with_key.async_stop()

        self.clock = T0 + 3 * DAY
        without_key = self.service()
        await without_key.async_load()
        asked = self.network_calls()
        self.assertEqual((await without_key.async_lookup("Carolina Wren"))["clips"][0]["id"], "xc-101", "removing the key keeps what it found")
        self.assertEqual(self.network_calls(), asked)


# ---- the sound itself ------------------------------------------------------------------------------------------------


class AudioFileTests(ReferenceTestCase):
    async def lookup(self, key: str | None = None) -> tuple[ref.ReferenceSounds, str]:
        self.route_carolina_wren()
        service = self.service(key)
        result = await service.async_lookup("Carolina Wren")
        return service, result["clips"][0]["id"]

    async def test_the_first_play_fetches_the_sound_once_and_later_plays_come_from_disk(self) -> None:
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), audio(MP3, "audio/mp4"))
        first, second = await asyncio.gather(service.async_audio(clip_id), service.async_audio(clip_id))
        self.assertEqual(first, second)
        path, content_type = first
        self.assertEqual((path.name, content_type, path.read_bytes()), ("inat-11.m4a", "audio/mp4", MP3))
        self.assertEqual(path.parent, service.audio_dir)
        self.assertEqual(len(self.session.calls_to("GET", inat_url(11))) - 1, 1, "one fetch for two plays (and one size probe)")
        self.assertEqual(sorted(p.name for p in service.audio_dir.iterdir()), ["inat-11.m4a"], "no half-written file is left")
        self.session.calls.clear()
        self.assertEqual(await service.async_audio(clip_id), first)
        self.assertEqual(self.session.calls, [])

    async def test_a_page_a_huge_file_or_a_scrap_is_not_kept_as_a_recording(self) -> None:
        service, clip_id = await self.lookup()
        refused = {
            "a web page": audio(b"<html>" + b"x" * 3000, "text/html"),
            "a declared huge file": audio(MP3, "audio/mp4", **{"Content-Length": str(ref.MAX_AUDIO_BYTES + 1)}),
            "a huge file that says nothing about its size": audio(b"x" * (ref.MAX_AUDIO_BYTES + 10), "audio/mp4"),
            "a scrap": audio(b"ID3", "audio/mp4"),
            "an error page": FakeResponse(500),
        }
        for what, answer in refused.items():
            self.session.route("GET", inat_url(11), answer)
            self.assertIsNone(await service.async_audio(clip_id), what)
            self.assertFalse(service.audio_dir.exists() and any(service.audio_dir.iterdir()), what)
        self.assertIsNotNone(service.clip(clip_id), "a failed fetch does not make the answer forget the clip")

    async def test_a_full_or_unwritable_disk_means_no_sound_not_an_error(self) -> None:
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), audio(MP3, "audio/mp4"))
        with mock.patch.object(ref, "store_file", side_effect=OSError("No space left on device")), self.assertLogs(ref.__name__, "WARNING") as logs:
            self.assertIsNone(await service.async_audio(clip_id))
        self.assertNotIn("No space", "\n".join(logs.output), "the log says what kind of failure it was, not where")

    async def test_a_redirect_is_followed_only_within_the_sources_own_hosts(self) -> None:
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), FakeResponse(302, headers={"Location": "https://evil.example/steal.m4a"}))
        self.assertIsNone(await service.async_audio(clip_id))
        self.assertEqual(len(self.session.calls_to("GET", "https://evil.example/steal.m4a")), 0, "never fetched")
        elsewhere = "https://inaturalist-open-data.s3.amazonaws.com/sounds/11.m4a"
        self.session.route("GET", inat_url(11), FakeResponse(302, headers={"Location": elsewhere}))
        self.session.route("GET", elsewhere, audio(MP3, "audio/mp4"))
        found = await service.async_audio(clip_id)
        self.assertEqual(found[0].read_bytes(), MP3)

    async def test_a_recording_the_source_no_longer_has_makes_the_next_look_ask_again(self) -> None:
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), FakeResponse(404))
        self.assertIsNone(await service.async_audio(clip_id))
        self.assertIsNone(service.clip(clip_id), "the clip is no longer offered")
        asked = len(self.session.calls_to("GET", INAT_TAXA))
        await service.async_lookup("Carolina Wren")
        self.assertEqual(len(self.session.calls_to("GET", INAT_TAXA)), asked + 1)

    async def test_ids_that_are_not_clips_this_service_issued_never_reach_the_disk_or_the_network(self) -> None:
        service, clip_id = await self.lookup()
        self.session.calls.clear()
        for evil in ("../../etc/passwd", "inat-11/../../x", "inat-11.m4a", "INAT-11", "inat-", "inat-abc", "inat-\u0661\u0662", " inat-11",
                     "inat-11\n", "xc-11", "inat-99", "inat-" + "1" * 13, "", "inat-11\x00", None, 11, "https://evil.example/x"):
            self.assertIsNone(await service.async_audio(evil), repr(evil))
        self.assertEqual(self.session.calls, [])
        self.assertFalse(service.audio_dir.exists())

    async def test_the_folder_keeps_to_its_size_least_recently_played_first(self) -> None:
        folder = Path(self.folder.name)
        now = 1_000_000.0
        for name, age, size in (("old.mp3", 5000, 40), ("older.mp3", 9000, 40), ("newest.mp3", 700, 40), ("playing.mp3", 5, 40)):
            path = folder / name
            path.write_bytes(b"x" * size)
            os.utime(path, (now - age, now - age))
        for name, age in (("abandoned.mp3.part", 5000), ("downloading.mp3.part", 5)):
            path = folder / name
            path.write_bytes(b"x" * 10)
            os.utime(path, (now - age, now - age))
        ref.prune_files(folder, 100, now)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["downloading.mp3.part", "newest.mp3", "playing.mp3"])
        ref.prune_files(folder, 10, now)  # still over the cap: what was played moments ago stays, what is ten minutes old goes
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["downloading.mp3.part", "playing.mp3"])

    async def test_a_file_fetched_long_ago_but_played_just_now_is_not_the_one_to_go(self) -> None:
        folder = Path(self.folder.name)
        now = 1_000_000.0
        for name, fetched in (("favourite.mp3", 90_000), ("forgotten.mp3", 80_000)):
            path = folder / name
            path.write_bytes(b"x" * 40)
            os.utime(path, (now - fetched, now - fetched))
        ref.prune_files(folder, 50, now, {"favourite.mp3": now - 30})
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["favourite.mp3"])

    async def test_playing_a_clip_again_leaves_its_file_untouched_so_the_browser_can_keep_asking_for_pieces(self) -> None:
        """The file's time is its ETag and Last-Modified: change it on every play and a resumed Range request (If-Range) gets the whole file."""
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), audio(MP3, "audio/mp4"))
        path, _ = await service.async_audio(clip_id)
        os.utime(path, (T0 - 5000, T0 - 5000))
        before = path.stat().st_mtime_ns
        self.clock += 3600
        await service.async_audio(clip_id)
        self.assertEqual(path.stat().st_mtime_ns, before)
        self.assertEqual(service._played[path.name], self.clock, "but it is remembered as played")

    async def test_removing_the_entry_forgets_everything_on_disk_too(self) -> None:
        service, clip_id = await self.lookup()
        self.session.route("GET", inat_url(11), audio(MP3, "audio/mp4"))
        await service.async_audio(clip_id)
        await service.async_stop()
        await service.async_remove()
        self.assertFalse(service.audio_dir.exists())
        self.assertNotIn("kestrel.reference_sounds", DISK)


# ---- what the panel is told and what the media route serves ----------------------------------------------------------


class Connection:
    refresh_token_id = "token-1"

    def __init__(self) -> None:
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, identifier: int, result: object) -> None:
        self.results.append((identifier, result))

    def send_error(self, identifier: int, code: str, message: str) -> None:
        self.errors.append((identifier, code, message))


class WebsocketTests(ReferenceTestCase):
    def ask(self, species: str = "Carolina Wren") -> dict:
        return {"id": 5, "type": "kestrel/species/reference", "species": species}

    async def test_every_clip_gets_a_signed_link_and_the_sources_address_stays_on_the_server(self) -> None:
        self.route_carolina_wren()
        self.service()
        connection = Connection()
        await websocket_module.ws_species_reference(self.hass, connection, self.ask())
        [(identifier, result)] = connection.results
        self.assertEqual((identifier, result["state"], result["scientific"]), (5, "ready", SCIENTIFIC))
        self.assertEqual(
            [clip["url"] for clip in result["clips"]],
            ["/api/kestrel/media/species_sound/inat-11?authSig=FAKE", "/api/kestrel/media/species_sound/inat-12?authSig=FAKE"],
        )
        self.assertEqual(sorted(result["clips"][0]), sorted(
            ["id", "kind", "label", "source", "sourceName", "credit", "licence", "quality", "seconds", "page", "url"]))
        self.assertNotIn("static.inaturalist.org", json.dumps(result))
        json.dumps(result)  # and it is plain JSON

    async def test_a_lookup_that_cannot_be_done_still_answers_and_a_missing_service_is_an_error(self) -> None:
        self.session.route("GET", INAT_TAXA, aiohttp.ClientError("offline"))
        self.service()
        connection = Connection()
        await websocket_module.ws_species_reference(self.hass, connection, self.ask())
        self.assertEqual(connection.results[0][1], {"species": "Carolina Wren", "scientific": None, "state": "unavailable", "clips": []})

        del self.hass.data[DOMAIN]["reference_sounds"]
        connection = Connection()
        await websocket_module.ws_species_reference(self.hass, connection, self.ask())
        self.assertEqual(connection.errors, [(5, "not_ready", "Reference sounds are not set up")])

    async def test_a_bug_in_a_lookup_is_an_error_for_the_panel_not_a_crash(self) -> None:
        service = self.service()
        with mock.patch.object(service, "async_lookup", side_effect=RuntimeError("boom")), self.assertLogs(websocket_module.__name__, "ERROR"):
            connection = Connection()
            await websocket_module.ws_species_reference(self.hass, connection, self.ask())
        self.assertEqual(connection.errors, [(5, "unknown_error", "Kestrel request failed")])

    def test_the_species_must_be_a_name_of_a_sensible_length(self) -> None:
        schema = websocket_module.ws_species_reference.ws_schema
        self.assertEqual(schema(self.ask("x" * 100))["species"], "x" * 100)
        for bad in ("", "x" * 101, 5, None):
            with self.assertRaises(vol.Invalid, msg=repr(bad)):
                schema(self.ask(bad))


class MediaRouteTests(ReferenceTestCase):
    def view(self) -> object:
        return media_module.KestrelMediaView(self.hass)

    def request(self) -> types.SimpleNamespace:
        return types.SimpleNamespace(headers={})

    async def test_a_clip_the_service_issued_is_served_from_its_file_for_a_long_time(self) -> None:
        self.route_carolina_wren()
        service = self.service()
        await service.async_lookup("Carolina Wren")
        self.session.route("GET", inat_url(11), audio(MP3, "audio/mp4"))
        response = await self.view().get(self.request(), "species_sound", "inat-11")
        self.assertEqual(response.status, 200)
        self.assertEqual(Path(response.path), service.audio_dir / "inat-11.m4a")
        self.assertEqual(response.headers, {"Content-Type": "audio/mp4", "Cache-Control": "private, max-age=2592000"})
        self.assertEqual(Path(response.path).read_bytes(), MP3)

    async def test_anything_else_is_not_found_and_asks_nobody(self) -> None:
        self.route_carolina_wren()
        service = self.service()
        await service.async_lookup("Carolina Wren")
        self.session.calls.clear()
        for evil in ("../../etc/passwd", "inat-11/../../etc/passwd", "inat-99", "inat-11.m4a", "xc-11", "INAT-11", "inat-", "../inat-11",
                     "inat-11%2F..", "inat-11\x00", "birdnet_audio", "https://evil.example/x", "inat-" + "9" * 40):
            response = await self.view().get(self.request(), "species_sound", evil)
            self.assertEqual(response.status, 404, repr(evil))
        self.assertEqual(self.session.calls, [], "nothing was fetched for any of them")
        self.assertFalse(service.audio_dir.exists(), "and nothing was written")

    async def test_a_sound_that_cannot_be_had_and_a_missing_service_are_both_not_found(self) -> None:
        self.route_carolina_wren()
        service = self.service()
        await service.async_lookup("Carolina Wren")
        self.session.route("GET", inat_url(11), FakeResponse(503))
        self.assertEqual((await self.view().get(self.request(), "species_sound", "inat-11")).status, 404)
        del self.hass.data[DOMAIN]["reference_sounds"]
        self.assertEqual((await self.view().get(self.request(), "species_sound", "inat-11")).status, 404)

    async def test_only_the_signed_species_sound_kind_can_reach_the_service(self) -> None:
        self.assertIn("species_sound", const_module.MEDIA_KINDS)
        with self.assertRaises(Exception):
            websocket_module._signed_media_url(self.hass, "reference", "inat-11", "token")  # not a media kind


# ---- the key stays secret --------------------------------------------------------------------------------------------


class SecretTests(ReferenceTestCase):
    async def test_no_secret_option_appears_in_diagnostics(self) -> None:
        coordinator = new_coordinator([], self.hass)
        keys = {"api_key": "plugin-secret-1", "audio_key": "audio-secret-2", "xeno_canto_key": KEY}
        entry = types.SimpleNamespace(runtime_data=coordinator, as_dict=lambda: {"data": {"url": "http://x", "api_key": keys["api_key"]}, "options": dict(keys)})
        self.service(KEY)
        result = await diagnostics_module.async_get_config_entry_diagnostics(self.hass, entry)
        dumped = json.dumps(result)
        for secret in keys.values():
            self.assertNotIn(secret, dumped)
        self.assertEqual(result["reference_sounds"]["xeno_canto"], "key set")


if __name__ == "__main__":
    unittest.main()
