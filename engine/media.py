"""
Audio in and out of numpy, via ffmpeg pipes.

Tools never touch codecs. They ask for float32 blocks of shape
(channels, frames) at 48 kHz, and hand back blocks of the same shape. ffmpeg
does all decoding (any format, any container, video files included) and all
encoding. Streaming keeps memory flat: a three-hour recording is processed
in ten-second blocks, never loaded whole.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Callable

import numpy as np

from .config import SAMPLE_RATE

if TYPE_CHECKING:
    from .context import Context

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


@dataclass
class Info:
    duration: float | None
    has_video: bool
    has_audio: bool
    channels: int
    container: str
    video_codec: str | None


def probe(path: Path) -> Info:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_NO_WINDOW,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = data.get("format", {}).get("duration")
    return Info(
        duration=float(dur) if dur not in (None, "N/A") else None,
        has_video=video is not None,
        has_audio=audio is not None,
        channels=int(audio.get("channels", 2)) if audio else 0,
        container=data.get("format", {}).get("format_name", ""),
        video_codec=video.get("codec_name") if video else None,
    )


def _seek_args(excerpt: tuple[float, float] | None) -> list[str]:
    if not excerpt:
        return []
    start, dur = excerpt
    return ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}"]


class Decoder:
    """ffmpeg → float32 PCM blocks. Use as a context manager."""

    def __init__(
        self,
        ctx: "Context",
        path: Path,
        *,
        sr: int = SAMPLE_RATE,
        channels: int = 2,
        excerpt: tuple[float, float] | None = None,
    ):
        self.sr = sr
        self.channels = channels
        self.proc = ctx.spawn(
            [
                "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
                *_seek_args(excerpt), "-i", str(path),
                "-vn", "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-",
            ],
            stdout=subprocess.PIPE,
        )

    def read(self, frames: int) -> np.ndarray | None:
        want = frames * self.channels * 4
        buf = bytearray()
        while len(buf) < want:
            chunk = self.proc.stdout.read(want - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        if not buf:
            return None
        usable = len(buf) - len(buf) % (self.channels * 4)
        arr = np.frombuffer(bytes(buf[:usable]), dtype=np.float32)
        return arr.reshape(-1, self.channels).T.copy()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.proc.kill()
        self.proc.wait()


AUDIO_CODECS: dict[str, list[str]] = {
    # 24-bit WAV/FLAC: processed audio deserves the headroom.
    "wav": ["-c:a", "pcm_s24le"],
    "flac": ["-c:a", "flac", "-sample_fmt", "s32"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "0"],
    "m4a": ["-c:a", "aac", "-b:a", "256k"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
    "opus": ["-c:a", "libopus", "-b:a", "160k"],
}

VIDEO_CONTAINERS = {"mp4", "mov", "m4v", "mkv", "webm"}


class Encoder:
    """
    float32 PCM blocks → ffmpeg → file. With `video_from`, the original
    picture is stream-copied alongside the new audio, so cleaning the sound
    of a 4K video never re-encodes a single frame.
    """

    def __init__(
        self,
        ctx: "Context",
        out_path: Path,
        *,
        sr: int = SAMPLE_RATE,
        channels: int = 2,
        video_from: Path | None = None,
    ):
        self.channels = channels
        ext = out_path.suffix.lower().lstrip(".")
        args = [
            "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-f", "f32le", "-ar", str(sr), "-ac", str(channels), "-i", "-",
        ]
        if video_from is not None and ext in VIDEO_CONTAINERS:
            audio = ["-c:a", "libopus", "-b:a", "160k"] if ext == "webm" else ["-c:a", "aac", "-b:a", "256k"]
            args += ["-i", str(video_from), "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy", *audio, "-shortest"]
            if ext in {"mp4", "mov", "m4v"}:
                args += ["-movflags", "+faststart"]
        else:
            args += AUDIO_CODECS.get(ext, AUDIO_CODECS["wav"])
        self.proc = ctx.spawn([*args, str(out_path)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, block: np.ndarray) -> None:
        data = np.ascontiguousarray(np.clip(block, -1.0, 1.0).T, dtype=np.float32)
        self.proc.stdin.write(data.tobytes())

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *exc):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        if exc_type is None:
            if self.proc.wait() != 0:
                err = self.proc.stderr.read().decode("utf-8", "replace") if self.proc.stderr else ""
                raise RuntimeError(f"ffmpeg encode failed: {err[-400:]}")
        else:
            self.proc.kill()
            self.proc.wait()


def decode_all(ctx: "Context", path: Path, *, sr: int = SAMPLE_RATE, channels: int = 2,
               excerpt: tuple[float, float] | None = None) -> np.ndarray:
    """Whole file in memory. Only for tools that genuinely need it (Whisper, references)."""
    blocks = []
    with Decoder(ctx, path, sr=sr, channels=channels, excerpt=excerpt) as dec:
        while (b := dec.read(sr * 30)) is not None:
            ctx.check()
            blocks.append(b)
    return np.concatenate(blocks, axis=1) if blocks else np.zeros((channels, 0), dtype=np.float32)


def stream(
    ctx: "Context",
    fn: Callable[[np.ndarray], np.ndarray],
    *,
    out_path: Path,
    block_seconds: float = 10.0,
    context_seconds: float = 0.0,
    video_from: Path | None = None,
    flush: Callable[[], np.ndarray | None] | None = None,
) -> None:
    """
    Run `fn` over the input in blocks and encode the result.

    Stateful processors (pedalboard plugins called with reset=False) need no
    context. Stateless ones that look at a window of audio — spectral noise
    reduction — would click at every block boundary, so they get
    `context_seconds` of real audio on both sides of each block and only the
    middle is kept. That costs a little extra compute and removes the seams.
    """
    sr = SAMPLE_RATE
    block = int(sr * block_seconds)
    pad = int(sr * context_seconds)
    total = (ctx.excerpt[1] if ctx.excerpt else ctx.info.duration or 0) * sr

    with Decoder(ctx, ctx.input, excerpt=ctx.excerpt) as dec, Encoder(ctx, out_path, video_from=video_from) as enc:
        if pad == 0:
            done = 0
            while (b := dec.read(block)) is not None:
                ctx.check()
                enc.write(fn(b))
                done += b.shape[1]
                if total:
                    ctx.progress(done / total)
            # Processors with latency hold the last few ms back; drain them.
            if flush and (tail := flush()) is not None and tail.shape[1]:
                enc.write(tail)
            return

        prev_tail = np.zeros((2, 0), dtype=np.float32)
        cur = dec.read(block)
        done = 0
        while cur is not None:
            ctx.check()
            nxt = dec.read(block)
            right = nxt[:, :pad] if nxt is not None else np.zeros((2, 0), dtype=np.float32)
            window = np.concatenate([prev_tail, cur, right], axis=1)
            out = fn(window)
            left = prev_tail.shape[1]
            enc.write(out[:, left : left + cur.shape[1]])
            prev_tail = cur[:, -pad:]
            done += cur.shape[1]
            if total:
                ctx.progress(done / total)
            cur = nxt


def measure_loudness(ctx: "Context", path: Path) -> dict:
    """Integrated loudness, LRA and true peak via ffmpeg's EBU R128 meter."""
    proc = ctx.spawn(
        ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", str(path), "-vn",
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        stderr=subprocess.PIPE,
    )
    _, err = proc.communicate()
    text = err.decode("utf-8", "replace")
    summary = text[text.rfind("Summary:"):]

    def grab(label: str) -> float | None:
        for line in summary.splitlines():
            line = line.strip()
            if line.startswith(label):
                try:
                    return float(line.split(":")[1].split()[0])
                except (ValueError, IndexError):
                    return None
        return None

    return {"lufs": grab("I:"), "lra": grab("LRA:"), "truePeak": grab("Peak:")}
