"""Which BirdNET-Go models heard a heard visit: the integration asks BirdNET-Go and tells the plugin ("Both models agreed").

Runs the real birdnet_models.py and birdnet_api.py against a fake BirdNET-Go (its detection endpoint, with the model list,
and its failures) and a fake plugin, with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import json
import time
import types
import unittest

from ha_stubs import (
    SESSION,
    FakeResponse,
    FakeSession,
    HomeAssistant,
    async_dispatcher_send,
    const_module,
    diagnostics_module,
    new_coordinator,
)

import aiohttp  # the stub ha_stubs installs

birdnet_models = importlib.import_module("kestrel_pkg.birdnet_models")
KestrelApiError = importlib.import_module("kestrel_pkg.client").KestrelApiError
API = f"{const_module.BIRDNET_GO_INTERNAL_URL}/api/v2"
DOMAIN = const_module.DOMAIN
JAY = "Cyanocitta cristata"


def both(detection_id: int = 360) -> dict:
    """A detection BirdNET-Go says both models heard (the shape of the 20261122 API; extra fields are not passed on)."""
    return {
        "id": detection_id,
        "scientificName": JAY,
        "modelContributions": [
            {"modelName": "BirdNET", "modelVersion": "3.0", "modelVariant": "default", "modelType": "multi", "hitCount": 3, "maxConfidence": 0.93, "minConfidence": 0.88, "meanConfidence": 0.91},
            {"modelName": "Perch", "modelVersion": "V2", "hitCount": 2, "maxConfidence": 0.71},
        ],
    }


def heard(visit_id: str = "h1", detection_id: object = 360, *, started: object = None, **extra: object) -> dict:
    return {
        "id": visit_id, "kind": "heard", "species": "Blue Jay", "status": "auto",
        "startedAt": int(time.time() * 1000) - 60_000 if started is None else started,
        "audio": {"birdnetDetectionId": detection_id}, **extra,
    }


def new(visit: dict) -> dict:
    return {"type": "visit_new", "data": visit}


def updated(visit: dict) -> dict:
    return {"type": "visit_updated", "data": {"visit": visit}}


class FakeBirdNetGo(FakeSession):
    """BirdNET-Go's detection endpoint. A detection may be a list: each ask gets the next entry, the last one stays. `fail` makes a
    detection answer a chosen status or raise a network error."""

    def __init__(self) -> None:
        super().__init__()
        self.detections: dict[int, object] = {}
        self.fail: dict[int, object] = {}

    def request(self, method: str, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        prefix = f"{API}/detections/"
        if method != "GET" or not url.startswith(prefix):
            return FakeResponse(404, {"error": "not_found"})
        number = int(url[len(prefix):])
        failure = self.fail.get(number)
        if isinstance(failure, Exception):
            raise failure
        if isinstance(failure, int):
            return FakeResponse(failure, {"error": "refused"})
        found = self.detections.get(number)
        if isinstance(found, list):
            found = found.pop(0) if len(found) > 1 else found[0]
        if found is None:
            return FakeResponse(404, {"error": "Detection not found"})
        return FakeResponse(200, copy.deepcopy(found))

    def paths(self) -> list[str]:
        return [f"{method} {url.removeprefix(API)}" for method, url, _ in self.calls]


class FakePlugin:
    """The Kestrel plugin's `visits/<id>/models` route."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, object]] = []
        self.answer: object = {"result": "updated"}

    async def async_request(self, method: str, path: str, **kwargs: object) -> object:
        self.calls.append((method, path, kwargs.get("json")))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class ModelsTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.birdnet = FakeBirdNetGo()
        SESSION["session"] = self.birdnet
        self.hass = HomeAssistant()
        self.plugin = FakePlugin()
        self.service = birdnet_models.BirdnetModels(self.hass, self.plugin, retry_s=0)
        self.service.async_start()
        self.birdnet.detections[360] = both(360)

    async def asyncTearDown(self) -> None:
        await self.service.async_stop()

    def send(self, *events: object) -> None:
        async_dispatcher_send(self.hass, const_module.SIGNAL_EVENTS, list(events))

    async def settle(self) -> None:
        """Let every lookup finish."""
        while self.service._tasks:
            await asyncio.gather(*list(self.service._tasks), return_exceptions=True)
            await asyncio.sleep(0)

    def last(self) -> dict:
        return self.service.diagnostics()["recent"][-1]

    def counts(self) -> dict:
        return self.service.diagnostics()["counts"]


