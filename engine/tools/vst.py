"""
Run any installed VST3 effect over a file — FabFilter Pro-Q, Pro-L, Neural
DSP amps, anything. pedalboard hosts the plugin headlessly; settings come
from a saved state you made in the plugin's own window (POST /vst/editor
opens it on this machine and saves what you dial in when you close it).

That's the point of the engine: WaveWeaver doesn't have to reimplement your
favourite processor — it can borrow it.
"""
from __future__ import annotations

import os
import re
import sys
import threading
from pathlib import Path

import numpy as np

from ..config import MEDIA_ROOT, SAMPLE_RATE
from ..context import Context
from ..registry import Param, Tool
from ._common import process_audio

STATE_DIR = MEDIA_ROOT / "presets" / "vst"
# Every call into the plugin is exactly this many samples. Hosts in a DAW
# never vary the block size mid-stream either, and some plugins assume it.
HOST_BLOCK = 4096


def _search_dirs() -> list[Path]:
    dirs = [Path(p) for p in os.environ.get("WAVEWEAVER_VST3_PATH", "").split(os.pathsep) if p]
    if sys.platform == "win32":
        dirs.append(Path(os.environ.get("COMMONPROGRAMFILES", r"C:\Program Files\Common Files")) / "VST3")
    elif sys.platform == "darwin":
        dirs += [Path("/Library/Audio/Plug-Ins/VST3"), Path.home() / "Library/Audio/Plug-Ins/VST3"]
    else:
        dirs += [Path("/usr/lib/vst3"), Path("/usr/local/lib/vst3"), Path.home() / ".vst3"]
    return dirs


_scan: list[tuple[str, str]] | None = None


def scan_plugins() -> list[tuple[str, str]]:
    """(path, name) for every .vst3 bundle under the standard folders. Not loaded — loading is slow."""
    global _scan
    if _scan is not None:
        return _scan
    found: dict[str, str] = {}
    for root in _search_dirs():
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            for d in list(dirnames):
                if d.lower().endswith(".vst3"):
                    found[str(Path(dirpath) / d)] = d[:-5]
                    dirnames.remove(d)  # don't descend into bundles
            for f in filenames:
                if f.lower().endswith(".vst3"):
                    found[str(Path(dirpath) / f)] = f[:-5]
    _scan = sorted(found.items(), key=lambda kv: kv[1].lower())
    return _scan


def _slug(s: str) -> str:
    return re.sub(r"[^\w.-]+", "-", s).strip("-")[:60] or "state"


def state_path(plugin_path: str, name: str) -> Path:
    return STATE_DIR / _slug(Path(plugin_path).stem) / f"{_slug(name)}.state"


def list_states() -> list[tuple[str, str]]:
    if not STATE_DIR.is_dir():
        return []
    return [(f"{d.name}/{f.stem}", f"{d.name} · {f.stem}") for d in sorted(STATE_DIR.iterdir()) if d.is_dir() for f in sorted(d.glob("*.state"))]


_load_lock = threading.Lock()


def _load(plugin_path: str, state: str | None):
    import pedalboard as pb

    valid = {p for p, _ in scan_plugins()}
    if plugin_path not in valid:
        raise ValueError("That plugin isn't in a VST3 folder WaveWeaver scanned.")
    with _load_lock:  # plugin loading isn't reliably thread-safe across hosts
        plugin = pb.load_plugin(plugin_path)
        # Measured with FabFilter Pro-C 2 / Pro-L 2 / Pro-DS: the first
        # instance a process loads outputs pure silence, forever — its setup
        # finishes only when JUCE's message loop runs again, which another
        # load does. A second, throwaway load makes the first one work.
        pb.load_plugin(plugin_path)
    if getattr(plugin, "is_instrument", False) and not getattr(plugin, "is_effect", True):
        raise ValueError(f"{Path(plugin_path).stem} is an instrument, not an effect.")
    if state:
        f = STATE_DIR / f"{state}.state"
        if not f.resolve().is_relative_to(STATE_DIR.resolve()) or not f.is_file():
            raise ValueError(f"No saved state {state}")
        plugin.raw_state = f.read_bytes()
    return plugin


