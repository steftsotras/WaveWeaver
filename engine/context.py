"""
What a tool's run() receives: its input, cleaned params, where to write,
and the hooks for progress, logging and cancellation.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .media import VIDEO_CONTAINERS, Info

if TYPE_CHECKING:
    from .jobs import Job

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class Cancelled(Exception):
    pass


class Context:
    def __init__(
        self,
        job: "Job",
        *,
        params: dict,
        input: Path | None,
        info: Info | None,
        excerpt: tuple[float, float] | None,
        out_dir: Path | None,
        out_mode: str,
        out_format: str,
        stem: str,
        payload: Any = None,
    ):
        self.job = job
        self.params = params
        self.input = input
        self.info = info
        self.excerpt = excerpt
        self.out_dir = out_dir
        self.out_mode = out_mode  # "preview" | "render" | "data"
        self.out_format = out_format
        self.stem = stem
        self.payload = payload
        self._procs: list[subprocess.Popen] = []
        self._lock = threading.Lock()

    # -- reporting --------------------------------------------------------

    def log(self, line: str) -> None:
        self.job.add_log(line)

    def progress(self, ratio: float | None, phase: str | None = None) -> None:
        if phase:
            self.job.phase = phase
        self.job.ratio = None if ratio is None else max(0.0, min(1.0, ratio))

    # -- cancellation -----------------------------------------------------

    @property
    def cancelled(self) -> bool:
        return self.job.cancel_event.is_set()

    def check(self) -> None:
        """Call between units of work. Raises Cancelled once the job is cancelled."""
        if self.cancelled:
            raise Cancelled()

    def spawn(self, args: list[str], **kw) -> subprocess.Popen:
        """Start a child process that dies with the job when it's cancelled."""
        p = subprocess.Popen(args, creationflags=_NO_WINDOW, **kw)
        with self._lock:
            self._procs.append(p)
        return p

    def kill_children(self) -> None:
        with self._lock:
            for p in self._procs:
                if p.poll() is None:
                    try:
                        p.kill()
                    except OSError:
                        pass

    # -- outputs ----------------------------------------------------------

    def output_path(self, tag: str, ext: str | None = None) -> Path:
        """
        Previews always land as b.<ext> in the preview folder the studio
        made (it renders a.wav, the untouched excerpt, next to it). Renders
        get the same human naming as the studio's:
        <stem>-<tag>-<YYYYMMDD-hhmmss>.<ext>, never overwriting anything.
        """
        ext = ext or self.audio_ext()
        assert self.out_dir is not None
        if self.out_mode == "preview":
            return self.out_dir / f"b.{ext}"
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = f"{self.stem[:48]}-{tag}-{stamp}"
        for n in range(1, 1000):
            p = self.out_dir / f"{base}{'' if n == 1 else f'-{n}'}.{ext}"
            if not p.exists():
                return p
        raise RuntimeError("could not find a free output name")

    def audio_ext(self) -> str:
        """
        "same" keeps the input's container: a cleaned .mp4 is still an .mp4
        with its picture stream-copied. Previews are always WAV — the studio
        A/Bs them sample-accurately in the browser.
        """
        if self.out_mode == "preview":
            return "wav"
        fmt = self.out_format
        if fmt and fmt != "same":
            return fmt
        ext = self.input.suffix.lower().lstrip(".") if self.input else "wav"
        if ext in VIDEO_CONTAINERS:
            return ext
        return ext if ext in {"wav", "flac", "mp3", "m4a", "ogg", "opus"} else "wav"

    def video_source(self, out: Path) -> Path | None:
        """The input, when its picture should be carried into `out`."""
        if self.out_mode == "preview" or not self.info or not self.info.has_video:
            return None
        return self.input if out.suffix.lower().lstrip(".") in VIDEO_CONTAINERS else None

    def finalize(self, part: Path, final: Path) -> Path:
        part.replace(final)
        return final

    def part_path(self, final: Path) -> Path:
        """Write renders under a hidden name; rename on success (see finalize)."""
        if self.out_mode == "preview":
            return final
        return final.with_name(f".part-{final.name}")
