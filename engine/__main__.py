"""
python -m engine            # 127.0.0.1:8765
python -m engine --port 9000
"""
import argparse
import sys

import uvicorn

from . import registry
from .config import HOST, MEDIA_ROOT, PORT


def main() -> None:
    ap = argparse.ArgumentParser(prog="engine", description="WaveWeaver tool engine")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    # Windows consoles default to cp1252; the status squares below aren't in it.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

    tools = registry.discover()
    ready = [t for t in tools.values() if t.status()[0]]
    print(f"WaveWeaver engine · media {MEDIA_ROOT}")
    for t in tools.values():
        ok, reason = t.status()
        print(f"  {'■' if ok else '□'} {t.id:<14} {t.label}{'' if ok else f'  — {reason}'}")
    print(f"{len(ready)}/{len(tools)} tools ready · http://{args.host}:{args.port}")
    uvicorn.run("engine.app:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
