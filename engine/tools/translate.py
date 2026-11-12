"""
Translate caption cues, keeping every cue's timing.

Two providers:

  claude  Claude via the Anthropic API. Reads whole scenes at once, so a
          sentence split across three cues is translated as one sentence,
          names stay consistent and subtitles stay short enough to read.
          Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
  nllb    Meta's NLLB-200 (1.3B, CTranslate2) — fully offline, 200
          languages, GPU or CPU. Weights are CC-BY-NC-4.0: non-commercial.
          `python -m engine.download nllb` fetches them.

Input payload: {"cues": [{"id", "text"}], "source": "en"}.
Output data:   {"cues": [{"id", "text"}], "provider", "target"}.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from ..context import Context
from ..registry import Param, Tool
from .transcribe import LANGUAGES

LANG_NAMES = dict(LANGUAGES)

# ISO 639-1 → NLLB/Flores-200 codes for the languages the studio offers.
NLLB_CODES = {
    "en": "eng_Latn", "el": "ell_Grek", "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "nl": "nld_Latn", "pl": "pol_Latn", "tr": "tur_Latn",
    "ru": "rus_Cyrl", "uk": "ukr_Cyrl", "ar": "arb_Arab", "he": "heb_Hebr", "hi": "hin_Deva",
    "ja": "jpn_Jpan", "ko": "kor_Hang", "zh": "zho_Hans", "sv": "swe_Latn", "ro": "ron_Latn",
    "bg": "bul_Cyrl", "cs": "ces_Latn", "hu": "hun_Latn", "fi": "fin_Latn",
}

TARGETS = [(k, v) for k, v in LANGUAGES if k != "auto"]


# --- readiness -------------------------------------------------------------

def _claude_ready() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    # `ant auth login` stores a profile the SDK picks up with no env var.
    return (Path.home() / ".config" / "anthropic").is_dir()


def _nllb_dir() -> Path:
    from ..download import NLLB_DIR

    return NLLB_DIR


def _nllb_ready() -> bool:
    return (_nllb_dir() / "model.bin").is_file()


def _check() -> str | None:
    if _claude_ready() or _nllb_ready():
        return None
    return (
        "No translation provider. Either set ANTHROPIC_API_KEY (Claude), or install "
        "NLLB-200 from Setup (`python -m engine.download nllb`) for offline translation."
    )


# --- Claude ----------------------------------------------------------------

BATCH = 80
CONTEXT = 8

SYSTEM = """You translate subtitles.

You receive caption cues as JSON, each with an id and the text shown on screen at that moment. Return a translation for every id, in the same order, with the same ids.

