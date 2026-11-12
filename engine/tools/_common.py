"""Helpers shared by the audio-processing tools."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np

from ..context import Context
from ..media import stream


def process_audio(
    ctx: Context,
    tag: str,
    fn: Callable[[np.ndarray], np.ndarray],
    *,
    block_seconds: float = 10.0,
    context_seconds: float = 0.0,
    flush: Callable[[], np.ndarray | None] | None = None,
) -> dict:
    """
    The standard shape of an audio tool: stream the input through `fn` and
    write the result — WAV for previews; for renders the input's own format,
    with any video stream copied through untouched.
    """
    out = ctx.output_path(tag)
    part = ctx.part_path(out)
    ctx.progress(0, "process")
    stream(
        ctx,
        fn,
        out_path=part,
        block_seconds=block_seconds,
        context_seconds=context_seconds,
        video_from=ctx.video_source(out),
        flush=flush,
    )
    if part != out:
        ctx.finalize(part, out)
    ctx.log(f"Wrote {out.name}")
    return {"outputs": [str(out)]}


def fmt_time(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:04.1f}"


def tmp_path(ctx: Context, name: str) -> Path:
    from ..config import CACHE_DIR

    d = CACHE_DIR / "tmp" / ctx.job.id
    d.mkdir(parents=True, exist_ok=True)
    return d / name
