"""
Where is someone talking? Silero VAD — a small neural voice-activity model
(the one bundled with faster-whisper, run through ONNX Runtime on the CPU).

Unlike a level threshold it ignores music beds, fans and breaths, so a jump
cut driven by it removes the gaps *between words* even over background noise.
"""
from __future__ import annotations

from ..context import Context
from ..media import decode_all
from ..registry import Param, Tool


def run(ctx: Context) -> dict:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    p = ctx.params
    ctx.progress(0, "decode")
    audio = decode_all(ctx, ctx.input, sr=16000, channels=1, excerpt=ctx.excerpt)[0]
    offset = ctx.excerpt[0] if ctx.excerpt else 0.0
    ctx.progress(0.3, "detect speech")
    spans = get_speech_timestamps(
        audio,
        VadOptions(
            threshold=p["threshold"],
            min_silence_duration_ms=int(p["min_silence_ms"]),
            min_speech_duration_ms=int(p["min_speech_ms"]),
            speech_pad_ms=0,
        ),
    )
    speech = [[round(s["start"] / 16000 + offset, 3), round(s["end"] / 16000 + offset, 3)] for s in spans]
    talk = sum(b - a for a, b in speech)
    duration = len(audio) / 16000
    ctx.log(f"{len(speech)} speech spans, {talk:.1f}s of {duration:.1f}s is speech.")
    return {"data": {"speech": speech, "duration": round(duration, 3), "offset": offset}}


TOOL = Tool(
    id="vad",
    label="Find speech",
    group="speech",
    blurb="Neural voice-activity detection. Drives the Desk's speech-aware jump cut; ignores music, hum and breaths.",
    run=run,
    output="data",
    requires=["faster_whisper", "onnxruntime"],
    install="pip install faster-whisper",
    credits="Silero VAD (MIT) via faster-whisper",
    params=[
        Param("threshold", "Sensitivity", "number", 0.5, min=0.1, max=0.9, step=0.05,
              help="Probability above which audio counts as speech. Lower catches whispers; higher ignores more noise."),
        Param("min_silence_ms", "Gap longer than", "number", 400, min=100, max=3000, step=50, unit="ms"),
        Param("min_speech_ms", "Ignore blips shorter than", "number", 200, min=0, max=2000, step=50, unit="ms"),
    ],
)
