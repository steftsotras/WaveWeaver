"""
Pick a device for CTranslate2 (Whisper, NLLB).

"Is there a GPU" isn't the real question — CTranslate2 also needs cuBLAS
and cuDNN DLLs that match, and kernels for the card's architecture. A
missing cuDNN doesn't raise, it aborts the process. So the probe runs a real
1-second transcription in a *child* process, once, and remembers the answer
per CTranslate2 version. If the child dies, we use the CPU.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

from .config import MODELS_DIR

_lock = threading.Lock()
_device: tuple[str, str] | None = None


def add_nvidia_dll_dirs() -> None:
    """pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 ship DLLs that aren't on PATH."""
    for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime"):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        if not spec or not spec.submodule_search_locations:
            continue
        for root in spec.submodule_search_locations:
            for sub in ("bin", "lib"):
                d = Path(root) / sub
                if d.is_dir():
                    os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
                    if hasattr(os, "add_dll_directory"):
                        os.add_dll_directory(str(d))


_PROBE = r"""
import sys, numpy as np
sys.path.insert(0, sys.argv[1])
from engine.gpu import add_nvidia_dll_dirs
add_nvidia_dll_dirs()
from faster_whisper import WhisperModel
m = WhisperModel("tiny", device="cuda", compute_type="float16", download_root=sys.argv[2])
segs, _ = m.transcribe(np.zeros(16000, dtype=np.float32), language="en")
list(segs)
print("CUDA_OK")
"""


def whisper_device(log=print) -> tuple[str, str]:
    """(device, compute_type) for CTranslate2 models."""
    global _device
    with _lock:
        if _device:
            return _device
        forced = os.environ.get("WAVEWEAVER_DEVICE")
        if forced in ("cpu", "cuda"):
            _device = (forced, "float16" if forced == "cuda" else "int8")
            return _device
        import ctranslate2

        cache = MODELS_DIR / "device.json"
        key = ctranslate2.__version__
        try:
            saved = json.loads(cache.read_text())
            if saved.get("ct2") == key:
                _device = tuple(saved["device"])  # type: ignore[assignment]
                return _device  # type: ignore[return-value]
        except (OSError, ValueError, KeyError):
            pass

        device = ("cpu", "int8")
        if ctranslate2.get_cuda_device_count() > 0:
            log("Probing GPU for Whisper (one-time, downloads the tiny model)…")
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            try:
                r = subprocess.run(
                    [sys.executable, "-c", _PROBE, str(Path(__file__).resolve().parents[1]), str(MODELS_DIR / "whisper")],
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
                if "CUDA_OK" in r.stdout:
                    device = ("cuda", "float16")
                else:
                    log(f"GPU probe failed, using CPU: {(r.stderr or r.stdout).strip()[-300:]}")
            except subprocess.TimeoutExpired:
                log("GPU probe timed out, using CPU.")
        _device = device
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"ct2": key, "device": list(device)}))
        return device


def current() -> tuple[str, str] | None:
    return _device


if sys.platform == "win32":
    add_nvidia_dll_dirs()
