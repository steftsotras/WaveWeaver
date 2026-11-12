"""
In-memory job runner. Same shape as the studio's: a dict of jobs, a small
worker pool, cooperative cancellation. Restart clears the list; outputs stay
on disk.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import WORKERS

MAX_LOG_LINES = 2000


@dataclass
class Job:
    id: str
    tool: str
    label: str
    status: str = "queued"  # queued | running | done | error | cancelled
    phase: str = "queued"
    ratio: float | None = None
    logs: list[str] = field(default_factory=list)
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    on_cancel: Callable[[], None] | None = None

    def add_log(self, line: str) -> None:
        self.logs.append(line)
        if len(self.logs) > MAX_LOG_LINES:
            del self.logs[: len(self.logs) - MAX_LOG_LINES]

    def view(self) -> dict:
        return {
            "id": self.id,
            "tool": self.tool,
            "label": self.label,
            "status": self.status,
            "progress": {"phase": self.phase, "ratio": self.ratio},
            "logs": self.logs,
            "result": self.result,
            "error": self.error,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
        }


_jobs: dict[str, Job] = {}
_pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="ww-job")


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def all_jobs() -> list[Job]:
    return sorted(_jobs.values(), key=lambda j: j.created, reverse=True)


def cancel(job_id: str) -> bool:
    job = _jobs.get(job_id)
    if not job or job.status not in ("queued", "running"):
        return False
    job.add_log("Cancel requested.")
    job.cancel_event.set()
    if job.on_cancel:
        job.on_cancel()
    return True


def submit(tool: str, label: str, work: Callable[[Job], dict[str, Any]]) -> Job:
    from .context import Cancelled

    job = Job(id=str(uuid.uuid4()), tool=tool, label=label)
    _jobs[job.id] = job

    def runner() -> None:
        if job.cancel_event.is_set():
            job.status = "cancelled"
            job.finished = time.time()
            return
        job.status = "running"
        job.phase = "run"
        job.started = time.time()
        try:
            job.result = work(job)
            job.status = "done"
            job.ratio = 1.0
        except Cancelled:
            job.status = "cancelled"
            job.add_log("Cancelled.")
        except Exception as e:
            if job.cancel_event.is_set():
                job.status = "cancelled"
                job.add_log("Cancelled.")
            else:
                job.status = "error"
                job.error = f"{type(e).__name__}: {e}"
                job.add_log("ERROR: " + "".join(traceback.format_exception(e)).strip()[-1500:])
        finally:
            job.finished = time.time()

    _pool.submit(runner)
    return job
