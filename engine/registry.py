"""
The plugin registry.

A tool is a plain Python module that defines `TOOL = Tool(...)` (or a list,
`TOOLS = [...]`). Drop one into engine/tools/ — or into the folder named by
WAVEWEAVER_PLUGINS — restart, and the studio shows it with a generated form.

Tools import their heavy libraries *inside* run(), never at module level.
That keeps engine start-up instant and lets the registry report a tool whose
library isn't installed as "unavailable — pip install x" instead of the
whole engine failing to boot.
"""
from __future__ import annotations

import importlib
import importlib.util
import pkgutil
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Literal

from .config import PLUGINS_DIR

if TYPE_CHECKING:
    from .context import Context

ParamKind = Literal["number", "bool", "select", "text", "media", "region", "vst"]


@dataclass
class Param:
    """
    One form field. `kind` drives the studio's widget:
      number  slider (min/max/step/unit)
      bool    checkbox
      select  segmented buttons or a dropdown (options: [(value, label)])
      text    free text
      media   pick a file from the library (e.g. a mastering reference)
      region  a [start, end] span — the studio binds it to the waveform selection
      vst     a VST3 plugin picker
    """

    key: str
    label: str
    kind: ParamKind
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str = ""
    options: list[tuple[str, str]] | None = None
    help: str = ""

    def clean(self, raw: Any) -> Any:
        if raw is None:
            return self.default
        if self.kind == "number":
            try:
                v = float(raw)
            except (TypeError, ValueError):
                return self.default
            if self.min is not None:
                v = max(self.min, v)
            if self.max is not None:
                v = min(self.max, v)
            return v
        if self.kind == "bool":
            return bool(raw)
        if self.kind == "select":
            allowed = {o[0] for o in self.options or []}
            return raw if raw in allowed else self.default
        if self.kind == "region":
            try:
                a, b = float(raw[0]), float(raw[1])
                return [min(a, b), max(a, b)] if b != a else None
            except (TypeError, ValueError, IndexError):
                return None
        if self.kind == "text":
            return str(raw)[:2000]
        return raw

    def describe(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if v is not None and v != ""}
        if self.options is not None:
            d["options"] = [{"value": v, "label": label} for v, label in self.options]
        return d


@dataclass
class Tool:
    id: str
    label: str
    group: str
    blurb: str
    run: Callable[["Context"], dict]
    params: list[Param] = field(default_factory=list)
    # audio: needs an audio stream (video files fine — their audio is used)
    # captions: works on caption cues passed as payload, no media
    inputs: Literal["audio", "captions"] = "audio"
    # audio: writes a processed file; data: returns JSON (transcripts, spans)
    output: Literal["audio", "data"] = "audio"
    requires: list[str] = field(default_factory=list)
    install: str = ""
    previewable: bool = True
    presets: dict[str, dict] = field(default_factory=dict)
    # Optional extra readiness check (model downloaded, API key set …).
    # Returns a reason string when not ready.
    check: Callable[[], str | None] | None = None
    credits: str = ""
    # Filled in by the registry when the module itself failed to import.
    broken: str | None = None

    def missing(self) -> list[str]:
        return [m for m in self.requires if importlib.util.find_spec(m) is None]

    def status(self) -> tuple[bool, str | None]:
        if self.broken:
            return False, self.broken
        missing = self.missing()
        if missing:
            return False, f"Missing {', '.join(missing)}. Install: {self.install or 'pip install ' + ' '.join(missing)}"
        if self.check:
            try:
                reason = self.check()
            except Exception as e:  # a check must never take the registry down
                reason = str(e)
            if reason:
                return False, reason
        return True, None

    def clean_params(self, raw: dict | None) -> dict:
        raw = raw or {}
        return {p.key: p.clean(raw.get(p.key)) for p in self.params}

    def describe(self) -> dict:
        ok, reason = self.status()
        return {
            "id": self.id,
            "label": self.label,
            "group": self.group,
            "blurb": self.blurb,
            "inputs": self.inputs,
            "output": self.output,
            "params": [p.describe() for p in self.params],
            "previewable": self.previewable,
            "presets": self.presets,
            "available": ok,
            "reason": reason,
            "install": self.install,
            "credits": self.credits,
        }


_tools: dict[str, Tool] = {}


def _collect(module, origin: str) -> None:
    found = list(getattr(module, "TOOLS", []))
    if hasattr(module, "TOOL"):
        found.append(module.TOOL)
    for t in found:
        if t.id in _tools:
            print(f"[engine] duplicate tool id {t.id!r} in {origin}; keeping the first", file=sys.stderr)
            continue
        _tools[t.id] = t


def _broken(name: str, err: BaseException) -> None:
    tb = "".join(traceback.format_exception_only(type(err), err)).strip()
    _tools[name] = Tool(
        id=name,
        label=name,
        group="broken",
        blurb="This plugin failed to load.",
        run=lambda ctx: {},
        broken=f"Import failed: {tb}",
    )


def discover() -> dict[str, Tool]:
    """Import every built-in tool module, then every .py in the plugins folder."""
    _tools.clear()
    from . import tools as builtin

    for info in pkgutil.iter_modules(builtin.__path__):
        if info.name.startswith("_"):
            continue
        try:
            _collect(importlib.import_module(f"{builtin.__name__}.{info.name}"), info.name)
        except Exception as e:
            _broken(info.name, e)

    if PLUGINS_DIR.is_dir():
        for file in sorted(Path(PLUGINS_DIR).glob("*.py")):
            name = f"wwplugin_{file.stem}"
            try:
                spec = importlib.util.spec_from_file_location(name, file)
                assert spec and spec.loader
                module = importlib.util.module_from_spec(spec)
                sys.modules[name] = module
                spec.loader.exec_module(module)
                _collect(module, str(file))
            except Exception as e:
                _broken(file.stem, e)
    return _tools


def get(tool_id: str) -> Tool | None:
    return _tools.get(tool_id)


def all_tools() -> list[Tool]:
    return list(_tools.values())
