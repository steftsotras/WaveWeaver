"""
Spectral-gating noise reduction (noisereduce). Works the way Audacity's
Noise Reduction does: show it a stretch of *just noise* — select a gap on the
waveform — and it learns that fingerprint and subtracts it everywhere.
Without a sample it estimates noise as it goes (adaptive mode).
"""
from __future__ import annotations

import numpy as np

from ..config import SAMPLE_RATE
from ..context import Context
from ..media import decode_all
from ..registry import Param, Tool
from ._common import process_audio


def run(ctx: Context) -> dict:
    import noisereduce as nr

    p = ctx.params
    noise = None
    if p["noise"]:
        a, b = p["noise"]
        ctx.progress(0, "learn noise")
        noise = decode_all(ctx, ctx.input, excerpt=(a, min(b - a, 30.0)))
        if noise.shape[1] < SAMPLE_RATE * 0.2:
            raise ValueError("The noise sample is too short — select at least 0.2 s of pure noise.")
        ctx.log(f"Learned noise profile from {a:.1f}s–{b:.1f}s.")
    stationary = p["mode"] == "stationary" or noise is not None

    def fn(block: np.ndarray) -> np.ndarray:
        return nr.reduce_noise(
            y=block,
            sr=SAMPLE_RATE,
            y_noise=noise,
            stationary=stationary,
            prop_decrease=p["amount"],
            n_std_thresh_stationary=p["sensitivity"],
            time_mask_smooth_ms=p["smoothing"],
            n_jobs=1,
        ).astype(np.float32)

    # Spectral masks look ±1 s around each frame; give every block that much
    # real context so block edges don't pump.
    return process_audio(ctx, "denoise", fn, block_seconds=20.0, context_seconds=1.0)


TOOL = Tool(
    id="denoise",
    label="Noise reduction",
    group="clean",
    blurb="Learn the noise from a selection (a gap with just hiss/hum/room) and remove it. Spectral gating, like Audacity's.",
    run=run,
    requires=["noisereduce", "scipy"],
    install="pip install noisereduce",
    credits="noisereduce (MIT, Tim Sainburg)",
    params=[
        Param("noise", "Noise sample", "region", None,
              help="Select a stretch of pure noise on the waveform. Leave empty to estimate continuously."),
        Param("amount", "Reduction", "number", 0.85, min=0.1, max=1.0, step=0.05,
              help="1.0 removes everything it classifies as noise; lower keeps some air and avoids 'underwater' artefacts."),
        Param("sensitivity", "Threshold", "number", 1.5, min=0.5, max=4.0, step=0.1,
              help="Standard deviations above the noise floor that count as signal. Higher = more aggressive."),
        Param("smoothing", "Smoothing", "number", 50, min=0, max=200, step=10, unit="ms"),
        Param("mode", "Without a sample", "select", "adaptive",
              options=[("adaptive", "Adaptive"), ("stationary", "Stationary")]),
    ],
    presets={
        "Gentle": {"amount": 0.6, "sensitivity": 1.5, "smoothing": 80},
        "Voice in a room": {"amount": 0.85, "sensitivity": 1.5, "smoothing": 50},
        "Heavy hiss": {"amount": 1.0, "sensitivity": 2.0, "smoothing": 30},
    },
)