class LookupTests(ModelsTestCase):
    async def test_a_new_heard_visit_gets_its_models_from_birdnet_go_and_the_plugin_is_told(self) -> None:
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.birdnet.paths(), ["GET /detections/360"])
        self.assertEqual(
            self.plugin.calls,
            [("POST", "visits/h1/models", {"detectionId": 360, "contributions": [
                {"modelName": "BirdNET", "modelVersion": "3.0", "hitCount": 3, "maxConfidence": 0.93},
                {"modelName": "Perch", "modelVersion": "V2", "hitCount": 2, "maxConfidence": 0.71},
            ]})],
        )
        self.assertEqual(self.counts()["recorded"], 1)
        self.assertEqual(self.last()["outcome"], "recorded")
        self.assertEqual((self.last()["visitId"], self.last()["detectionId"]), ("h1", 360))
        self.assertIn("BirdNET 3.0", self.last()["detail"])
        self.assertIn("Perch V2", self.last()["detail"])

    async def test_an_updated_visit_works_too_and_one_visit_and_detection_is_asked_about_once(self) -> None:
        self.send(updated(heard()))
        await self.settle()
        self.send(new(heard()), updated(heard()))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 1)
        self.assertEqual(len(self.plugin.calls), 1)

    async def test_the_same_event_twice_in_one_batch_is_one_lookup(self) -> None:
        self.send(new(heard()), new(heard()))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 1)

    async def test_a_new_detection_of_the_same_visit_is_asked_about_again(self) -> None:
        self.birdnet.detections[361] = both(361)
        self.send(new(heard(detection_id=360)))
        await self.settle()
        self.send(updated(heard(detection_id=361)))
        await self.settle()
        self.assertEqual(self.birdnet.paths(), ["GET /detections/360", "GET /detections/361"])
        self.assertEqual([call[2]["detectionId"] for call in self.plugin.calls], [360, 361])

    async def test_only_heard_visits_nobody_has_decided_on_and_with_a_detection_number_are_looked_at(self) -> None:
        self.send(
            {"type": "visit_new", "data": {"id": "s1", "kind": "seen", "species": "Coyote", "audio": {"birdnetDetectionId": 360}}},
            new(heard("h2", 0)),
            new(heard("h3", None)),
            new(heard("h4", True)),
            new(heard("h5", "360")),
            new({"id": "h6", "kind": "heard", "species": "Blue Jay", "status": "auto"}),
            new(heard("h7", status="confirmed")),
            new(heard("h8", status="corrected")),
            {"type": "camera", "data": {"id": "88"}},
            {"type": "visit_deleted", "data": {"id": "h1"}},
            "nonsense",
            {"type": "visit_new"},
            {"type": "visit_new", "data": "x"},
        )
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.plugin.calls, [])
        self.assertEqual(self.service.diagnostics()["recent"], [])

    async def test_a_visit_that_already_lists_two_agreeing_models_is_not_looked_up(self) -> None:
        models = [
            {"model": "birdnet_v3", "label": "BirdNET v3.0", "species": "Blue Jay", "score": 0.9, "role": "named"},
            {"model": "perch_v2", "label": "Perch v2", "species": "Blue Jay", "score": 0.7, "role": "agree"},
        ]
        self.send(new(heard(models=models)))
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        # one model, or a model that named another bird, is not agreement yet
        self.send(new(heard("h2", models=models[:1])))
        self.send(new(heard("h3", models=[models[0], {**models[1], "species": "American Crow", "role": "other"}])))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 2)

    async def test_an_old_visit_is_skipped_and_a_start_that_cannot_be_read_is_not(self) -> None:
        self.send(new(heard("old", started=int((time.time() - 2 * 3600) * 1000))))
        self.send(new(heard("old-iso", started="2020-01-01T00:00:00+00:00")))
        await self.settle()
        self.assertEqual(self.birdnet.calls, [])
        self.send(new(heard("fresh-iso", started=time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - 120)))))
        self.send(new(heard("odd", started="yesterday")))
        self.send(new(heard("none", started=True)))
        await self.settle()
        self.assertEqual(sorted(call[1] for call in self.plugin.calls), ["visits/fresh-iso/models", "visits/none/models", "visits/odd/models"])

    async def test_a_visit_id_is_one_path_part(self) -> None:
        self.send(new(heard("a/b?c")))
        await self.settle()
        self.assertEqual(self.plugin.calls[0][1], "visits/a%2Fb%3Fc/models")