- Translate meaning, not words: natural spoken {target}, the way a professional subtitler would write it.
- A sentence often runs across several cues. Read them together, translate the whole sentence, then divide it back so each cue carries the part spoken during its own time. Never merge, drop or add cues.
- Keep each cue about as long as the original or shorter; viewers have only a few seconds to read it.
- Keep names, numbers, brands and on-screen tags like [music] or (laughs) — translate the descriptive tags.
- Keep line breaks only where the original has them.
"""


def _translate_claude(ctx: Context, cues: list[dict], source: str, target: str) -> list[dict]:
    import anthropic
    from pydantic import BaseModel

    class Cue(BaseModel):
        id: str
        text: str

    class Batch(BaseModel):
        cues: list[Cue]

    client = anthropic.Anthropic()
    target_name = LANG_NAMES.get(target, target)
    source_name = LANG_NAMES.get(source, "the source language")
    out: dict[str, str] = {}

    for i in range(0, len(cues), BATCH):
        ctx.check()
        chunk = cues[i : i + BATCH]
        before = cues[max(0, i - CONTEXT) : i]
        context = "\n".join(f"{c['text']}  →  {out.get(c['id'], '')}" for c in before)
        prompt = (
            (f"Earlier cues, already translated (for continuity only — don't return these):\n{context}\n\n" if context else "")
            + f"Translate these cues from {source_name} into {target_name}:\n"
            + Batch(cues=[Cue(id=c["id"], text=c["text"]) for c in chunk]).model_dump_json()
        )
        response = client.beta.messages.parse(
            model="claude-opus-5-5",
            max_tokens=16000,
            # Medium is Opus 5.5's default; subtitle translation doesn't need
            # deep reasoning, and lower effort keeps each batch quick.
            output_config={"effort": "medium"},
            # If a batch trips a safety classifier, retry it on the fallback
            # model the API picks instead of failing the whole job.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM.format(target=target_name),
            messages=[{"role": "user", "content": prompt}],
            output_format=Batch,
        )
        if response.stop_reason == "refusal":
            raise RuntimeError(f"Claude declined to translate cues {i + 1}–{i + len(chunk)}.")
        parsed = response.parsed_output
        if parsed is None:
            raise RuntimeError(f"No translation came back for cues {i + 1}–{i + len(chunk)} ({response.stop_reason}).")
        for c in parsed.cues:
            out[c.id] = c.text
        missing = [c["id"] for c in chunk if c["id"] not in out]
        if missing:
            ctx.log(f"warning: {len(missing)} cues came back untranslated; kept the original text.")
        ctx.progress(min(1.0, (i + len(chunk)) / len(cues)))
        ctx.log(f"Translated {min(len(cues), i + len(chunk))}/{len(cues)} cues")
    return [{"id": c["id"], "text": out.get(c["id"], c["text"])} for c in cues]


# --- NLLB ------------------------------------------------------------------

_nllb = None
_nllb_lock = threading.Lock()

_SENTENCE_END = re.compile(r"[.!?…。！？]['\"”’)\]]*$")


def _load_nllb(log):
    global _nllb
    with _nllb_lock:
        if _nllb is None:
            import ctranslate2
            from tokenizers import Tokenizer

            from ..gpu import whisper_device

            device, _ = whisper_device(log)
            d = _nllb_dir()
            log(f"Loading NLLB-200 on {device}…")
            translator = ctranslate2.Translator(str(d), device=device, compute_type="int8_float16" if device == "cuda" else "int8")
            _nllb = (translator, Tokenizer.from_file(str(d / "tokenizer.json")))
        return _nllb


def _sentences(cues: list[dict]) -> list[list[int]]:
    """
    Group cue indexes into sentences. NLLB translates one sentence at a
    time; feeding it the half-sentence on each cue produces nonsense.
    """
    groups, cur = [], []
    for i, c in enumerate(cues):
        cur.append(i)
        if _SENTENCE_END.search(c["text"].strip()) or len(cur) >= 6:
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def _split(text: str, weights: list[int]) -> list[str]:
    """Divide a translated sentence back across cues, in proportion to the source text, on word boundaries."""
    if len(weights) == 1:
        return [text]
    words = text.split()
    total = sum(weights) or 1
    parts, start = [], 0
    for k, w in enumerate(weights[:-1]):
        want = round(len(words) * sum(weights[: k + 1]) / total)
        want = max(start + 1, min(want, len(words) - (len(weights) - k - 1)))
        parts.append(" ".join(words[start:want]))
        start = want
    parts.append(" ".join(words[start:]))
    return parts


def _translate_nllb(ctx: Context, cues: list[dict], source: str, target: str) -> list[dict]:
    if source not in NLLB_CODES or target not in NLLB_CODES:
        raise ValueError(f"NLLB here supports: {', '.join(sorted(NLLB_CODES))}")
    translator, tok = _load_nllb(ctx.log)
    src, tgt = NLLB_CODES[source], NLLB_CODES[target]
    groups = _sentences(cues)
    out: list[str] = [""] * len(cues)

    for g0 in range(0, len(groups), 32):
        ctx.check()
        batch = groups[g0 : g0 + 32]
        texts = [" ".join(cues[i]["text"].strip() for i in g) for g in batch]
        # NLLB expects: <src_lang> tokens… </s>, and decodes after a <tgt_lang> prefix.
        source_tokens = [[src, *tok.encode(t, add_special_tokens=False).tokens, "</s>"] for t in texts]
        results = translator.translate_batch(source_tokens, target_prefix=[[tgt]] * len(batch), beam_size=4, max_batch_size=16)
        for g, r in zip(batch, results):
            ids = [tok.token_to_id(t) for t in r.hypotheses[0][1:]]
            sentence = tok.decode([i for i in ids if i is not None], skip_special_tokens=True).strip()
            for i, piece in zip(g, _split(sentence, [max(1, len(cues[i]["text"])) for i in g])):
                out[i] = piece
        done = sum(len(g) for g in groups[: g0 + len(batch)])
        ctx.progress(done / len(cues))
        ctx.log(f"Translated {done}/{len(cues)} cues")
    return [{"id": c["id"], "text": t or c["text"]} for c, t in zip(cues, out)]


# --- tool ------------------------------------------------------------------

def run(ctx: Context) -> dict:
    payload = ctx.payload or {}
    cues = [{"id": str(c["id"]), "text": str(c.get("text", ""))} for c in payload.get("cues", []) if str(c.get("text", "")).strip()]
    if not cues:
        raise ValueError("No caption text to translate.")
    source = ctx.params["source"] if ctx.params["source"] != "auto" else payload.get("source", "en")
    target = ctx.params["target"]
    if source == target:
        raise ValueError("Source and target language are the same.")

    provider = ctx.params["provider"]
    if provider == "auto":
        provider = "claude" if _claude_ready() else "nllb"
    if provider == "claude" and not _claude_ready():
        raise ValueError("Claude needs ANTHROPIC_API_KEY (or `ant auth login`).")
    if provider == "nllb" and not _nllb_ready():
        raise ValueError("NLLB weights missing: run `python -m engine.download nllb`.")

    ctx.progress(0, f"translate · {provider}")
    ctx.log(f"{len(cues)} cues, {source} → {target}, via {provider}")
    translated = (_translate_claude if provider == "claude" else _translate_nllb)(ctx, cues, source, target)
    return {"data": {"cues": translated, "provider": provider, "source": source, "target": target}}


TOOL = Tool(
    id="translate",
    label="Translate captions",
    group="speech",
    blurb="Translate subtitles cue-by-cue with timing kept. Claude reads whole scenes; NLLB-200 runs fully offline.",
    run=run,
    inputs="captions",
    output="data",
    requires=["ctranslate2", "tokenizers"],
    install="pip install ctranslate2 tokenizers anthropic",
    check=_check,
    previewable=False,
    credits="Claude (Anthropic API) · NLLB-200 (Meta, CC-BY-NC-4.0) on CTranslate2",
    params=[
        Param("target", "Into", "select", "en", options=TARGETS),
        Param("source", "From", "select", "auto", options=LANGUAGES),
        Param("provider", "Engine", "select", "auto", options=[
            ("auto", "Best available"), ("claude", "Claude"), ("nllb", "NLLB-200 (offline)"),
        ], help="Auto uses Claude when an API key is set, otherwise NLLB."),
    ],
)
