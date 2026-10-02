"""Kestrel's endless loops must not hold up Home Assistant's startup.

Home Assistant waits, after it has set integrations up, for every ordinary task created meanwhile (up to its 300 s
bootstrap timeout). The event long poll never ends, and the BirdNET-Go species-map request can sit for 30 s, so both
have to be background tasks. Runs the real coordinator.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from ha_stubs import SESSION, HomeAssistant, new_coordinator


class _NeverAnswers:
    """A request whose server accepts the connection and then says nothing."""

    async def __aenter__(self) -> None:
        await asyncio.Event().wait()

    async def __aexit__(self, *exc: object) -> bool:
        return False


class StartupTaskTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_endless_poll_and_a_silent_birdnet_do_not_hold_up_home_assistants_startup(self) -> None:
        hass = HomeAssistant()
        coordinator = new_coordinator([], hass)

        async def held_open(*args: object, **kwargs: object) -> None:
            await asyncio.Event().wait()  # the plugin's long poll: the request stays open until there is news

        coordinator.client.async_request = held_open
        with mock.patch.object(SESSION["session"], "get", lambda url, **kwargs: _NeverAnswers()):
            coordinator.async_start()
            try:
                await asyncio.wait_for(hass.async_block_till_done(), timeout=1)
            finally:
                await coordinator.async_stop()
        self.assertIsNone(coordinator._poll_task)  # stopped cleanly: both loops were cancelled

    async def test_stopping_cancels_both_loops(self) -> None:
        hass = HomeAssistant()
        coordinator = new_coordinator([], hass)

        async def held_open(*args: object, **kwargs: object) -> None:
            await asyncio.Event().wait()

        coordinator.client.async_request = held_open
        with mock.patch.object(SESSION["session"], "get", lambda url, **kwargs: _NeverAnswers()):
            coordinator.async_start()
            poll, species = coordinator._poll_task, coordinator._species_map_task
            await asyncio.sleep(0)  # let both start
            await coordinator.async_stop()
        self.assertTrue(poll.cancelled() and species.cancelled())


if __name__ == "__main__":
    unittest.main()
