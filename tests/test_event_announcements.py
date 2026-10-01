"""Each visit is announced as a Home Assistant event once, and only when it is new.

Runs the real announced.py, coordinator.py and event.py with Home Assistant itself
stubbed out (see ha_stubs.py), so no Home Assistant install is needed:

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from ha_stubs import (
    BACK,
    DISK,
    FRONT,
    STORAGE_KEY,
    BatchDelivery,
    KestrelApiError,
    attach,
    event,
    event_module,
    fired_ids,
    heard,
    new_announced,
    new_coordinator,
    run_poll_loop,
    seen,
)


class AnnouncedEventTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        DISK.clear()

    # --- the Front Door raccoon: new, duplicate new, clip ready, clip gave up --------------

    def test_only_new_visits_fire_never_their_updates(self) -> None:
        raccoon, squirrel = seen("r1", "Raccoon"), seen("f1", "Flying squirrel")
        delivery = BatchDelivery(new_announced())
        entity = event_module.KestrelAnimalEvent(delivery, FRONT)
        for batch in (
            [event("visit_new", raccoon)],
            [event("visit_new", squirrel)],
            [event("visit_updated", squirrel)],  # its clip became ready
            [event("visit_updated", raccoon)],  # its clip gave up
        ):
            delivery.deliver([entity], batch)
        self.assertEqual(fired_ids(entity), ["r1", "f1"])
        self.assertTrue(all(kind == "mammal" for kind, _ in entity.fired))

    def test_an_update_for_a_visit_never_announced_does_not_fire_or_claim_it(self) -> None:
        announced = new_announced()
        delivery = BatchDelivery(announced)
        entity = event_module.KestrelAnimalEvent(delivery, FRONT)
        delivery.deliver([entity], [event("visit_updated", seen("z1", "Raccoon"))])
        self.assertEqual(entity.fired, [])
        self.assertNotIn("z1", announced)

    def test_the_same_visit_twice_in_one_batch_fires_once(self) -> None:
        raccoon = seen("r1", "Raccoon")
        delivery = BatchDelivery(new_announced())
        entity = event_module.KestrelAnimalEvent(delivery, FRONT)
        delivery.deliver(
            [entity],
            [event("visit_new", raccoon), event("visit_new", raccoon, wrapped=True), event("visit_updated", raccoon)],
        )
        self.assertEqual(fired_ids(entity), ["r1"])

    async def test_a_visit_announced_before_a_restart_is_not_announced_again(self) -> None:
        raccoon, opossum = seen("r1", "Raccoon"), seen("n1", "Opossum")
        before = new_announced()
        await before.async_save()
        delivery = BatchDelivery(before)
        first = event_module.KestrelAnimalEvent(delivery, FRONT)
        delivery.deliver([first], [event("visit_new", raccoon)])
        await before.async_flush()

        after = new_announced()  # Home Assistant restarted: new objects, same storage
        self.assertTrue(await after.async_load())
        delivery = BatchDelivery(after)
        second = event_module.KestrelAnimalEvent(delivery, FRONT)
        delivery.deliver([second], [event("visit_new", raccoon), event("visit_new", opossum)])
        self.assertEqual(fired_ids(first), ["r1"])
        self.assertEqual(fired_ids(second), ["n1"])

    # --- heard animals and routing -----------------------------------------------------------

    def test_heard_entity_fires_once_for_new_heard_visits_only(self) -> None:
        wren, frog, cricket = heard("h1", "Carolina Wren"), heard("h2", "Spring Peeper", grp="other"), heard("h3", "Cricket", grp="insect")
        delivery = BatchDelivery(new_announced())
        heard_entity = event_module.KestrelHeardAnimalEvent(delivery)
        camera_entity = event_module.KestrelAnimalEvent(delivery, BACK)
        delivery.deliver(
            [heard_entity, camera_entity],
            [event("visit_new", wren), event("visit_updated", wren), event("visit_new", frog),
             event("visit_new", cricket), event("visit_updated", wren)],
        )
        delivery.deliver([heard_entity, camera_entity], [event("visit_new", wren)])  # replay
        self.assertEqual(fired_ids(heard_entity), ["h1", "h2"])
        self.assertEqual([kind for kind, _ in heard_entity.fired], ["bird", "other"])
        self.assertEqual(camera_entity.fired, [], "a heard visit must not fire a camera entity")

    def test_a_visit_on_another_camera_is_ignored_and_left_for_its_own_entity(self) -> None:
        owl = seen("s9", "Barred Owl", grp="bird", camera=BACK)
        announced = new_announced()
        delivery = BatchDelivery(announced)
        front_entity = event_module.KestrelAnimalEvent(delivery, FRONT)
        back_entity = event_module.KestrelAnimalEvent(delivery, BACK)
        delivery.deliver([front_entity, back_entity], [event("visit_new", owl)])
        self.assertEqual(front_entity.fired, [])
        self.assertEqual(fired_ids(back_entity), ["s9"])

    def test_a_new_visit_without_an_id_cannot_be_deduplicated_so_it_does_not_fire(self) -> None:
        nameless = seen("x", "Raccoon")
        del nameless["id"]
        announced = new_announced()
        delivery = BatchDelivery(announced)
        entity = event_module.KestrelAnimalEvent(delivery, FRONT)
        delivery.deliver([entity], [event("visit_new", nameless)])
        self.assertEqual(entity.fired, [])
        self.assertEqual(len(announced), 0)

    # --- the memory itself -------------------------------------------------------------------

    async def test_memory_keeps_only_the_newest_500_and_persists_them_in_order(self) -> None:
        announced = new_announced()
        for number in range(600):
            self.assertTrue(announced.claim(f"v{number}"))
        self.assertEqual(len(announced), 500)
        self.assertNotIn("v99", announced)
        self.assertIn("v100", announced)
        await announced.async_flush()
        saved = DISK[STORAGE_KEY]["ids"]
        self.assertEqual((len(saved), saved[0], saved[-1]), (500, "v100", "v599"))

        DISK["kestrel.announced.E2"] = {"ids": [f"old{number}" for number in range(700)]}
        oversized = new_announced("E2")
        self.assertTrue(await oversized.async_load())
        self.assertEqual(len(oversized), 500)
        self.assertNotIn("old199", oversized)
        self.assertIn("old200", oversized)

    async def test_missing_or_corrupt_storage_counts_as_a_first_run(self) -> None:
        for bad in (None, [], "x", {}, {"ids": "nope"}, {"ids": None}):
            DISK.clear()
            if bad is not None:
                DISK[STORAGE_KEY] = bad
            self.assertFalse(await new_announced().async_load(), bad)
        DISK[STORAGE_KEY] = {"ids": ["a", 7, "", None, "b"]}
        loaded = new_announced()
        self.assertTrue(await loaded.async_load())
        self.assertEqual(len(loaded), 2)

    async def test_flush_saves_what_was_claimed_and_remove_deletes_it(self) -> None:
        announced = new_announced()
        announced.claim("d1")
        await announced.async_flush()
        self.assertEqual(DISK[STORAGE_KEY], {"ids": ["d1"]})
        await announced.async_remove()
        self.assertNotIn(STORAGE_KEY, DISK)

    # --- through the real poll loop ----------------------------------------------------------

    async def test_poll_loop_fires_new_visits_only_while_dashboards_still_get_every_event(self) -> None:
        raccoon, squirrel = seen("r1", "Raccoon"), seen("f1", "Flying squirrel")
        DISK[STORAGE_KEY] = {"ids": []}  # not a first run
        coordinator = new_coordinator([
            {"seq": 10, "events": [event("visit_new", raccoon)]},
            {"seq": 11, "events": [event("visit_new", squirrel)]},
            {"seq": 12, "events": [event("visit_updated", squirrel)]},
            {"seq": 13, "events": [event("visit_updated", raccoon)]},
        ])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        attach(coordinator, camera_entity)
        await run_poll_loop(coordinator)
        self.assertEqual(fired_ids(camera_entity), ["r1", "f1"])
        self.assertEqual([call["after"] for call in coordinator.client.calls[:4]], [0, 10, 11, 12])
        self.assertEqual(coordinator.data["events"][0]["type"], "visit_updated")  # websocket subscribers see updates
        await coordinator.async_stop()
        self.assertEqual(set(DISK[STORAGE_KEY]["ids"]), {"r1", "f1"})

    async def test_poll_loop_after_a_restart_that_replays_the_whole_plugin_log(self) -> None:
        raccoon, squirrel, opossum = seen("r1", "Raccoon"), seen("f1", "Flying squirrel"), seen("n1", "Opossum")
        DISK[STORAGE_KEY] = {"ids": ["r1", "f1"]}
        coordinator = new_coordinator([{"seq": 13, "events": [
            event("visit_new", raccoon), event("visit_new", squirrel), event("visit_updated", raccoon),
            event("visit_new", opossum), event("visit_updated", squirrel),
        ]}])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        attach(coordinator, camera_entity)
        await run_poll_loop(coordinator)
        self.assertEqual(fired_ids(camera_entity), ["n1"])

    async def test_first_run_adopts_what_the_plugin_already_holds_without_announcing_it(self) -> None:
        raccoon, wren, squirrel, opossum = seen("r1", "Raccoon"), heard("h1", "Carolina Wren"), seen("f1", "Flying squirrel"), seen("n1", "Opossum")
        backlog = [event("visit_new", raccoon), event("visit_updated", raccoon), event("visit_new", wren), event("visit_new", squirrel)]
        coordinator = new_coordinator([
            {"seq": 40, "events": backlog},  # the one-off request for the plugin's current log
            {"seq": 41, "events": [event("visit_new", opossum)]},
        ])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        heard_entity = event_module.KestrelHeardAnimalEvent(coordinator)
        attach(coordinator, camera_entity, heard_entity)
        await run_poll_loop(coordinator)
        self.assertEqual(coordinator.client.calls[0], {"after": 0, "timeout": 0})
        self.assertEqual(coordinator.client.calls[1]["after"], 40)
        self.assertEqual(fired_ids(camera_entity), ["n1"])
        self.assertEqual(heard_entity.fired, [])
        self.assertEqual(DISK[STORAGE_KEY]["ids"][:3], ["r1", "h1", "f1"], "saved straight away, not left to a delayed write")
        await coordinator.async_stop()

        # The next restart replays that same backlog: none of it may be announced.
        again = new_coordinator([{"seq": 41, "events": backlog + [event("visit_new", opossum)]}])
        camera_entity = event_module.KestrelAnimalEvent(again, FRONT)
        heard_entity = event_module.KestrelHeardAnimalEvent(again)
        attach(again, camera_entity, heard_entity)
        await run_poll_loop(again)
        self.assertEqual((camera_entity.fired, heard_entity.fired), ([], []))

    async def test_first_run_against_an_already_trimmed_plugin_log_still_saves_its_marker(self) -> None:
        opossum = seen("n1", "Opossum")
        coordinator = new_coordinator([{"seq": 900, "resync": True}, {"seq": 901, "events": [event("visit_new", opossum)]}])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        attach(coordinator, camera_entity)
        await run_poll_loop(coordinator)
        self.assertEqual(coordinator.client.calls[1]["after"], 900)
        self.assertEqual(fired_ids(camera_entity), ["n1"])
        self.assertIn(STORAGE_KEY, DISK)

    async def test_first_run_retries_when_the_plugin_is_down_and_delivers_nothing_before_it_succeeds(self) -> None:
        raccoon, opossum = seen("r1", "Raccoon"), seen("n1", "Opossum")
        real_sleep = asyncio.sleep

        async def quick_sleep(delay: float, *args: object, **kwargs: object) -> None:
            await real_sleep(0)

        coordinator = new_coordinator([
            KestrelApiError("plugin down"),
            {"seq": 7, "events": [event("visit_new", raccoon)]},
            {"seq": 8, "events": [event("visit_new", opossum)]},
        ])
        camera_entity = event_module.KestrelAnimalEvent(coordinator, FRONT)
        attach(coordinator, camera_entity)
        with mock.patch("asyncio.sleep", quick_sleep):
            await run_poll_loop(coordinator)
        self.assertEqual(coordinator.client.calls[:2], [{"after": 0, "timeout": 0}, {"after": 0, "timeout": 0}])
        self.assertEqual(fired_ids(camera_entity), ["n1"])


if __name__ == "__main__":
    unittest.main()
