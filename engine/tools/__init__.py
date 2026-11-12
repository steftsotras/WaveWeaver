"""
Built-in tools. One module per tool; each defines `TOOL = Tool(...)`.

To add one, copy the smallest existing module (vad.py), change the id,
params and run(). Import heavy libraries inside run() and list them in
`requires` so a missing install shows as "unavailable" instead of breaking
the engine.
"""