def run(ctx: Context) -> dict:
    p = ctx.params
    if not p["plugin"]:
        raise ValueError("Pick a plugin.")
    plugin = _load(p["plugin"], p["state"] or None)
    ctx.log(f"Loaded {plugin.name} ({getattr(plugin, 'manufacturer_name', '')})")
    mix = p["mix"]
    # Plugins with lookahead (limiters, linear-phase EQ) output everything
    # `latency` samples late. Drop that many from the front of the wet
    # stream, pair what's left with the dry input sample-for-sample, and
    # drain the held-back tail with silence at the end — so the result lines
    # up with the original (and with the video) exactly.
    # A plugin only knows its real latency once it's prepared at our rate
    # (Pro-L 2 says 2875 samples cold, 3115 at 48 kHz). Prepare it with one
    # block of silence; that output is discarded, and the stream after it is
    # still exactly `latency` samples late, which the queues below remove.
    plugin.process(np.zeros((2, HOST_BLOCK), dtype=np.float32), SAMPLE_RATE, reset=False)
    latency = int(plugin.reported_latency_samples or 0)
    ctx.log(f"Plugin latency {latency} samples ({latency / SAMPLE_RATE * 1000:.1f} ms), compensated.")
    skip = latency
    wet_q = np.zeros((2, 0), dtype=np.float32)
    dry_q = np.zeros((2, 0), dtype=np.float32)

    def emit() -> np.ndarray:
        nonlocal wet_q, dry_q
        n = min(wet_q.shape[1], dry_q.shape[1])
        out = wet_q[:, :n] if mix >= 1 else dry_q[:, :n] * (1 - mix) + wet_q[:, :n] * mix
        wet_q, dry_q = wet_q[:, n:], dry_q[:, n:]
        return out

    def push(wet: np.ndarray) -> None:
        nonlocal wet_q, skip
        if skip:
            cut = min(skip, wet.shape[1])
            wet, skip = wet[:, cut:], skip - cut
        wet_q = np.concatenate([wet_q, wet], axis=1)

    pending = np.zeros((2, 0), dtype=np.float32)

    def host(block: np.ndarray) -> None:
        # Every call gets exactly HOST_BLOCK samples; leftovers wait for the
        # next block (or for flush, which pads them with silence).
        nonlocal pending
        pending = np.concatenate([pending, block], axis=1)
        while pending.shape[1] >= HOST_BLOCK:
            push(plugin.process(pending[:, :HOST_BLOCK], SAMPLE_RATE, reset=False))
            pending = pending[:, HOST_BLOCK:]

    def fn(block: np.ndarray) -> np.ndarray:
        nonlocal dry_q
        dry_q = np.concatenate([dry_q, block], axis=1)
        host(block)
        return emit()

    def flush() -> np.ndarray:
        need = pending.shape[1] + latency
        host(np.zeros((2, -need % HOST_BLOCK + latency), dtype=np.float32))
        return emit()

    return process_audio(ctx, _slug(Path(p["plugin"]).stem).lower(), fn, flush=flush)


def open_editor(plugin_path: str, state: str | None, save_as: str) -> dict:
    plugin = _load(plugin_path, state)
    plugin.show_editor()  # blocks until the window is closed
    out = state_path(plugin_path, save_as)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(plugin.raw_state)
    return {"state": f"{out.parent.name}/{out.stem}"}


def _check() -> str | None:
    return None if scan_plugins() else "No VST3 plugins found in the standard folders (set WAVEWEAVER_VST3_PATH)."


TOOL = Tool(
    id="vst",
    label="VST3 effect",
    group="fx",
    blurb="Run one of your installed VST3 effects (EQ, limiter, amp sim …) with settings you dialled in its own window.",
    run=run,
    requires=["pedalboard"],
    install="pip install pedalboard",
    check=_check,
    credits="pedalboard (GPLv3, Spotify) · your plugins",
    params=[
        Param("plugin", "Plugin", "vst", ""),
        Param("state", "Settings", "text", "", help="A saved state (made with 'Open plugin window'); empty = the plugin's defaults."),
        Param("mix", "Mix", "number", 1.0, min=0, max=1, step=0.05, help="Dry/wet blend."),
    ],
)