class WhenBirdNetGoHasNothingYet(ModelsTestCase):
    async def test_a_model_list_that_is_filled_in_late_is_found_by_the_second_ask(self) -> None:
        self.birdnet.detections[360] = [{"id": 360}, both(360)]
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.birdnet.paths(), ["GET /detections/360", "GET /detections/360"])
        self.assertEqual(len(self.plugin.calls), 1)
        self.assertEqual(self.last()["outcome"], "recorded")

    async def test_a_model_list_that_never_comes_is_asked_twice_noted_and_then_left_alone(self) -> None:
        self.birdnet.detections[360] = {"id": 360, "modelContributions": []}
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 2)
        self.assertEqual(self.plugin.calls, [])
        self.assertEqual(self.last()["outcome"], "no_models")
        self.send(updated(heard()))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 2, "not asked a third time")

    async def test_a_detection_birdnet_go_does_not_have_is_skipped_for_good(self) -> None:
        del self.birdnet.detections[360]
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "skipped")
        self.assertIn("no detection 360", self.last()["detail"])
        self.assertEqual(self.plugin.calls, [])
        self.send(updated(heard()))
        await self.settle()
        self.assertEqual(len(self.birdnet.calls), 1)

    async def test_birdnet_go_being_down_changes_nothing_and_the_next_event_tries_again(self) -> None:
        self.birdnet.fail[360] = aiohttp.ClientError("down")
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "failed")
        self.assertEqual(self.plugin.calls, [])
        self.birdnet.fail[360] = 500
        self.send(updated(heard()))
        await self.settle()
        self.assertEqual(self.counts()["failed"], 2)
        del self.birdnet.fail[360]
        self.send(updated(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "recorded")
        self.assertEqual(len(self.plugin.calls), 1)

    async def test_an_unexpected_answer_is_a_note_not_a_crash(self) -> None:
        self.birdnet.detections[360] = ["a list", "of nonsense"]
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "no_models")
        self.birdnet.detections[361] = {"modelContributions": "none"}
        self.send(new(heard("h2", 361)))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "no_models")


