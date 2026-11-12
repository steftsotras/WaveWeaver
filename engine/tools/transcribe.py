"""
Speech → timed text with faster-whisper (OpenAI Whisper on CTranslate2:
same accuracy as the reference implementation, ~4x faster, a fraction of the
memory). Word-level timestamps are kept so the studio can re-flow captions
into proper subtitle lines and cut on exact word boundaries.
"""
from __future__ import annotations

import threading

from ..config import MODELS_DIR
from ..context import Context
from ..media import decode_all
from ..registry import Param, Tool
from ._common import fmt_time

LANGUAGES = [
    ("auto", "Auto-detect"), ("en", "English"), ("el", "Greek"), ("es", "Spanish"), ("fr", "French"),
    ("de", "German"), ("it", "Italian"), ("pt", "Portuguese"), ("nl", "Dutch"), ("pl", "Polish"),
    ("tr", "Turkish"), ("ru", "Russian"), ("uk", "Ukrainian"), ("ar", "Arabic"), ("he", "Hebrew"),
    ("hi", "Hindi"), ("ja", "Japanese"), ("ko", "Korean"), ("zh", "Chinese"), ("sv", "Swedish"),
    ("ro", "Romanian"), ("bg", "Bulgarian"), ("cs", "Czech"), ("hu", "Hungarian"), ("fi", "Finnish"),
]

_models: dict[tuple, object] = {}
_model_lock = threading.Lock()
_run_lock = threading.Lock()


def _load(name: str, device: str, compute: str, log):
    from faster_whisper import WhisperModel

    key = (name, device, compute)
    with _model_lock:
        if key not in _models:
            log(f"Loading Whisper {name} on {device} ({compute}) — first use downloads the weights…")
            _models[key] = WhisperModel(name, device=device, compute_type=compute, download_root=str(MODELS_DIR / "whisper"))
        return _models[key]


def run(ctx: Context) -> dict:
    from ..gpu import whisper_device

    p = ctx.params
    ctx.progress(None, "device")
    device, compute = whisper_device(ctx.log)
    name = p["model"] if p["model"] != "auto" else ("large-v3-turbo" if device == "cuda" else "small")
    model = _load(name, device, compute, ctx.log)

    ctx.progress(0, "decode")
    audio = decode_all(ctx, ctx.input, sr=16000, channels=1, excerpt=ctx.excerpt)[0]
    duration = len(audio) / 16000
    offset = ctx.excerpt[0] if ctx.excerpt else 0.0

    ctx.progress(0, f"transcribe · {name} · {device}")
    # One transcription at a time per process: the model is shared, and two
    # jobs fighting over the GPU are slower than two in a row.
    with _run_lock:
        segments, info = model.transcribe(
            audio,
            language=None if p["language"] == "auto" else p["language"],
            task=p["task"],
            vad_filter=p["vad"],
            word_timestamps=True,
            initial_prompt=p["prompt"] or None,
            beam_size=5,
            # Long files drift into repetition loops when every window is
            # conditioned on the previous one; captions don't need it.
            condition_on_previous_text=False,
        )
        ctx.log(f"Language: {info.language} ({info.language_probability:.0%})")
        out = []
        for seg in segments:
            ctx.check()
            out.append({
                "start": round(seg.start + offset, 3),
                "end": round(seg.end + offset, 3),
                "text": seg.text.strip(),
                "words": [
                    {"w": w.word, "s": round(w.start + offset, 3), "e": round(w.end + offset, 3), "p": round(w.probability, 3)}
                    for w in (seg.words or [])
                ],
            })
            ctx.log(f"[{fmt_time(seg.start + offset)}] {seg.text.strip()}")
            if duration:
                ctx.progress(seg.end / duration)

    return {
        "data": {
            "language": "en" if p["task"] == "translate" else info.language,
            "detectedLanguage": info.language,
            "probability": round(info.language_probability, 3),
            "duration": round(duration, 3),
            "offset": offset,
            "model": name,
            "device": device,
            "task": p["task"],
            "segments": out,
        }
    }


TOOL = Tool(
    id="transcribe",
    label="Transcribe",
    group="speech",
    blurb="Whisper speech recognition with word-level timing. Any of ~100 languages; can also translate straight to English.",
    run=run,
    output="data",
    requires=["faster_whisper"],
    install="pip install faster-whisper",
    credits="faster-whisper (MIT) · OpenAI Whisper weights (MIT)",
    params=[
        Param("model", "Model", "select", "auto", options=[
            ("auto", "Auto"), ("tiny", "Tiny"), ("base", "Base"), ("small", "Small"),
            ("medium", "Medium"), ("large-v3-turbo", "Turbo"), ("large-v3", "Large v3"),
        ], help="Auto = Turbo on a GPU, Small on CPU. Bigger is more accurate and slower; weights download on first use."),
        Param("language", "Spoken language", "select", "auto", options=LANGUAGES),
        Param("task", "Task", "select", "transcribe", options=[("transcribe", "Transcribe"), ("translate", "Translate → English")]),
        Param("vad", "Skip silence (Silero VAD)", "bool", True, help="Prevents Whisper hallucinating text over music and silence."),
        Param("prompt", "Vocabulary hint", "text", "", help="Names and jargon to spell right, e.g. 'WaveWeaver, ffmpeg, Kubernetes'."),
    ],
)
