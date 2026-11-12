"""
Source separation with Meta's Demucs (Hybrid Transformer v4): pull the
voice out of a song, or the music out from under a voice. Optional — it
needs PyTorch, so it shows as "unavailable" until you install it:

    pip install demucs          (CPU)
    pip install torch --index-url https://download.pytorch.org/whl/cu128 && pip install demucs   (GPU)
"""
from __future__ import annotations

import shutil
import subprocess
import sys

import soundfile as sf

from ..context import Context
from ..media import Encoder, decode_all
from ..registry import Param, Tool
from ._common import tmp_path


def run(ctx: Context) -> dict:
    p = ctx.params
    src = tmp_path(ctx, "input.wav")
    sf.write(src, decode_all(ctx, ctx.input, sr=44100, excerpt=ctx.excerpt).T, 44100, subtype="FLOAT")
    out_dir = tmp_path(ctx, "demucs")
    ctx.progress(None, f"separate · {p['model']}")
    args = [sys.executable, "-m", "demucs", "-n", p["model"], "-o", str(out_dir), "--float32"]
    if p["stem"] != "all":
        args += ["--two-stems", p["stem"]]
    proc = ctx.spawn([*args, str(src)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for line in proc.stdout:  # type: ignore[union-attr]
        ctx.check()
        text = line.decode("utf-8", "replace").strip()
        if text and "%" not in text:
            ctx.log(text)
    if proc.wait() != 0:
        raise RuntimeError("demucs failed (see log)")

    stems = sorted((out_dir / p["model"] / "input").glob("*.wav"))
    keep = [s for s in stems if s.stem == (p["stem"] if p["stem"] != "all" else s.stem)]
    if ctx.out_mode == "preview":
        keep = keep[:1]
    outputs = []
    for stem in keep:
        data, sr = sf.read(stem, dtype="float32", always_2d=True)
        out = ctx.output_path(f"stem-{stem.stem}", "wav" if ctx.out_mode == "preview" else (ctx.out_format if ctx.out_format != "same" else "wav"))
        with Encoder(ctx, out, sr=sr) as enc:
            enc.write(data.T)
        outputs.append(str(out))
        ctx.log(f"Wrote {out.name}")
    shutil.rmtree(out_dir, ignore_errors=True)
    return {"outputs": outputs}


TOOL = Tool(
    id="stems",
    label="Separate stems",
    group="clean",
    blurb="Split vocals from music (or drums, bass, other) with Demucs v4. Rescue dialogue from a noisy bed, or make a karaoke track.",
    run=run,
    requires=["demucs", "torch", "soundfile"],
    install="pip install demucs   # pulls PyTorch; see engine/README.md for the CUDA build",
    credits="Demucs (MIT, Meta AI)",
    params=[
        Param("stem", "Stem", "select", "vocals", options=[
            ("vocals", "Vocals + rest"), ("drums", "Drums + rest"), ("bass", "Bass + rest"), ("all", "All four"),
        ]),
        Param("model", "Model", "select", "htdemucs", options=[("htdemucs", "HT Demucs"), ("htdemucs_ft", "HT Demucs fine-tuned (slower)")]),
    ],
)
