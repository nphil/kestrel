"""How long BirdNET-Go keeps its recordings: read how it is set and how full the folder is, change it, and keep the folder from overflowing.

Runs the real recording_retention.py and websocket_api.py against a fake BirdNET-Go with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import copy
import importlib
import re
import types
import unittest

import voluptuous as vol
from ha_stubs import NOTIFICATIONS, SESSION, FakeResponse, FakeSession, HomeAssistant, const_module, websocket_module

retention_module = importlib.import_module("kestrel_pkg.recording_retention")
API = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2"
TOKEN = "tok3n-AbCdEfGh12345678=="
GB = 1_000_000_000


def merged(stored: dict, sent: dict) -> dict:
    """What BirdNET-Go keeps after a settings write: the stored settings with everything the body names replaced."""
    result = copy.deepcopy(stored)
    for key, value in sent.items():
        result[key] = merged(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
    return result


class FakeBirdNetGo(FakeSession):
    """BirdNET-Go's audio settings, detections list and disk list, with its real quirks: a settings write needs the security
    token in a header AND a cookie, is merged into what is stored (a body keeps everything it does not name) and is checked the way
    BirdNET-Go checks it; the disk list is closed to anyone it does not know."""

    def __init__(self, *, policy: str = "age", max_age: str = "30d", max_usage: str = "80%", path: str = "/media/BirdCalls/") -> None:
        super().__init__()
        self.audio = {
            "ffmpegPath": "/usr/bin/ffmpeg",
            "sources": [{"name": "Front Door Camera", "device": "rtsp://user:secret@192.168.1.69/stream"}],
            "export": {
                "enabled": True,
                "path": path,
                "type": "opus",
                "bitrate": "64k",
                "length": 15,
                "retention": {
                    "debug": False,
                    "policy": policy,
                    "maxAge": max_age,
                    "maxUsage": max_usage,
                    "minClips": 10,
                    "keepSpectrograms": True,
                    "checkInterval": 15,
                },
            },
        }
        self.locked: int | None = 0  # None: the detections list does not answer
        self.disks: list[dict] | None = None
        self.refuse_writes = False
        self.ignore_writes = False

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        if (method, url) == ("GET", f"{API}/app/config"):
            return FakeResponse(200, {"csrfToken": TOKEN})
        if (method, url) == ("GET", f"{API}/settings/audio"):
            return FakeResponse(200, copy.deepcopy(self.audio))
        if (method, url) == ("PATCH", f"{API}/settings/audio"):
            headers = kwargs["headers"]
            if self.refuse_writes or headers.get("X-CSRF-Token") != TOKEN or headers.get("Cookie") != f"csrf={TOKEN}":
                return FakeResponse(403, {"error": "forbidden"})
            after = merged(self.audio, kwargs["json"])
            if not self._valid(after["export"]["retention"]):
                return FakeResponse(400, {"error": "validation failed"})
            if not self.ignore_writes:
                self.audio = after
            return FakeResponse(200, {"message": "Settings updated successfully"})
        if (method, url) == ("GET", f"{API}/detections?numResults=1&locked=true"):
            if self.locked is None:
                raise TimeoutError()
            return FakeResponse(200, {"data": [], "total": self.locked, "numResults": 1})
        if (method, url) == ("GET", f"{API}/system/disks"):
            if self.disks is None:
                return FakeResponse(401, {"error": "Authentication required"})
            return FakeResponse(200, self.disks)
        return FakeResponse(404, {"error": "not_found"})

    @staticmethod
    def _valid(retention: dict) -> bool:
        """BirdNET-Go's own rules: a known policy; a positive age when going by age; a percentage when going by space."""
        policy = retention["policy"]
        if policy not in ("none", "age", "usage") or retention["minClips"] < 0:
            return False
        if policy == "age" and not re.fullmatch(r"[1-9]\d*[hdwmy]?", retention["maxAge"]):
            return False
        return policy != "usage" or bool(re.fullmatch(r"\d+(\.\d+)?%?", retention["maxUsage"]))

    def retention(self) -> dict:
        return self.audio["export"]["retention"]

    def writes(self) -> list[dict]:
        return self.calls_to("PATCH", f"{API}/settings/audio")


