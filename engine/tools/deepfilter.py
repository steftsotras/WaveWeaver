"""
DeepFilterNet 3 — a neural speech enhancer that removes noise *and* reverb
from voice in real time, far beyond spectral gating on hard material (cafés,
traffic, echoey rooms). Optional; needs PyTorch:

    pip install deepfilternet
"""
from __future__ import annotations

import numpy as np

from ..config import SAMPLE_RATE
from ..context import Context
from ..registry import Param, Tool
from ._common import process_audio


_model = None


def run(ctx: Context) -> dict:
    global _model
    import torch
    from df.enhance import enhance, init_df

    if _model is None:
        ctx.log("Loading DeepFilterNet3…")
        _model = init_df()
    model, state, _ = _model
    if state.sr() != SAMPLE_RATE:
        raise RuntimeError(f"DeepFilterNet expects {state.sr()} Hz")
    mix = ctx.params["mix"]

    def fn(block: np.ndarray) -> np.ndarray:
        wet = enhance(model, state, torch.from_numpy(block.copy())).numpy()
        return block * (1 - mix) + wet[:, : block.shape[1]] * mix

    # The model has a short receptive field; 0.5 s of context hides seams.
    return process_audio(ctx, "deepfilter", fn, block_seconds=15.0, context_seconds=0.5)


TOOL = Tool(
    id="deepfilter",
    label="Neural voice cleanup",
    group="clean",
    blurb="DeepFilterNet 3: removes background noise and room echo from speech with a neural network.",
    run=run,
    requires=["df", "torch"],
    install="pip install deepfilternet   # pulls PyTorch",
    credits="DeepFilterNet (MIT/Apache-2.0, Schröter et al.)",
    params=[Param("mix", "Mix", "number", 1.0, min=0, max=1, step=0.05, help="Blend some original back in if it sounds too processed.")],
)
