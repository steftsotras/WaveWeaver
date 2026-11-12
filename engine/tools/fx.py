"""
Space and character effects on Spotify's pedalboard (JUCE DSP under the
hood): reverb, delay, chorus, phaser, drive, bitcrush, and Rubber Band pitch
shifting. These are the things ffmpeg either doesn't have (a real reverb) or
does poorly — EQ, compression and limiting stay in the studio's one-pass
weave.
"""
from __future__ import annotations

import numpy as np

from ..config import SAMPLE_RATE
from ..context import Context
from ..registry import Param, Tool
from ._common import process_audio


def build_board(p: dict):
    import pedalboard as pb

    chain = []
    if p["low_cut"] > 20:
        chain.append(pb.HighpassFilter(cutoff_frequency_hz=p["low_cut"]))
    if p["high_cut"] < 20000:
        chain.append(pb.LowpassFilter(cutoff_frequency_hz=p["high_cut"]))
    if p["pitch"]:
        chain.append(pb.PitchShift(semitones=p["pitch"]))
    if p["drive"] > 0:
        chain.append(pb.Distortion(drive_db=p["drive"]))
        chain.append(pb.Gain(gain_db=-p["drive"] * 0.6))
    if p["bits"] > 0:
        chain.append(pb.Bitcrush(bit_depth=p["bits"]))
    if p["chorus"] > 0:
        chain.append(pb.Chorus(rate_hz=1.2, depth=0.3, mix=p["chorus"]))
    if p["phaser"] > 0:
        chain.append(pb.Phaser(rate_hz=0.6, depth=0.6, mix=p["phaser"]))
    if p["delay"] > 0:
        chain.append(pb.Delay(delay_seconds=p["delay_ms"] / 1000, feedback=p["feedback"], mix=p["delay"]))
    if p["reverb"] > 0:
        chain.append(pb.Reverb(room_size=p["room"], damping=0.5, wet_level=p["reverb"], dry_level=1 - p["reverb"] * 0.5, width=1.0))
    return pb.Pedalboard(chain)


def run(ctx: Context) -> dict:
    board = build_board(ctx.params)
    if len(board) == 0:
        raise ValueError("Every effect is off — turn something up.")
    ctx.log("Chain: " + " → ".join(type(x).__name__ for x in board))

    def fn(block: np.ndarray) -> np.ndarray:
        # reset=False carries reverb tails and delay lines across blocks.
        return board(block, SAMPLE_RATE, reset=False)

    return process_audio(ctx, "fx", fn)


TOOL = Tool(
    id="fx",
    label="Space & character",
    group="fx",
    blurb="Reverb, delay, chorus, phaser, drive, bitcrush and studio-grade pitch shifting.",
    run=run,
    requires=["pedalboard"],
    install="pip install pedalboard",
    credits="pedalboard (GPLv3, Spotify) · JUCE · Rubber Band",
    params=[
        Param("reverb", "Reverb", "number", 0.0, min=0, max=1, step=0.05),
        Param("room", "Room size", "number", 0.5, min=0, max=1, step=0.05),
        Param("delay", "Delay", "number", 0.0, min=0, max=1, step=0.05),
        Param("delay_ms", "Delay time", "number", 250, min=20, max=1500, step=10, unit="ms"),
        Param("feedback", "Feedback", "number", 0.3, min=0, max=0.9, step=0.05),
        Param("chorus", "Chorus", "number", 0.0, min=0, max=1, step=0.05),
        Param("phaser", "Phaser", "number", 0.0, min=0, max=1, step=0.05),
        Param("drive", "Drive", "number", 0.0, min=0, max=40, step=1, unit="dB"),
        Param("bits", "Bitcrush", "number", 0, min=0, max=16, step=1, unit="bit", help="0 = off."),
        Param("pitch", "Pitch", "number", 0, min=-12, max=12, step=1, unit="st"),
        Param("low_cut", "Low cut", "number", 20, min=20, max=2000, step=10, unit="Hz"),
        Param("high_cut", "High cut", "number", 20000, min=1000, max=20000, step=100, unit="Hz"),
    ],
    presets={
        "Small room": {"reverb": 0.25, "room": 0.3},
        "Concert hall": {"reverb": 0.45, "room": 0.9},
        "Slapback": {"delay": 0.35, "delay_ms": 110, "feedback": 0.1},
        "Telephone": {"low_cut": 400, "high_cut": 3400, "drive": 8},
        "AM radio": {"low_cut": 250, "high_cut": 4500, "drive": 4, "bits": 10},
        "Lo-fi tape": {"high_cut": 7000, "chorus": 0.2, "drive": 3, "bits": 12},
        "Dreamy": {"reverb": 0.6, "room": 0.95, "chorus": 0.35, "delay": 0.25, "delay_ms": 380, "feedback": 0.45},
        "Chipmunk": {"pitch": 7},
        "Monster": {"pitch": -7, "drive": 6},
    },
)
