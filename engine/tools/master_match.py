"""
Reference mastering with Matchering: give it a finished track you like and
it matches your file's RMS, frequency response, peak level and stereo width
to it, then runs its own brickwall limiter. The open-source answer to
"make mine sound like that".
"""
from __future__ import annotations

from ..context import Context
from ..media import Encoder, decode_all
from ..paths import resolve_ref
from ..registry import Param, Tool
from ._common import tmp_path


def run(ctx: Context) -> dict:
    import matchering as mg
    import soundfile as sf

    p = ctx.params
    if not p["reference"]:
        raise ValueError("Pick a reference track.")
    ref_path = resolve_ref(p["reference"])
    if not ref_path.is_file():
        raise ValueError("The reference file is gone.")

    # Matchering reads WAV/FLAC via soundfile; decode both sides with ffmpeg
    # so any input works (MP3, M4A, the audio of a video …).
    ctx.progress(0, "decode")
    target_wav = tmp_path(ctx, "target.wav")
    reference_wav = tmp_path(ctx, "reference.wav")
    sf.write(target_wav, decode_all(ctx, ctx.input, excerpt=ctx.excerpt).T, 48000, subtype="FLOAT")
    sf.write(reference_wav, decode_all(ctx, ref_path).T, 48000, subtype="FLOAT")
    ctx.check()

    mg.log(warning_handler=lambda m: ctx.log(f"warning: {m}"), info_handler=ctx.log)
    ctx.progress(None, "match")
    mastered = tmp_path(ctx, "mastered.wav")
    mg.process(
        target=str(target_wav),
        reference=str(reference_wav),
        results=[mg.Result(str(mastered), subtype="FLOAT", use_limiter=p["limiter"], normalize=p["limiter"])],
    )
    ctx.check()

    # Back through the encoder so renders land in the right format (and a
    # video input keeps its picture).
    ctx.progress(0.9, "encode")
    data, sr = sf.read(mastered, dtype="float32", always_2d=True)
    out = ctx.output_path("matched")
    part = ctx.part_path(out)
    with Encoder(ctx, part, sr=sr, video_from=ctx.video_source(out)) as enc:
        enc.write(data.T)
    if part != out:
        ctx.finalize(part, out)
    ctx.log(f"Wrote {out.name}")
    return {"outputs": [str(out)]}


TOOL = Tool(
    id="match",
    label="Reference master",
    group="master",
    blurb="Match loudness, tone and width to a reference track you like. Automatic mastering that's honest about what it copies.",
    run=run,
    requires=["matchering", "soundfile"],
    install="pip install matchering",
    credits="Matchering 2 (GPLv3, Sergree)",
    params=[
        Param("reference", "Reference track", "media", None, help="A finished, commercially mastered song in the style you want."),
        Param("limiter", "Brickwall limiter", "bool", True, help="Off = matched but unlimited, so you can master further."),
    ],
)
