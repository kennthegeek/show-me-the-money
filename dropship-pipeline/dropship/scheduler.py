"""Interval scheduler for the worker loops.

* each job runs on its own interval, never overlapping itself
* failures are logged, alerted, and back off (interval x2, capped at 4x) until a success
* SIGINT/SIGTERM stop the loop after the current job finishes (no half-written orders)
"""

from __future__ import annotations

import logging
import random
import signal
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .db import Database
from .notify import Alerter

log = logging.getLogger(__name__)


@dataclass
class Job:
    name: str
    interval: int
    fn: Callable[[], Any]
    next_run: float = 0.0
    failures: int = 0
    last_result: Any = field(default=None, repr=False)


class Scheduler:
    def __init__(self, db: Database, alerter: Alerter, *, clock=time.monotonic):
        self.db = db
        self.alerter = alerter
        self.jobs: list[Job] = []
        self.stop_event = threading.Event()
        self._clock = clock

    def add(self, name: str, interval: int, fn: Callable[[], Any], *, run_immediately: bool = True) -> None:
        if interval <= 0:
            log.info("job %s disabled (interval=%s)", name, interval)
            return
        # Small jitter so restarts don't stampede the APIs at the same second.
        first = self._clock() + (random.uniform(0, 3) if run_immediately else interval)
        self.jobs.append(Job(name, interval, fn, next_run=first))

    def install_signal_handlers(self) -> None:
        def _stop(signum, _frame):
            log.info("received signal %s; finishing current job then exiting", signum)
            self.stop_event.set()

        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGTERM, _stop)

    def run_job(self, job: Job) -> bool:
        run_id = self.db.start_run(job.name)
        started = time.monotonic()
        try:
            result = job.fn()
            job.last_result = result
            summary = result.__dict__ if hasattr(result, "__dict__") else result
            self.db.finish_run(run_id, True, summary)
            if job.failures:
                self.alerter.alert(f"job-recovered:{job.name}", f"job {job.name} recovered", level="warning")
            job.failures = 0
            log.info("job %s ok in %.1fs: %s", job.name, time.monotonic() - started, summary)
            return True
        except Exception as exc:
            job.failures += 1
            self.db.finish_run(run_id, False, {"error": str(exc)})
            log.exception("job %s failed (%d in a row)", job.name, job.failures)
            self.alerter.alert(f"job:{job.name}", f"job {job.name} failed {job.failures}x in a row: {exc}")
            return False

    def run_forever(self, tick: float = 1.0) -> None:
        log.info("scheduler started with jobs: %s", ", ".join(f"{j.name}/{j.interval}s" for j in self.jobs))
        while not self.stop_event.is_set():
            now = self._clock()
            for job in sorted(self.jobs, key=lambda j: j.next_run):
                if self.stop_event.is_set():
                    break
                if job.next_run <= now:
                    self.run_job(job)
                    backoff = min(4, 2 ** job.failures) if job.failures else 1
                    job.next_run = self._clock() + job.interval * backoff
            self.stop_event.wait(tick)
        log.info("scheduler stopped")
