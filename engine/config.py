"""
Where things live. The engine and the studio share one media root, so a
file the studio uploads is a file the engine can read, and an engine render
shows up in the studio's Renders page with no copying.
"""
import os
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ENGINE_DIR.parent

# Same variable, same default as the studio: studio/media in this repo.
MEDIA_ROOT = Path(
    os.environ.get("WAVEWEAVER_MEDIA_DIR")
    or BACKEND_DIR / "studio" / "media"
).resolve()

CACHE_DIR = MEDIA_ROOT / ".cache"
PREVIEW_DIR = CACHE_DIR / "previews"

# Model weights (Whisper, NLLB …). Big, downloaded once, never committed.
MODELS_DIR = Path(os.environ.get("WAVEWEAVER_MODELS_DIR") or BACKEND_DIR / "models").resolve()

# Extra plugin folder: drop a .py file declaring TOOL = Tool(...) here.
PLUGINS_DIR = Path(os.environ.get("WAVEWEAVER_PLUGINS") or BACKEND_DIR / "plugins").resolve()

HOST = os.environ.get("WAVEWEAVER_ENGINE_HOST", "127.0.0.1")
PORT = int(os.environ.get("WAVEWEAVER_ENGINE_PORT", "8765"))

# Shared with the studio that starts us. Unset for an engine run by hand.
TOKEN = os.environ.get("WAVEWEAVER_ENGINE_TOKEN", "")

# Two at once: one long render shouldn't block a quick preview.
WORKERS = max(1, int(os.environ.get("WAVEWEAVER_ENGINE_WORKERS", "2")))

# Processing format. Everything is decoded to 48 kHz float32, the same rate
# the studio's filter graphs use, so engine and ffmpeg output line up.
SAMPLE_RATE = 48000
