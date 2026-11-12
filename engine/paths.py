"""
Client-supplied references → absolute paths, refusing anything that escapes
the media root. Mirrors the studio's rules (src/lib/server/paths.ts).
"""
from __future__ import annotations

import re
from pathlib import Path

from .config import CACHE_DIR, MEDIA_ROOT, PREVIEW_DIR

KINDS = {"sources", "renders"}
_BIN = re.compile(r"^[\w][\w .-]{0,62}[\w-]$|^\w$", re.UNICODE)
_PREVIEW_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_FORMAT = re.compile(r"^[A-Za-z0-9]{1,8}$")


class BadRef(ValueError):
    pass


def _inside(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return target.resolve() != root.resolve()
    except ValueError:
        return False


def resolve_ref(ref: dict) -> Path:
    """
    `{bin, kind, name}` for media in a bin, or `{kind: 'cache', name}` for a
    scratch file under media/.cache (the studio hands us pre-rendered audio
    that way, e.g. for analysis of a weave prefix).
    """
    kind = ref.get("kind")
    name = str(ref.get("name") or "")
    if not name or "\0" in name:
        raise BadRef("missing file name")
    if kind == "cache":
        path = (CACHE_DIR / name).resolve()
        if not _inside(CACHE_DIR, path):
            raise BadRef("path escapes cache")
        return path
    if kind not in KINDS:
        raise BadRef(f"unknown kind: {kind}")
    bin_name = str(ref.get("bin") or "")
    if not _BIN.match(bin_name):
        raise BadRef(f"invalid bin: {bin_name}")
    if "/" in name or "\\" in name or name.startswith("."):
        raise BadRef(f"invalid file name: {name}")
    root = MEDIA_ROOT / bin_name / kind
    path = (root / name).resolve()
    if not _inside(root, path):
        raise BadRef("path escapes bin")
    return path


def preview_dir(preview_id: str) -> Path:
    if not _PREVIEW_ID.match(preview_id):
        raise BadRef("invalid preview id")
    d = PREVIEW_DIR / preview_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def check_format(fmt: str) -> str:
    """It becomes the output file's extension, so it can't be allowed to hold a path."""
    if not _FORMAT.match(fmt):
        raise BadRef(f"invalid format: {fmt}")
    return fmt


def renders_dir_for(ref: dict) -> Path:
    if ref.get("kind") == "cache":
        raise BadRef("cache inputs can only be previewed")
    bin_name = str(ref.get("bin") or "")
    if not _BIN.match(bin_name):
        raise BadRef(f"invalid bin: {bin_name}")
    d = MEDIA_ROOT / bin_name / "renders"
    d.mkdir(parents=True, exist_ok=True)
    return d
