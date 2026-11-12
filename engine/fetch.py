"""
The yt-dlp worker behind the studio's Downloads page.

The studio starts one of these per download (and per probe), the way it
starts ffmpeg, with the backend's venv python:

    python -m engine.fetch

The first line on stdin is the job, as JSON. After that stdin stays open as
a control channel: a line reading ``stop`` asks yt-dlp to wrap up — a live
recording is closed cleanly and kept — and end-of-file (the studio went
away) does the same, so a download never runs on unattended.

Everything the worker says is one JSON object per stdout line, prefixed with
``@ww `` so stray output from a library can't be mistaken for it:

    {"event": "progress", "status": "downloading", "downloaded": 1048576, ...}
    {"event": "postprocess", "name": "Merger", "status": "started"}
    {"event": "file", "role": "main", "path": "..."}
    {"event": "log", "level": "warning", "msg": "..."}
    {"event": "info", "info": {...}}              # probe / select
    {"event": "done"} | {"event": "stopped"} | {"event": "error", "msg": "..."}

Jobs (``cmd``):

    probe     extract a URL without downloading: a video with its formats,
              subtitles and chapters (and which formats ``format`` would
              pick), or a playlist/channel as a flat list of entries
    select    re-run format selection on an info dict from an earlier probe
              (offline — this is what --load-info-json does)
    download  download one URL into ``workdir``
    version   yt-dlp, yt-dlp-ejs and Python versions

The studio owns everything else — the queue, naming, which bin a file lands
in, persistence. This file only drives yt-dlp, through its Python API, the
way MeTube does: progress and postprocessor hooks give exact, structured
progress and the real paths of everything written.
"""
from __future__ import annotations

import _thread
import collections
import json
import os
import sys
import threading
import time

_out_lock = threading.Lock()
_stopping = threading.Event()