class FakeConnection:
    refresh_token_id = "token-1"

    def __init__(self, *, admin: bool = True) -> None:
        self.user = types.SimpleNamespace(is_admin=admin)
        self.results: list[tuple[int, dict]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: dict) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class RecordingRetentionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.birdnet = FakeBirdNetGo()
        SESSION["session"] = self.birdnet
        self.hass = HomeAssistant()
        NOTIFICATIONS.clear()
        # Home Assistant sees the share as a 30 GB folder with 4.2 GB in it.
        self.share: tuple[int, int] | None = (4_200_000_000, 30 * GB)
        self.real_statvfs = retention_module._statvfs
        retention_module._statvfs = lambda path: self.share

    def tearDown(self) -> None:
        retention_module._statvfs = self.real_statvfs

    async def read(self, *, admin: bool = True) -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await websocket_module.ws_recording_retention_get(
            self.hass, connection, {"id": 4, "type": "kestrel/recording_retention/get"}
        )
        return connection

    async def set_keep(self, keep: object, *, admin: bool = True) -> FakeConnection:
        connection = FakeConnection(admin=admin)
        await websocket_module.ws_recording_retention_set(
            self.hass, connection, {"id": 5, "type": "kestrel/recording_retention/set", "keep": keep}
        )
        return connection

    # --- reading ---------------------------------------------------------------------------------------------------

    async def test_reading_says_how_recordings_are_kept_how_full_their_folder_is_and_how_many_are_kept(self) -> None:
        self.birdnet.locked = 12
        connection = await self.read()
        self.assertEqual(connection.errors, [])
        (_, result), = connection.results
        self.assertEqual(
            result,
            {
                "keep": "30",
                "days": 30,
                "spacePercent": 85,
                "guardPercent": 90,
                "storage": {"usedBytes": 4_200_000_000, "totalBytes": 30 * GB},
                "kept": 12,
                "minClips": 10,
                "checkMinutes": 15,
                "canChange": True,
            },
        )

    async def test_the_choice_is_read_from_the_policy_behind_it(self) -> None:
        # (policy, maxAge, maxUsage) -> (choice, days BirdNET-Go goes by or would, percent at which "until space runs low" starts removing)
        cases = [
            (("age", "30d", "80%"), ("30", 30, 85)),
            (("age", "60d", "80%"), ("60", 60, 85)),
            (("age", "90d", "80%"), ("90", 90, 85)),
            (("age", "720h", "80%"), ("30", 30, 85)),  # BirdNET-Go counts a bare number as hours
            (("age", "1m", "80%"), ("30", 30, 85)),  # and a month as 30 days
            (("age", "2w", "80%"), ("other", 14, 85)),
            (("age", "45d", "80%"), ("other", 45, 85)),
            (("age", "36h", "80%"), ("other", None, 85)),  # not a whole number of days
            (("age", "soon", "80%"), ("other", None, 85)),
            (("usage", "30d", "80%"), ("space", 30, 80)),
            (("usage", "90d", "0.9"), ("space", 90, 90)),  # the age stays as it was, and a bare 0.9 is 90% as BirdNET-Go reads it
            (("usage", "30d", "nonsense"), ("space", 30, 85)),
            (("none", "60d", "80%"), ("off", 60, 85)),
            (("", "30d", "80%"), ("off", 30, 85)),
            (("mystery", "30d", "80%"), ("other", 30, 85)),
        ]
        for (policy, max_age, max_usage), (keep, days, percent) in cases:
            retention = self.birdnet.retention()
            retention.update(policy=policy, maxAge=max_age, maxUsage=max_usage)
            (_, result), = (await self.read()).results
            self.assertEqual((result["keep"], result["days"], result["spacePercent"]), (keep, days, percent), (policy, max_age, max_usage))

    async def test_anyone_may_look_but_a_non_admin_is_told_they_cannot_change_it(self) -> None:
        connection = await self.read(admin=False)
        self.assertFalse(connection.results[0][1]["canChange"])

    async def test_the_space_is_read_from_the_folder_itself_and_birdnet_go_is_not_asked(self) -> None:
        await self.read()
        self.assertEqual(self.birdnet.calls_to("GET", f"{API}/system/disks"), [])

    async def test_when_the_folder_cannot_be_read_the_space_is_what_birdnet_go_reports_for_it(self) -> None:
        self.share = None
        self.birdnet.disks = [
            {"mountpoint": "/", "total": 100 * GB, "used": 60 * GB},
            {"mountpoint": "/media", "total": 200 * GB, "used": 150 * GB},
            {"mountpoint": "/media/BirdCalls", "total": 30 * GB, "used": 5 * GB},
            {"mountpoint": "/media/BirdCalls2", "total": 10 * GB, "used": 9 * GB},  # a different folder with a similar name
            {"mountpoint": "/data", "total": 1 * GB, "used": 0},
        ]
        (_, result), = (await self.read()).results
        self.assertEqual(result["storage"], {"usedBytes": 5 * GB, "totalBytes": 30 * GB})

    async def test_a_folder_inside_a_bigger_disk_is_measured_by_that_disk(self) -> None:
        self.share = None
        self.birdnet.disks = [{"mountpoint": "/", "total": 100 * GB, "used": 60 * GB}, {"mountpoint": "/media/", "total": 200 * GB, "used": 150 * GB}]
        (_, result), = (await self.read()).results
        self.assertEqual(result["storage"], {"usedBytes": 150 * GB, "totalBytes": 200 * GB})

    async def test_when_neither_can_say_how_full_it_is_the_rest_still_shows(self) -> None:
        self.share = None  # BirdNET-Go's disk list answers 401 to anyone it does not know
        connection = await self.read()
        self.assertEqual(connection.errors, [])
        (_, result), = connection.results
        self.assertIsNone(result["storage"])
        self.assertEqual(result["keep"], "30")

    async def test_a_folder_that_is_not_a_full_path_is_not_looked_up(self) -> None:
        self.birdnet.audio["export"]["path"] = "clips/"
        asked: list[str] = []
        retention_module._statvfs = lambda path: asked.append(path)
        (_, result), = (await self.read()).results
        self.assertIsNone(result["storage"])
        self.assertEqual(asked, [])
        self.assertEqual(self.birdnet.calls_to("GET", f"{API}/system/disks"), [])

    async def test_the_kept_count_is_unknown_not_zero_when_birdnet_go_does_not_answer(self) -> None:
        self.birdnet.locked = None
        (_, result), = (await self.read()).results
        self.assertIsNone(result["kept"])
        self.assertEqual(result["keep"], "30")

    async def test_an_unreachable_birdnet_go_is_an_error(self) -> None:
        down = FakeSession()
        down.route("GET", f"{API}/settings/audio", TimeoutError())
        SESSION["session"] = down
        connection = await self.read()
        self.assertEqual(connection.results, [])
        self.assertEqual([message for _, _, message in connection.errors], ["Could not reach BirdNET-Go"])

    async def test_an_answer_without_the_clean_up_settings_is_an_error(self) -> None:
        self.birdnet.audio["export"].pop("retention")
        connection = await self.read()
        self.assertEqual(connection.results, [])
        self.assertEqual(len(connection.errors), 1)

    def test_the_real_folder_check_gives_used_and_total_and_nothing_for_a_folder_that_is_not_there(self) -> None:
        used, total = self.real_statvfs("/tmp")
        self.assertTrue(0 <= used <= total and total > 0)
        self.assertIsNone(self.real_statvfs("/this/folder/is/not/here"))

    # --- changing --------------------------------------------------------------------------------------------------

    async def test_choosing_60_days_changes_only_the_policy_and_the_age(self) -> None:
        connection = await self.set_keep("60")
        self.assertEqual(connection.errors, [])
        (write,) = self.birdnet.writes()
        self.assertEqual(
            write["json"],
            {
                "export": {
                    "retention": {
                        "debug": False,
                        "policy": "age",
                        "maxAge": "60d",
                        "maxUsage": "80%",
                        "minClips": 10,
                        "keepSpectrograms": True,
                        "checkInterval": 15,
                    }
                }
            },
        )
        (_, result), = connection.results
        self.assertEqual((result["keep"], result["days"], result["canChange"]), ("60", 60, True))

    async def test_choosing_until_space_runs_low_sets_the_policy_and_the_limit_and_leaves_the_age(self) -> None:
        connection = await self.set_keep("space")
        self.assertEqual(connection.errors, [])
        self.assertEqual(
            self.birdnet.retention(),
            {
                "debug": False,
                "policy": "usage",
                "maxAge": "30d",
                "maxUsage": "85%",
                "minClips": 10,
                "keepSpectrograms": True,
                "checkInterval": 15,
            },
        )
        (_, result), = connection.results
        self.assertEqual((result["keep"], result["days"], result["spacePercent"]), ("space", 30, 85))

    async def test_each_choice_is_what_it_says_when_read_back(self) -> None:
        for keep in ("90", "space", "30", "60"):
            connection = await self.set_keep(keep)
            self.assertEqual(connection.errors, [], keep)
            self.assertEqual(connection.results[-1][1]["keep"], keep)
            self.assertEqual((await self.read()).results[0][1]["keep"], keep)

    async def test_nothing_else_in_the_audio_settings_changes(self) -> None:
        before = copy.deepcopy(self.birdnet.audio)
        await self.set_keep("90")
        after = copy.deepcopy(self.birdnet.audio)
        for settings in (before, after):
            settings["export"]["retention"].pop("maxAge")
        self.assertEqual(after, before)

    async def test_the_security_token_goes_in_both_the_header_and_the_cookie(self) -> None:
        await self.set_keep("60")
        (write,) = self.birdnet.writes()
        self.assertEqual(write["headers"]["X-CSRF-Token"], TOKEN)
        self.assertEqual(write["headers"]["Cookie"], f"csrf={TOKEN}")

    async def test_choosing_what_is_already_set_changes_nothing(self) -> None:
        for retention, keep in (({"policy": "age", "maxAge": "30d"}, "30"), ({"policy": "age", "maxAge": "720h"}, "30"), ({"policy": "usage", "maxUsage": "70%"}, "space")):
            self.birdnet.retention().update(retention)
            connection = await self.set_keep(keep)
            self.assertEqual(connection.errors, [], keep)
            self.assertEqual(connection.results[-1][1]["keep"], keep)
        self.assertEqual(self.birdnet.writes(), [])

    async def test_a_choice_that_is_not_one_of_the_four_is_refused_before_anything_is_sent(self) -> None:
        for bad in ("45", "7", "space ", "Space", "off", "other", "", 30, None, True, ["30"]):
            connection = await self.set_keep(bad)
            self.assertEqual(connection.results, [], bad)
            self.assertEqual([code for _, code, _ in connection.errors], ["invalid_format"], bad)
        self.assertEqual(self.birdnet.calls, [])

    def test_the_command_takes_one_of_the_four_choices(self) -> None:
        schema = websocket_module.ws_recording_retention_set.ws_schema
        for good in ("30", "60", "90", "space"):
            schema({"id": 1, "type": "kestrel/recording_retention/set", "keep": good})
        for bad in ({}, {"keep": 30}, {"keep": "45"}, {"keep": "off"}):
            with self.assertRaises(vol.Invalid):
                schema({"id": 1, "type": "kestrel/recording_retention/set", **bad})

    async def test_only_an_administrator_may_change_it(self) -> None:
        connection = await self.set_keep("60", admin=False)
        self.assertEqual([code for _, code, _ in connection.errors], ["unauthorized"])
        self.assertEqual(self.birdnet.calls, [])

    async def test_birdnet_go_refusing_the_write_is_an_error_not_a_pretend_success(self) -> None:
        self.birdnet.refuse_writes = True
        connection = await self.set_keep("60")
        self.assertEqual(connection.results, [])
        self.assertEqual(len(connection.errors), 1)
        self.assertEqual(self.birdnet.retention()["maxAge"], "30d")

    async def test_a_change_birdnet_go_accepts_but_does_not_keep_is_an_error_too(self) -> None:
        self.birdnet.ignore_writes = True
        connection = await self.set_keep("60")
        self.assertEqual(connection.results, [])
        self.assertEqual([message for _, _, message in connection.errors], ["BirdNET-Go did not keep the change"])

    async def test_a_time_limit_is_refused_while_the_folder_is_nearly_full_but_space_is_not(self) -> None:
        self.birdnet.retention().update(policy="usage")
        self.share = (27_500_000_000, 30 * GB)
        for keep in ("30", "60", "90"):
            connection = await self.set_keep(keep)
            self.assertEqual(connection.results, [], keep)
            (_, code, message), = connection.errors
            self.assertEqual(code, "invalid_format")
            self.assertIn("91% full", message)
        self.assertEqual(self.birdnet.writes(), [])
        self.birdnet.retention().update(policy="age", maxAge="30d")
        connection = await self.set_keep("space")
        self.assertEqual(connection.errors, [])
        self.assertEqual(self.birdnet.retention()["policy"], "usage")

    async def test_the_limit_is_exactly_ninety_percent(self) -> None:
        self.share = (27 * GB - 1, 30 * GB)
        self.assertEqual((await self.set_keep("60")).errors, [])
        self.share = (27 * GB, 30 * GB)
        self.assertEqual([code for _, code, _ in (await self.set_keep("90")).errors], ["invalid_format"])

    async def test_a_time_limit_can_be_chosen_when_the_space_is_not_known(self) -> None:
        self.share = None
        self.assertEqual((await self.set_keep("60")).errors, [])

    # --- the guard -------------------------------------------------------------------------------------------------

    async def test_the_guard_switches_a_time_limit_to_until_space_runs_low_when_the_folder_is_full_and_says_so(self) -> None:
        self.birdnet.retention().update(maxAge="90d")
        self.share = (28 * GB, 30 * GB)
        with self.assertLogs("kestrel_pkg.recording_retention", "WARNING") as logged:
            self.assertTrue(await retention_module.async_guard(self.hass))
        self.assertIn("93% full", logged.output[0])
        self.assertEqual(self.birdnet.retention()["policy"], "usage")
        self.assertEqual(self.birdnet.retention()["maxUsage"], "85%")
        self.assertEqual(self.birdnet.retention()["maxAge"], "90d")  # the age it was on is left for the next time
        (note,) = NOTIFICATIONS
        self.assertEqual(note["notification_id"], retention_module.GUARD_NOTIFICATION)
        self.assertIn("93% full", note["message"])
        self.assertIn("Recordings you keep are never removed", note["message"])

    async def test_the_guard_leaves_a_time_limit_alone_while_there_is_room(self) -> None:
        self.share = (26 * GB, 30 * GB)
        self.assertFalse(await retention_module.async_guard(self.hass))
        self.assertEqual(self.birdnet.writes(), [])
        self.assertEqual(NOTIFICATIONS, [])

    async def test_the_guard_has_nothing_to_do_when_recordings_already_go_by_space_or_nothing_is_removed(self) -> None:
        self.share = (29 * GB, 30 * GB)
        for policy in ("usage", "none"):
            self.birdnet.retention().update(policy=policy)
            self.assertFalse(await retention_module.async_guard(self.hass), policy)
        self.assertEqual(self.birdnet.writes(), [])
        self.assertEqual(NOTIFICATIONS, [])

    async def test_the_guard_does_nothing_when_it_cannot_tell_how_full_the_folder_is(self) -> None:
        self.share = None
        self.assertFalse(await retention_module.async_guard(self.hass))
        self.assertEqual(self.birdnet.writes(), [])

    async def test_the_guard_does_nothing_and_says_nothing_when_birdnet_go_is_away(self) -> None:
        down = FakeSession()
        down.route("GET", f"{API}/settings/audio", TimeoutError())
        SESSION["session"] = down
        self.share = (29 * GB, 30 * GB)
        self.assertFalse(await retention_module.async_guard(self.hass))
        self.assertEqual(NOTIFICATIONS, [])

    async def test_the_guard_does_not_claim_a_switch_birdnet_go_refused(self) -> None:
        self.share = (29 * GB, 30 * GB)
        self.birdnet.refuse_writes = True
        with self.assertLogs("kestrel_pkg.recording_retention", "WARNING"):
            self.assertFalse(await retention_module.async_guard(self.hass))
        self.assertEqual(NOTIFICATIONS, [])
        self.assertEqual(self.birdnet.retention()["policy"], "age")

    async def test_after_the_guard_has_switched_the_next_run_does_nothing_more(self) -> None:
        self.share = (29 * GB, 30 * GB)
        with self.assertLogs("kestrel_pkg.recording_retention", "WARNING"):
            self.assertTrue(await retention_module.async_guard(self.hass))
        self.assertFalse(await retention_module.async_guard(self.hass))
        self.assertEqual(len(self.birdnet.writes()), 1)
        self.assertEqual(len(NOTIFICATIONS), 1)

    # --- reading BirdNET-Go's own formats --------------------------------------------------------------------------

    def test_ages_are_read_the_way_birdnet_go_reads_them(self) -> None:
        for text, days in (("30d", 30), ("90d", 90), ("1w", 7), ("2m", 60), ("1y", 365), ("720", 30), ("48h", 2), (" 30d ", 30), ("0d", None), ("36h", None), ("30D", None), ("d", None), ("", None), (30, None), (None, None)):
            self.assertEqual(retention_module._days(text), days, text)

    def test_percentages_are_read_the_way_birdnet_go_reads_them(self) -> None:
        for text, percent in (("85%", 85), ("85", 85), (" 85 % ", 85), ("0.8", 80), ("100%", 100), ("85.4%", 85), ("0%", None), ("101%", None), ("-5%", None), ("lots", None), ("", None), (85, None), (None, None)):
            self.assertEqual(retention_module._percent(text), percent, text)