class WhenThePluginSaysNo(ModelsTestCase):
    async def test_a_visit_the_plugin_no_longer_has_is_skipped(self) -> None:
        self.plugin.answer = KestrelApiError("Kestrel returned HTTP 404", status=404)
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "skipped")
        self.assertIn("no longer has", self.last()["detail"])

    async def test_a_plugin_that_is_down_is_a_failure_that_is_tried_again_later(self) -> None:
        self.plugin.answer = KestrelApiError("Could not reach the Kestrel plugin")
        self.send(new(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "failed")
        self.plugin.answer = {"result": "updated"}
        self.send(updated(heard()))
        await self.settle()
        self.assertEqual(self.last()["outcome"], "recorded")

    async def test_what_the_plugin_answers_is_told_in_plain_words(self) -> None:
        for answer, outcome in (({"result": "unchanged"}, "unchanged"), ({"result": "stale"}, "skipped"), ({"result": "unknown"}, "skipped"), (None, "skipped")):
            self.plugin.answer = answer
            self.birdnet.detections[400] = both(400)
            self.send(new(heard(f"v{outcome}{answer}", 400)))
            await self.settle()
            self.assertEqual(self.last()["outcome"], outcome, str(answer))
            self.birdnet.calls.clear()
            self.service._done.clear()


class WhatIsPassedOn(ModelsTestCase):
    async def test_only_models_with_hits_and_a_name_are_passed_on_at_most_eight(self) -> None:
        junk = [
            "text", None, 3, {"modelName": "", "hitCount": 1}, {"modelName": "Nameless"}, {"modelName": "Zero", "hitCount": 0},
            {"modelName": "Truth", "hitCount": True}, {"modelName": "Text", "hitCount": "3"}, {"hitCount": 2},
            {"modelName": "Odd", "hitCount": 2.9, "maxConfidence": float("nan"), "modelVersion": 3},
            {"modelName": "Perch", "modelVersion": "V2", "hitCount": 2, "maxConfidence": True},
        ]
        extra = [{"modelName": f"M{index}", "hitCount": 1} for index in range(10)]
        self.birdnet.detections[360] = {"id": 360, "modelContributions": junk + extra}
        self.send(new(heard()))
        await self.settle()
        contributions = self.plugin.calls[0][2]["contributions"]
        self.assertEqual(contributions[0], {"modelName": "Odd", "hitCount": 2})
        self.assertEqual(contributions[1], {"modelName": "Perch", "modelVersion": "V2", "hitCount": 2})
        self.assertEqual(len(contributions), 8)

    async def test_a_burst_of_visits_asks_birdnet_go_two_at_a_time(self) -> None:
        gate = asyncio.Event()
        running = {"now": 0, "most": 0}
        original = birdnet_models.birdnet_api.async_request

        async def slow(hass: object, method: str, path: str, **kwargs: object) -> object:
            running["now"] += 1
            running["most"] = max(running["most"], running["now"])
            await gate.wait()
            running["now"] -= 1
            return both(360)

        birdnet_models.birdnet_api.async_request = slow
        try:
            self.send(*[new(heard(f"v{index}", 500 + index)) for index in range(6)])
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertEqual(self.service.diagnostics()["waiting"], 6)
            self.assertEqual(running["most"], birdnet_models.MAX_CONCURRENT)
            gate.set()
            await self.settle()
        finally:
            birdnet_models.birdnet_api.async_request = original
        self.assertEqual(len(self.plugin.calls), 6)


class StoppingTests(ModelsTestCase):
    async def test_stopping_listens_no_more_and_cancels_what_is_running(self) -> None:
        gate = asyncio.Event()
        original = birdnet_models.birdnet_api.async_request

        async def hang(hass: object, method: str, path: str, **kwargs: object) -> object:
            await gate.wait()
            return both(360)

        birdnet_models.birdnet_api.async_request = hang
        try:
            self.send(new(heard()))
            await asyncio.sleep(0)
            self.assertEqual(self.service.diagnostics()["waiting"], 1)
            await self.service.async_stop()
            self.assertEqual(self.service.diagnostics()["waiting"], 0)
            self.assertEqual(self.service._tasks, set())
        finally:
            birdnet_models.birdnet_api.async_request = original
        self.send(new(heard("h2", 360)))
        await asyncio.sleep(0)
        self.assertEqual(self.birdnet.calls, [])
        self.assertEqual(self.plugin.calls, [])

    async def test_diagnostics_start_empty_and_say_what_happened(self) -> None:
        self.assertEqual(self.service.diagnostics(), {"configured": True, "waiting": 0, "counts": {"recorded": 0, "unchanged": 0, "no_models": 0, "skipped": 0, "failed": 0}, "recent": []})
        self.send(new(heard()))
        await self.settle()
        report = self.service.diagnostics()
        self.assertEqual(report["counts"]["recorded"], 1)
        self.assertEqual(set(report["recent"][0]), {"visitId", "detectionId", "outcome", "detail", "at"})

    async def test_the_config_entry_diagnostics_show_it_and_never_a_secret(self) -> None:
        self.send(new(heard()))
        await self.settle()
        self.hass.data[DOMAIN] = {"birdnet_models": self.service}
        entry = types.SimpleNamespace(
            runtime_data=new_coordinator([], self.hass), as_dict=lambda: {"data": {"url": "http://x", "api_key": "plugin-secret"}, "options": {}}
        )
        result = await diagnostics_module.async_get_config_entry_diagnostics(self.hass, entry)
        self.assertEqual(result["birdnet_models"]["counts"]["recorded"], 1)
        self.assertEqual(result["birdnet_models"]["recent"][0]["outcome"], "recorded")
        self.assertNotIn("plugin-secret", json.dumps(result["birdnet_models"]))
        del self.hass.data[DOMAIN]["birdnet_models"]
        result = await diagnostics_module.async_get_config_entry_diagnostics(self.hass, entry)
        self.assertEqual(result["birdnet_models"], {"configured": False})


if __name__ == "__main__":
    unittest.main()