def emit(event: str, **data) -> None:
    # ensure_ascii: the Windows console encoding can't print every title.
    line = json.dumps({"event": event, **data}, ensure_ascii=True, default=str)
    with _out_lock:
        sys.stdout.write("@ww " + line + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


class Logger:
    """yt-dlp's logger: everything it would print comes through here.

    Keeps the last few distinct warnings so a failure can be explained with
    the context that led to it (MeTube does the same).
    """

    def __init__(self) -> None:
        self.warnings: collections.deque[str] = collections.deque(maxlen=5)
        self.errors: list[str] = []
        self.in_archive = False

    def debug(self, msg: str) -> None:
        if not msg:
            return
        if "has already been recorded in the archive" in msg:
            self.in_archive = True
        if msg.startswith("[debug] "):
            return
        emit("log", level="info", msg=msg)

    def info(self, msg: str) -> None:
        emit("log", level="info", msg=msg)

    def warning(self, msg: str) -> None:
        msg = (msg or "").strip()
        if msg and msg not in self.warnings:
            self.warnings.append(msg)
        emit("log", level="warning", msg=msg)

    def error(self, msg: str) -> None:
        msg = (msg or "").strip()
        if msg:
            self.errors.append(msg)
        emit("log", level="error", msg=msg)

    def explain(self, error_text: str) -> str:
        """Retained warnings, then the error itself, last so it stands out."""
        lines = list(self.warnings)
        error_text = (error_text or "").strip()
        if not error_text:
            return "\n".join(lines)

        def body(s: str) -> str:
            for prefix in ("ERROR: ", "WARNING: "):
                if s.startswith(prefix):
                    s = s[len(prefix):]
            return s.strip()

        if lines and body(lines[-1]) == body(error_text):
            lines.pop()
        lines.append(error_text)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Stopping
# ---------------------------------------------------------------------------

# Every process yt-dlp starts (ffmpeg for merging, live recording,
# postprocessing) goes through yt_dlp.utils.Popen. Tracking them lets "stop"
# ask a recording ffmpeg to finish its file — on Windows the main thread is
# stuck in a wait that a KeyboardInterrupt can't break until ffmpeg exits.
_children: list = []


def _track_children() -> None:
    from yt_dlp import utils

    original = utils.Popen.__init__

    def __init__(self, *args, **kwargs):
        original(self, *args, **kwargs)
        _children.append(self)

    utils.Popen.__init__ = __init__


def _control_loop() -> None:
    try:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
    except Exception:
        pass
    _stopping.set()
    _thread.interrupt_main()
    for proc in list(_children):
        try:
            if proc.poll() is None and proc.stdin:
                proc.stdin.write(b"q")
                proc.stdin.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Building yt-dlp options
# ---------------------------------------------------------------------------


def _js_runtimes() -> dict:
    """YouTube's player challenges need a JavaScript runtime. The studio runs
    on Node, so hand yt-dlp that one (deno stays enabled if installed)."""
    runtimes: dict = {"deno": {}}
    node = os.environ.get("WAVEWEAVER_NODE")
    if node and os.path.exists(node):
        runtimes["node"] = {"path": node}
    return runtimes


def build_params(job: dict, logger: Logger) -> dict:
    """The job's yt-dlp options, plus the few that need Python objects."""
    import yt_dlp

    params = dict(job.get("params") or {})
    params.setdefault("js_runtimes", _js_runtimes())
    params["logger"] = logger
    params["quiet"] = True
    params["no_warnings"] = False
    params["noprogress"] = True
    params["no_color"] = True

    if "impersonate" in params and isinstance(params["impersonate"], str):
        from yt_dlp.networking.impersonate import ImpersonateTarget

        params["impersonate"] = ImpersonateTarget.from_str(params["impersonate"])
    if isinstance(params.get("cookiesfrombrowser"), (list, str)):
        value = params["cookiesfrombrowser"]
        parts = [value] if isinstance(value, str) else list(value)
        params["cookiesfrombrowser"] = tuple((parts + [None, None, None])[:4])
    if isinstance(params.get("compat_opts"), list):
        params["compat_opts"] = set(params["compat_opts"])

    clip = job.get("clip")
    if clip:
        start = float(clip[0] or 0)
        end = float(clip[1]) if clip[1] is not None else float("inf")
        params["download_ranges"] = yt_dlp.utils.download_range_func(None, [(start, end)])
    return params


def _is_within(root: str, target: str) -> bool:
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        return False


def confined_ydl(params: dict, root: str | None):
    """A YoutubeDL that refuses to write outside ``root``.

    Output templates expand site-controlled metadata (titles, chapter names),
    so the resolved path — not the template — is what gets checked. Every
    output path goes through prepare_filename.
    """
    import yt_dlp

    real_root = os.path.realpath(root) if root else None

    class Confined(yt_dlp.YoutubeDL):
        def prepare_filename(self, *args, **kwargs):
            filename = super().prepare_filename(*args, **kwargs)
            if real_root and filename and filename != "-":
                if not _is_within(real_root, os.path.realpath(filename)):
                    raise yt_dlp.utils.DownloadError(f"Refusing to write outside the download folder: {filename}")
            return filename

    return Confined(params)


# ---------------------------------------------------------------------------
# Summaries — what the studio needs from an info dict, and nothing bulky
# ---------------------------------------------------------------------------


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _str(v):
    return v if isinstance(v, str) and v else None


def _thumb(info: dict):
    thumbs = info.get("thumbnails")
    if isinstance(thumbs, list) and thumbs:
        # Prefer something around 480 px wide: big enough for a card, not a 4K jpeg.
        sized = [t for t in thumbs if isinstance(t, dict) and t.get("url") and _num(t.get("width"))]
        if sized:
            return min(sized, key=lambda t: abs(t["width"] - 480))["url"]
        for t in reversed(thumbs):
            if isinstance(t, dict) and t.get("url"):
                return t["url"]
    return _str(info.get("thumbnail"))


def summarize_format(f: dict) -> dict:
    size = _num(f.get("filesize"))
    approx = _num(f.get("filesize_approx"))
    return {
        "id": f.get("format_id"),
        "ext": f.get("ext"),
        "width": _num(f.get("width")),
        "height": _num(f.get("height")),
        "fps": _num(f.get("fps")),
        "vcodec": _str(f.get("vcodec")),
        "acodec": _str(f.get("acodec")),
        "abr": _num(f.get("abr")),
        "vbr": _num(f.get("vbr")),
        "tbr": _num(f.get("tbr")),
        "asr": _num(f.get("asr")),
        "channels": _num(f.get("audio_channels")),
        "size": size or approx,
        "approx": size is None and approx is not None,
        "note": _str(f.get("format_note")),
        "protocol": _str(f.get("protocol")),
        "hdr": _str(f.get("dynamic_range")),
        "language": _str(f.get("language")),
    }


def summarize_selection(info: dict):
    """Which formats yt-dlp settled on, after a processed extraction."""
    requested = info.get("requested_formats")
    if not info.get("format_id"):
        return None
    parts = requested if isinstance(requested, list) and requested else [info]
    sizes = [_num(p.get("filesize")) or _num(p.get("filesize_approx")) for p in parts]
    return {
        "ids": [p.get("format_id") for p in parts],
        "ext": info.get("ext"),
        "width": _num(info.get("width")),
        "height": _num(info.get("height")),
        "fps": _num(info.get("fps")),
        "vcodec": _str(info.get("vcodec")),
        "acodec": _str(info.get("acodec")),
        "size": sum(sizes) if sizes and all(s is not None for s in sizes) else None,
        "approx": any(not p.get("filesize") for p in parts),
        "subtitles": sorted((info.get("requested_subtitles") or {}).keys()),
    }


def _sub_langs(subs) -> dict:
    out = {}
    if isinstance(subs, dict):
        for lang, tracks in subs.items():
            if not isinstance(tracks, list):
                continue
            exts = [t.get("ext") for t in tracks if isinstance(t, dict) and t.get("ext")]
            name = next((t.get("name") for t in tracks if isinstance(t, dict) and t.get("name")), None)
            out[lang] = {"exts": exts, "name": name}
    return out


def summarize_entry(e: dict) -> dict:
    url = e.get("webpage_url") or e.get("url")
    return {
        "id": _str(e.get("id")) or (str(e["id"]) if e.get("id") is not None else None),
        "url": url,
        "title": _str(e.get("title")) or url,
        "duration": _num(e.get("duration")),
        "thumbnail": _thumb(e),
        "uploader": _str(e.get("uploader")) or _str(e.get("channel")),
        "live_status": _str(e.get("live_status")),
        "availability": _str(e.get("availability")),
        "release_timestamp": _num(e.get("release_timestamp")),
        "timestamp": _num(e.get("timestamp")),
        "view_count": _num(e.get("view_count")),
        "ie_key": _str(e.get("ie_key")),
        "type": _str(e.get("_type")) or "video",
    }


def summarize(info: dict) -> dict:
    etype = info.get("_type") or "video"
    base = {
        "type": etype,
        "id": _str(info.get("id")),
        "title": _str(info.get("title")) or _str(info.get("fulltitle")),
        "url": _str(info.get("webpage_url")) or _str(info.get("url")) or _str(info.get("original_url")),
        "extractor": _str(info.get("extractor_key")) or _str(info.get("ie_key")) or _str(info.get("extractor")),
        "uploader": _str(info.get("uploader")) or _str(info.get("channel")),
        "uploader_url": _str(info.get("uploader_url")) or _str(info.get("channel_url")),
        "channel": _str(info.get("channel")),
        "channel_id": _str(info.get("channel_id")),
        "uploader_id": _str(info.get("uploader_id")),
        "duration": _num(info.get("duration")),
        "upload_date": _str(info.get("upload_date")),
        "timestamp": _num(info.get("timestamp")),
        "thumbnail": _thumb(info),
        "live_status": _str(info.get("live_status")),
        "release_timestamp": _num(info.get("release_timestamp")),
        "availability": _str(info.get("availability")),
        "view_count": _num(info.get("view_count")),
        "description": (_str(info.get("description")) or "")[:2000] or None,
    }
    if etype in ("playlist", "multi_video"):
        entries = [e for e in (info.get("entries") or []) if isinstance(e, dict)]
        base["entries"] = [summarize_entry(e) for e in entries]
        base["playlist_count"] = _num(info.get("playlist_count")) or len(entries)
        return base
    if etype in ("url", "url_transparent"):
        return base
    formats = [f for f in (info.get("formats") or []) if isinstance(f, dict)]
    base["formats"] = [
        summarize_format(f)
        for f in formats
        if f.get("format_note") != "storyboard" and not (f.get("vcodec") == "none" and f.get("acodec") == "none" and f.get("ext") == "mhtml")
    ]
    base["chapters"] = [
        {"start": _num(c.get("start_time")), "end": _num(c.get("end_time")), "title": _str(c.get("title"))}
        for c in (info.get("chapters") or [])
        if isinstance(c, dict)
    ]
    base["subtitles"] = _sub_langs(info.get("subtitles"))
    base["auto_captions"] = _sub_langs(info.get("automatic_captions"))
    base["selected"] = summarize_selection(info)
    return base


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_probe(job: dict) -> None:
    import yt_dlp

    logger = Logger()
    params = build_params(job, logger)
    # A probe classifies; it never writes. allow_playlist_files: yt-dlp writes
    # playlist-level infojson/thumbnail files regardless of download=False.
    params.update({"skip_download": True, "simulate": True, "allow_playlist_files": False, "ignore_no_formats_error": True})
    params.setdefault("extract_flat", "in_playlist")
    params.setdefault("noplaylist", True)
    if job.get("playlist_end"):
        params["playlistend"] = int(job["playlist_end"])
    process = bool(job.get("process", True))
    try:
        with yt_dlp.YoutubeDL(params) as ydl:
            info = ydl.extract_info(job["url"], download=False, process=process)
            if info is None:
                if logger.in_archive:
                    msg = "Already recorded in the download archive, so yt-dlp skipped it."
                else:
                    msg = logger.errors[-1] if logger.errors else "yt-dlp returned nothing for this URL."
                emit("error", msg=msg)
                return
            info = ydl.sanitize_info(info)
        # The raw dict lets a later "select" re-run format selection offline;
        # only a single video has formats to select from.
        keep_raw = job.get("raw") and (info.get("_type") or "video") == "video"
        emit("info", info=summarize(info), raw=info if keep_raw else None)
    except yt_dlp.utils.YoutubeDLError as exc:
        emit("error", msg=logger.explain(str(exc)))


def cmd_select(job: dict) -> None:
    import yt_dlp

    logger = Logger()
    params = build_params(job, logger)
    params.update({"skip_download": True, "simulate": True, "ignore_no_formats_error": True})
    info = job["info"]
    try:
        with yt_dlp.YoutubeDL(params) as ydl:
            processed = ydl.process_ie_result(info, download=False)
        emit("info", info={"selected": summarize_selection(processed or {})})
    except yt_dlp.utils.YoutubeDLError as exc:
        emit("error", msg=logger.explain(str(exc)))


class _Progress:
    """yt-dlp calls progress hooks many times a second; forward two a second."""

    def __init__(self) -> None:
        self.last = 0.0

    def hook(self, d: dict) -> None:
        status = d.get("status")
        now = time.monotonic()
        if status == "downloading" and now - self.last < 0.5:
            return
        self.last = now
        info = d.get("info_dict") or {}
        # A merged download fetches video and audio one after the other, and
        # info_dict is the format being fetched — say which.
        vcodec, acodec = info.get("vcodec"), info.get("acodec")
        if os.path.splitext(d.get("filename") or "")[1].lower() in SUBTITLE_EXTS:
            kind = "captions"
        elif vcodec and vcodec != "none" and (not acodec or acodec == "none"):
            kind = "video"
        elif vcodec == "none" and acodec and acodec != "none":
            kind = "audio"
        else:
            kind = "media"
        emit(
            "progress",
            status=status,
            downloaded=_num(d.get("downloaded_bytes")),
            total=_num(d.get("total_bytes")) or _num(d.get("total_bytes_estimate")),
            speed=_num(d.get("speed")),
            eta=_num(d.get("eta")),
            elapsed=_num(d.get("elapsed")),
            fragment=[_num(d.get("fragment_index")), _num(d.get("fragment_count"))] if d.get("fragment_count") else None,
            filename=os.path.basename(d.get("filename") or "") or None,
            format=_str(info.get("format_id")),
            kind=kind,
            live=info.get("is_live") is True,
        )


SUBTITLE_EXTS = {".vtt", ".srt", ".json3", ".srv1", ".srv2", ".srv3", ".ttml", ".sbv", ".scc", ".dfxp", ".ass", ".lrc"}


def _postprocess_hook(d: dict, report_main: bool = True) -> None:
    name = d.get("postprocessor")
    status = d.get("status")
    info = d.get("info_dict") or {}
    emit("postprocess", name=name, status=status)
    if status != "finished":
        return
    if name == "MoveFiles":
        path = info.get("filepath")
        if path and report_main:
            final = info.get("__finaldir")
            emit("file", role="main", path=os.path.join(final, os.path.basename(path)) if final else path)
        for sub in (info.get("requested_subtitles") or {}).values():
            if isinstance(sub, dict) and sub.get("filepath"):
                emit("file", role="subtitle", path=sub["filepath"])
    elif name == "SplitChapters":
        for chapter in info.get("chapters") or []:
            if isinstance(chapter, dict) and chapter.get("filepath"):
                emit("file", role="chapter", path=chapter["filepath"])


def cmd_download(job: dict) -> None:
    import yt_dlp

    workdir = job["workdir"]
    os.makedirs(workdir, exist_ok=True)
    logger = Logger()
    params = build_params(job, logger)
    params["paths"] = {"home": workdir, "temp": workdir}
    params.setdefault("outtmpl", {"default": "%(title)s.%(ext)s"})
    params["progress_hooks"] = [_Progress().hook]
    params["postprocessor_hooks"] = [_postprocess_hook]
    params.setdefault("socket_timeout", 30)
    params.setdefault("ignore_no_formats_error", True)
    params.setdefault("retries", 10)
    params.setdefault("fragment_retries", 10)

    passes = [params]
    if job.get("clip") and (params.get("writesubtitles") or params.get("writeautomaticsub")):
        # yt-dlp fetches captions before the media, and after that YouTube
        # answers the ranged request ffmpeg makes for a clip with 400 — which
        # ffmpeg shrugs off, leaving an empty file. Fetch them afterwards, in
        # a pass of their own.
        captions = {k: params.pop(k) for k in ("writesubtitles", "writeautomaticsub", "subtitleslangs", "subtitlesformat") if k in params}
        later = {k: v for k, v in params.items() if k not in ("download_ranges", "postprocessors", "writethumbnail")}
        later.update(captions, skip_download=True, postprocessor_hooks=[lambda d: _postprocess_hook(d, report_main=False)])
        passes.append(later)

    _track_children()
    try:
        code = 0
        for p in passes:
            with confined_ydl(p, workdir) as ydl:
                code = ydl.download([job["url"]])
            if code != 0 or _stopping.is_set():
                break
        if _stopping.is_set():
            emit("stopped")
        elif code == 0:
            emit("done")
        else:
            emit("error", msg="\n".join(logger.warnings) or logger.explain(logger.errors[-1] if logger.errors else f"yt-dlp exited {code}"))
    except KeyboardInterrupt:
        emit("stopped")
    except yt_dlp.utils.YoutubeDLError as exc:
        if _stopping.is_set():
            emit("stopped")
        else:
            emit("error", msg=logger.explain(str(exc)))


def cmd_version(_job: dict) -> None:
    import platform
    from importlib import metadata

    import yt_dlp.version

    def dist(name: str):
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            return None

    emit(
        "info",
        info={
            "ytdlp": yt_dlp.version.__version__,
            "channel": getattr(yt_dlp.version, "CHANNEL", None),
            "ejs": dist("yt-dlp-ejs"),
            "python": platform.python_version(),
            "node": os.environ.get("WAVEWEAVER_NODE"),
        },
    )


COMMANDS = {"probe": cmd_probe, "select": cmd_select, "download": cmd_download, "version": cmd_version}


def main() -> int:
    line = sys.stdin.readline()
    try:
        job = json.loads(line)
        command = COMMANDS[job["cmd"]]
    except (ValueError, KeyError) as exc:
        emit("error", msg=f"Bad job: {exc}")
        return 2
    # Probes are short and simply killed; only a download listens for "stop".
    if job["cmd"] == "download":
        threading.Thread(target=_control_loop, daemon=True).start()
    try:
        command(job)
    except KeyboardInterrupt:
        emit("stopped")
    except ImportError as exc:
        emit("error", msg=f"yt-dlp isn't installed in this Python ({sys.executable}): {exc}")
        return 1
    except Exception as exc:  # an extractor bug escapes unwrapped; report, don't crash silently
        import traceback

        emit("log", level="error", msg=traceback.format_exc())
        emit("error", msg=f"Unexpected yt-dlp error: {type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
