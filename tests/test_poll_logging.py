"""While the plugin is down the event connection says so once, not on every retry.

Runs the real coordinator.py with Home Assistant stubbed out (see ha_stubs.py):

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import logging
import unittest
from unittest import mock

from ha_stubs import DISK, KestrelApiError, event, new_coordinator, run_poll_loop, seen

LOGGER = "kestrel_pkg.coordinator"
GOOD = {"seq": 1, "events": []}
PRIME = {"seq": 0, "events": []}  # a first run asks the plugin where it stands before it starts the long poll


async def _no_wait(delay: float, *args: object, **kwargs: object) -> None:
    await _REAL_SLEEP(0)


_REAL_SLEEP = asyncio.sleep


class PollLoggingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        DISK.clear()

    async def _run(self, script: list) -> list[logging.LogRecord]:
        coordinator = new_coordinator([PRIME, *script])
        with self.assertLogs(LOGGER, level="DEBUG") as captured, mock.patch("asyncio.sleep", _no_wait):
            await run_poll_loop(coordinator)
            logging.getLogger(LOGGER).debug("end")  # assertLogs fails when nothing at all is logged
        return [record for record in captured.records if record.getMessage() != "end"]

    @staticmethod
    def _at(records: list[logging.LogRecord], level: int) -> list[str]:
        return [record.getMessage() for record in records if record.levelno == level]

    async def test_an_outage_warns_once_then_stays_quiet_and_says_when_it_is_over(self) -> None:
        records = await self._run([
            KestrelApiError("Could not reach the Kestrel plugin"),
            KestrelApiError("Could not reach the Kestrel plugin"),
            asyncio.TimeoutError(),
            KestrelApiError("Could not reach the Kestrel plugin"),
            GOOD,
        ])
        warnings = self._at(records, logging.WARNING)
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn("Could not reach the Kestrel plugin", warnings[0])
        self.assertEqual(len(self._at(records, logging.DEBUG)), 3)
        self.assertEqual(self._at(records, logging.INFO), ["Kestrel event connection restored"])
        self.assertEqual([record.levelno for record in records][0], logging.WARNING)
        self.assertEqual([record.levelno for record in records][-1], logging.INFO)
        self.assertEqual(self._at(records, logging.ERROR), [])

    async def test_a_second_outage_warns_again(self) -> None:
        records = await self._run([
            KestrelApiError("down"), GOOD,
            KestrelApiError("down"), KestrelApiError("down"), GOOD,
        ])
        self.assertEqual(len(self._at(records, logging.WARNING)), 2)
        self.assertEqual(len(self._at(records, logging.INFO)), 2)
        self.assertEqual(len(self._at(records, logging.DEBUG)), 1)

    async def test_a_healthy_connection_logs_nothing_above_debug(self) -> None:
        records = await self._run([GOOD, {"seq": 2, "events": [event("visit_new", seen("r1", "Raccoon"))]}])
        self.assertEqual([record.getMessage() for record in records if record.levelno > logging.DEBUG], [])

    async def test_an_unexpected_error_is_logged_with_its_traceback_once(self) -> None:
        records = await self._run([ValueError("odd shape"), ValueError("odd shape"), ValueError("odd shape"), GOOD])
        errors = [record for record in records if record.levelno == logging.ERROR]
        self.assertEqual(len(errors), 1)
        self.assertIsNotNone(errors[0].exc_info)
        self.assertEqual(len(self._at(records, logging.DEBUG)), 2)
        self.assertEqual(self._at(records, logging.INFO), ["Kestrel event connection restored"])


if __name__ == "__main__":
    unittest.main()
