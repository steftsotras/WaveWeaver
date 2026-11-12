"""
Fetch model weights ahead of time.

    python -m engine.download nllb        # offline translation, ~1.4 GB
    python -m engine.download whisper     # large-v3-turbo, ~1.6 GB, the GPU default (otherwise fetched on first use)
    python -m engine.download whisper-small  # small, ~480 MB, the CPU default

Everything lands in MODELS_DIR (backend/models by default).
"""
from __future__ import annotations

import sys

from .config import MODELS_DIR

# Published by OpenNMT, the CTranslate2 maintainers: Meta's NLLB-200
# distilled 1.3B, int8-quantised. Weights are CC-BY-NC-4.0 (non-commercial).
NLLB_REPO = "OpenNMT/nllb-200-distilled-1.3B-ct2-int8"
NLLB_DIR = MODELS_DIR / "nllb-200-1.3B"


def nllb() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(NLLB_REPO, local_dir=NLLB_DIR, allow_patterns=["*.json", "model.bin"])
    print(f"NLLB ready in {NLLB_DIR}")


def whisper() -> None:
    from faster_whisper.utils import download_model

    path = download_model("large-v3-turbo", cache_dir=str(MODELS_DIR / "whisper"))
    print(f"Whisper turbo ready in {path}")


def whisper_small() -> None:
    from faster_whisper.utils import download_model

    path = download_model("small", cache_dir=str(MODELS_DIR / "whisper"))
    print(f"Whisper small ready in {path}")


if __name__ == "__main__":
    what = sys.argv[1:] or ["nllb"]
    for name in what:
        {"nllb": nllb, "whisper": whisper, "whisper-small": whisper_small}[name]()
