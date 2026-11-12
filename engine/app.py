"""
HTTP surface. The studio is the only client: it lists tools, starts jobs,
polls them and cancels them. Everything binds to 127.0.0.1 by default —
this is a local tool host, not a public API.
"""
from __future__ import annotations

import hmac
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, gpu, jobs, registry
from .config import HOST, MEDIA_ROOT, MODELS_DIR, TOKEN
from .context import Context
from .media import probe
from .paths import BadRef, check_format, preview_dir, renders_dir_for, resolve_ref

app = FastAPI(title="WaveWeaver Engine", version=__version__)
registry.discover()

_HOSTS = {"127.0.0.1", "localhost", "[::1]", HOST}
_ANY_ADDRESS = HOST in ("0.0.0.0", "::")


@app.middleware("http")
async def only_the_studio(request: Request, call_next):
    """
    Binding to 127.0.0.1 keeps other machines out, not web pages: the user's
    browser is on this machine. A page's requests carry an Origin (the studio
    server's don't), and a rebound domain shows in Host. The token, set by the
    studio that starts us, also shuts out everything else running locally.
    """
    host = request.headers.get("host", "").rsplit(":", 1)[0]
    token = request.headers.get("x-waveweaver-token", "")
    if "origin" in request.headers or not (_ANY_ADDRESS or host in _HOSTS):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    if TOKEN and not hmac.compare_digest(token.encode(), TOKEN.encode()):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


class JobRequest(BaseModel):
    tool: str
    input: dict | None = None
    params: dict = Field(default_factory=dict)
    payload: Any = None
    # {start, duration} in seconds on the source timeline. Present = preview run.
    excerpt: dict | None = None
    # {"mode": "render", "format": "same" | ext} | {"mode": "preview", "dir": id} | {"mode": "data"}
    output: dict = Field(default_factory=lambda: {"mode": "render", "format": "same"})


def _describe_output(path: Path) -> dict:
    rel = path.resolve().relative_to(MEDIA_ROOT)
    parts = rel.parts
    ref = {"bin": parts[0], "kind": parts[1], "name": parts[2]} if len(parts) == 3 else {"kind": "cache", "name": "/".join(parts[1:])}
    return {"path": str(path), "ref": ref, "sizeBytes": path.stat().st_size}


@app.get("/health")
def health() -> dict:
    tools = registry.all_tools()
    dev = gpu.current()
    return {
        "ok": True,
        "version": __version__,
        "mediaRoot": str(MEDIA_ROOT),
        "modelsDir": str(MODELS_DIR),
        "device": dev[0] if dev else "unprobed",
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "tools": len(tools),
        "ready": sum(1 for t in tools if t.status()[0]),
    }


@app.get("/tools")
def list_tools() -> dict:
    return {"tools": [t.describe() for t in registry.all_tools()]}


@app.post("/tools/rescan")
def rescan() -> dict:
    """Pick up a newly installed library or a new plugin file without a restart."""
    registry.discover()
    return list_tools()


@app.post("/jobs")
def create_job(req: JobRequest) -> dict:
    tool = registry.get(req.tool)
    if not tool:
        raise HTTPException(404, f"Unknown tool: {req.tool}")
    ok, reason = tool.status()
    if not ok:
        raise HTTPException(409, reason)
    params = tool.clean_params(req.params)

    path = info = None
    stem = "captions"
    if tool.inputs == "audio":
        if not req.input:
            raise HTTPException(400, "This tool needs an input file")
        try:
            path = resolve_ref(req.input)
        except BadRef as e:
            raise HTTPException(400, str(e))
        if not path.is_file():
            raise HTTPException(404, f"Not found: {req.input.get('name')}")
        info = probe(path)
        if not info.has_audio:
            raise HTTPException(400, f"{path.name} has no audio track")
        stem = path.stem

    excerpt = None
    if req.excerpt:
        if not tool.previewable:
            raise HTTPException(400, f"{tool.label} can't run on an excerpt")
        start = max(0.0, float(req.excerpt.get("start", 0)))
        dur = min(600.0, max(0.5, float(req.excerpt.get("duration", 20))))
        excerpt = (start, dur)

    mode = req.output.get("mode", "render")
    out_dir: Path | None = None
    try:
        if tool.output == "data":
            mode = "data"
        elif mode == "preview":
            out_dir = preview_dir(str(req.output.get("dir", "")))
        else:
            mode = "render"
            out_dir = renders_dir_for(req.input or {})
        out_format = check_format(str(req.output.get("format", "same")))
    except BadRef as e:
        raise HTTPException(400, str(e))

    def work(job: jobs.Job) -> dict:
        ctx = Context(
            job,
            params=params,
            input=path,
            info=info,
            excerpt=excerpt,
            out_dir=out_dir,
            out_mode=mode,
            out_format=out_format,
            stem=stem,
            payload=req.payload,
        )
        job.on_cancel = ctx.kill_children
        if excerpt:
            ctx.log(f"Excerpt: {excerpt[0]:.1f}s + {excerpt[1]:.1f}s")
        result = tool.run(ctx) or {}
        result["outputs"] = [_describe_output(Path(p)) for p in result.get("outputs", [])]
        return result

    where = f" · {path.name}" if path else ""
    job = jobs.submit(tool.id, f"{tool.label}{where}{' · preview' if excerpt else ''}", work)
    return {"id": job.id}


@app.get("/jobs")
def list_jobs() -> dict:
    return {"jobs": [{**j.view(), "logs": []} for j in jobs.all_jobs()]}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, since: int = 0) -> dict:
    """`since` = number of log lines the caller already has; only newer ones are sent."""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    v = job.view()
    v["logOffset"] = since
    v["logs"] = job.logs[since:]
    v["logTotal"] = len(job.logs)
    return v


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str) -> dict:
    if not jobs.cancel(job_id):
        raise HTTPException(404, "Job not found or already finished")
    return {"ok": True}


# --- VST3 hosting extras --------------------------------------------------

@app.get("/vst/plugins")
def vst_plugins() -> dict:
    from .tools.vst import scan_plugins

    return {"plugins": [{"path": p, "name": n} for p, n in scan_plugins()]}


class EditorRequest(BaseModel):
    plugin: str
    state: str | None = None
    save_as: str


@app.post("/vst/editor")
def vst_editor(req: EditorRequest) -> dict:
    """
    Open the plugin's own window on this machine. Blocks until you close it,
    then saves its settings as a named state the vst tool can render with.
    """
    from .tools.vst import open_editor

    try:
        return open_editor(req.plugin, req.state, req.save_as)
    except ValueError as e:
        raise HTTPException(400, str(e))
