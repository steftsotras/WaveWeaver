"""
An example user plugin: everything a plugin needs, in one file.

Files in this folder are loaded at engine start (and on Rescan). Copy this
one, change the id, params and run(), and it appears in the studio's Lab
with a generated form, previews and full renders.
"""
import numpy as np

from engine.registry import Param, Tool
from engine.tools._common import process_audio


def run(ctx):
    from scipy.signal import butter, sosfilt  # heavy imports inside run()

    sos = butter(4, [ctx.params["low"], ctx.params["high"]], btype="band", fs=48000, output="sos")
    # Carry the filter's state from block to block, or every block boundary clicks.
    state = np.zeros((sos.shape[0], 2, 2))

    def fn(block: np.ndarray) -> np.ndarray:  # (channels, frames) float32 @ 48 kHz
        nonlocal state
        out, state = sosfilt(sos, block, axis=1, zi=state)
        return out.astype(np.float32)

    return process_audio(ctx, "telephone", fn)


TOOL = Tool(
    id="telephone",
    label="Telephone",
    group="fx",
    blurb="Band-limit to sound like a phone call. (An example plugin — see plugins/telephone.py.)",
    run=run,
    requires=["scipy"],
    params=[
        Param("low", "Low", "number", 300, min=100, max=1000, step=10, unit="Hz"),
        Param("high", "High", "number", 3400, min=2000, max=8000, step=100, unit="Hz"),
    ],
)
